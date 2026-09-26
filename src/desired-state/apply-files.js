import path from 'node:path';
import {createHash} from 'node:crypto';
import {lstat,readFile,mkdir,mkdtemp,writeFile,unlink,rmdir} from 'node:fs/promises';
import {compileDesiredManifest} from '../contracts/desired-state.js';
import {fail} from '../contracts/parse.js';
import {inspectDirectory,pathBudget} from '../workspace/paths.js';
import {acquireWorkspaceLock,assertLockHeld} from '../operations/lock.js';
import {materializeDesiredFiles,inspectDesiredFiles} from './inventory.js';
import {prepareLocalSettings,checkLocalSettings} from './local-settings.js';
import {writeCheckedFile} from '../operations/apply.js';
import {acquireGlobalSettings} from './global-settings.js';
import {installationRecord,readDesiredRecords,assertDesiredTransition,beginDesiredInstall,completeDesiredInstall} from './records.js';
import {includeRetiredTargets} from './retirement.js';
import {bindDesiredSource} from './binding.js';
import {observeTargets} from '../operations/state.js';
import {prepareDesiredRemoval} from './removal.js';

const digest=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const depth=name=>name.split('/').length;

// Internal engine. Legacy migration and public command authorization remain
// separate. hostOptions (including fault-injection boundary) are trusted code.
export async function applyDesiredFiles({workspace,manifest,selected,protectedPaths,source,binding,backup=false},hostOptions={}) {
  if(typeof backup!=='boolean' || !Array.isArray(protectedPaths))fail('desired.apply-options');
  const removing=hostOptions.removeExisting===true;
  const compiled=removing?null:compileDesiredManifest(manifest,{selected,protectedPaths});
  const delivered=removing?null:materializeDesiredFiles(compiled,source);
  if(!removing)binding=bindDesiredSource(binding,source);
  const lock=await acquireWorkspaceLock(workspace,{purpose:'desired-state'});
  workspace=lock.workspace;
  let backupDirectory=null,globalBackupDirectory=null,global=null,mutations=0;
  try {
    const records=await readDesiredRecords(workspace,{allowLegacyMigration:hostOptions.migrateLegacy===true});
    if(hostOptions.expectedRecords &&
        (hostOptions.expectedRecords.installed!==(records.installed?.hash??null) ||
         hostOptions.expectedRecords.pending!==(records.pending?.hash??null)))fail('desired.installation-state-changed');
    if(removing && hostOptions.removalExpected &&
        (hostOptions.removalExpected.installed!==(records.installed?.hash??null) ||
         hostOptions.removalExpected.pending!==(records.pending?.hash??null)))fail('desired.removal-state-changed');
    const previousRoots=Object.values(records.installed?.value.binding?.layout.repositories??{}).map(r=>r.path);
    const protectedDuringMigration=[...new Set([...protectedPaths,...previousRoots,...(records.legacy?.protectedPaths??[])])];
    if(!removing)compileDesiredManifest(manifest,{selected,protectedPaths:protectedDuringMigration});
    const removal=removing?await prepareDesiredRemoval(workspace,records,protectedDuringMigration):null;
    if(removal?.alreadyRemoved)return {status:'removed',mutations:0,backupDirectory:null,globalSettings:'preserved'};
    const retirement=removal??includeRetiredTargets(records.installed?.value??records.legacy?.ownership,compiled,delivered,protectedDuringMigration);
    const desired=retirement.desired;
    const report=await inspectDesiredFiles(workspace,desired);
    if(!report.ready)fail('desired.unsafe-target');
    const localOperations=retirement.settings.filter(op=>op.target!=='grok.user');
    const settings=await prepareLocalSettings(workspace,localOperations);
    global=await acquireGlobalSettings(retirement.settings.filter(op=>op.target==='grok.user'),{...hostOptions,workspace});
    const next=removal?.next??installationRecord(compiled,delivered,{protectedPaths,binding,
      globalConfigPath:compiled.settings.some(op=>op.target==='grok.user')?global?.path??null:null});
    assertDesiredTransition(records,next);
    const createDescriptor=!removing && hostOptions.createDescriptor===true;
    if(createDescriptor) {
      if(!binding)fail('desired.setup-binding-required');
      const [entry]=await observeTargets(workspace,['workspace.json']);
      if(entry.bytes!==null)fail('desired.setup-already-configured');
    }
    async function saveDescriptor() {
      if(!createDescriptor)return;
      const descriptor={schemaVersion:2,pipeline:binding.source,adapters:compiled.adapters,layout:binding.layout};
      mutations++;
      await writeCheckedFile(lock,'workspace.json',null,Buffer.from(JSON.stringify(descriptor,null,2)+'\n'));
    }
    const changedSettings=settings.filter(item=>item.changed);
    const filesChanged=Boolean(report.extra.length || report.modified.length || report.missing.length);
    if(!filesChanged && !changedSettings.length && !global?.changed) {
      const pendingHash=createDescriptor||removing?await beginDesiredInstall(lock,records,next):records.pending?.hash??null;
      await saveDescriptor();
      await completeDesiredInstall(lock,records,next,pendingHash);
      return {status:removing?'removed':mutations?'applied':'unchanged',backupDirectory:null,mutations,...(removing?{globalSettings:'preserved'}:{})};
    }
    const expected=new Map(desired.entries.map(e=>[e.path,e]));
    const current=[...report.extra,
      ...report.modified.map(e=>({path:e.path,kind:e.currentKind,hash:e.beforeHash})),
      ...report.unchanged.map(e=>({path:e.path,kind:e.kind,hash:expected.get(e.path).hash}))];
    function target(name) {
      // Observed custom filenames may be Unicode, unlike source manifest paths.
      if(typeof name!=='string' || name.split('/').some(p=>!p || p==='.' || p==='..' || p.toLowerCase()==='.git') ||
          /[\\:\u0000-\u001f\u007f]/.test(name))fail('desired.observed-path');
      if(!desired.scopes.some(s=>name===s.path || name.startsWith(s.path+'/')))fail('desired.scope');
      const result=path.resolve(workspace,...name.split('/')),rel=path.relative(workspace,result);
      if(!rel || rel==='..' || rel.startsWith('..'+path.sep) || path.isAbsolute(rel))fail('desired.scope');
      pathBudget(result);return result;
    }
    async function check(entry) {
      await assertLockHeld(lock);
      const file=target(entry.path);
      await inspectDirectory(path.dirname(file));
      const stat=await lstat(file);
      if(stat.isSymbolicLink() || (entry.kind==='file' && (!stat.isFile() || stat.nlink>1)) ||
          (entry.kind==='directory' && !stat.isDirectory()))fail('desired.target-changed');
      if(entry.kind==='file') {
        const bytes=await readFile(file);
        if(digest(bytes)!==entry.hash)fail('desired.target-changed');
        return bytes;
      }
      await inspectDirectory(file);return null;
    }
    // Validate the complete observed set before optional backup or deletion.
    for(const entry of current)await check(entry);
    await checkLocalSettings(workspace,settings);
    await global?.check();
    const pendingHash=await beginDesiredInstall(lock,records,next);
    await saveDescriptor();
    await hostOptions.boundary?.('before-content');
    if(backup) {
      const parent=path.join(workspace,'.pipeline','backups');
      await inspectDirectory(parent);await mkdir(parent,{recursive:true});await inspectDirectory(parent);
      backupDirectory=await mkdtemp(path.join(parent,'desired-'));
      for(const entry of current.sort((a,b)=>depth(a.path)-depth(b.path))) {
        const bytes=await check(entry),destination=path.join(backupDirectory,...entry.path.split('/'));
        await mkdir(path.dirname(destination),{recursive:true});
        if(entry.kind==='directory')await mkdir(destination,{recursive:true});
        else {
          await writeFile(destination,bytes,{flag:'wx',mode:0o600});
          if(digest(await readFile(destination))!==entry.hash)fail('desired.backup-verification');
        }
      }
      // Shared configs may contain secrets: backups stay private/local and are
      // made only on explicit request. Their contents are never put in reports.
      const observed=await checkLocalSettings(workspace,settings);
      for(const item of changedSettings.filter(item=>item.beforeHash!==null)) {
        const destination=path.join(backupDirectory,...item.path.split('/'));
        await mkdir(path.dirname(destination),{recursive:true});
        await writeFile(destination,observed.find(o=>o.path===item.path).bytes,{flag:'wx',mode:0o600});
        if(digest(await readFile(destination))!==item.beforeHash)fail('desired.backup-verification');
      }
      globalBackupDirectory=await global?.backup()??null;
    }
    await checkLocalSettings(workspace,settings);
    await global?.check();
    // Enumerated, non-recursive deletion: unexpected new directory contents make
    // rmdir fail instead of being swept away. No old contents retained by default.
    for(const entry of (filesChanged?current:[]).sort((a,b)=>depth(b.path)-depth(a.path))) {
      await check(entry);
      if(entry.kind==='directory')await rmdir(target(entry.path));
      else await unlink(target(entry.path));
      mutations++;
      await hostOptions.boundary?.('after-delete');
    }
    for(const entry of (filesChanged?[...desired.entries]:[]).sort((a,b)=>depth(a.path)-depth(b.path))) {
      await assertLockHeld(lock);
      const file=target(entry.path);
      await inspectDirectory(path.dirname(file));
      await mkdir(path.dirname(file),{recursive:true});await inspectDirectory(path.dirname(file));
      if(entry.kind==='directory')await mkdir(file);
      else await writeFile(file,entry.bytes,{flag:'wx',mode:0o600});
      mutations++;
    }
    for(const item of changedSettings) {
      // Count attempted writes conservatively: an I/O failure can follow a
      // successful rename or a partially written new file.
      mutations++;
      await writeCheckedFile(lock,item.path,item.beforeHash,item.bytes);
    }
    if(global?.changed){mutations++;await global.apply();}
    const after=await inspectDesiredFiles(workspace,desired);
    if(!after.ready || after.extra.length || after.modified.length || after.missing.length)fail('desired.readback');
    const settingsAfter=await prepareLocalSettings(workspace,localOperations);
    if(settingsAfter.some(item=>item.changed))fail('desired.config-readback');
    await hostOptions.boundary?.('before-record');
    await completeDesiredInstall(lock,records,next,pendingHash);
    return {status:removing?'removed':'applied',backupDirectory,globalBackupDirectory,globalConfigPath:global?.path??null,mutations,...(removing?{globalSettings:'preserved'}:{})};
  } catch(error) {
    // Partial application is explicit; there is no implicit rollback promise.
    error.desiredState={status:mutations?'partial':'not-applied',mutations,backupDirectory,globalBackupDirectory};
    throw error;
  } finally {try{await global?.release();}finally{await lock.release();}}
}
