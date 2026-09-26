import path from 'node:path';
import {homedir,hostname} from 'node:os';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,writeFile,readFile,readdir,unlink,rmdir,open,rename} from 'node:fs/promises';
import {fail} from '../contracts/parse.js';
import {absoluteRoot,inspectDirectory} from '../workspace/paths.js';
import {observeTargets} from '../operations/state.js';
import {sha256} from '../source/inventory.js';
import {compileDesiredSettings} from './settings.js';

// userHome is a trusted host/test dependency, never a source manifest field.
// Cooperative profile lock serializes installations from different workspaces.
export async function acquireGlobalSettings(operations,{userHome=homedir(),workspace}={}) {
  if(!operations.length)return null;
  if(operations.some(op=>op.target!=='grok.user'))fail('desired.global-target');
  // Validate scope/value declarations before creating profile metadata.
  compileDesiredSettings('grok.user',null,operations);
  const root=absoluteRoot(userHome);
  if(!(await inspectDirectory(root)).exists)fail('desired.profile-missing');
  const directory=path.join(root,'.grok'),lockDirectory=path.join(directory,'.wpc-config-lock');
  await inspectDirectory(directory);await mkdir(directory,{recursive:true});await inspectDirectory(directory);
  try{await mkdir(lockDirectory);}catch(e){if(e.code==='EEXIST')fail('desired.profile-busy');throw e;}
  const token=randomUUID(),owner=Buffer.from(JSON.stringify({schemaVersion:1,token,pid:process.pid,host:hostname(),
    createdAt:new Date().toISOString(),workspace:workspace===undefined?null:absoluteRoot(workspace),purpose:'desired-global-settings'})+'\n'),ownerPath=path.join(lockDirectory,'owner');
  await writeFile(ownerPath,owner,{flag:'wx',mode:0o600});
  let released=false;
  async function held() {
    if(released)fail('desired.profile-lock-released');
    await inspectDirectory(lockDirectory);
    const [observed]=await observeTargets(root,['.grok/.wpc-config-lock/owner']);
    if(observed.bytes===null || !observed.bytes.equals(owner))fail('desired.profile-lock-changed');
  }
  async function release() {
    await held();
    const names=await readdir(lockDirectory);
    if(names.length!==1 || names[0]!=='owner')fail('desired.profile-lock-changed');
    await unlink(ownerPath);await rmdir(lockDirectory);released=true;
  }
  try {
    const relative='.grok/config.toml',filename=path.join(directory,'config.toml');
    const [initial]=await observeTargets(root,[relative]);
    const edited=compileDesiredSettings('grok.user',initial.bytes,operations);
    const beforeHash=initial.bytes===null?null:sha256(initial.bytes);
    let backupDirectory=null;
    async function check() {
      await held();const [current]=await observeTargets(root,[relative]);
      if((current.bytes===null?null:sha256(current.bytes))!==beforeHash)fail('desired.global-config-changed');
      return current.bytes;
    }
    return {
      path:filename,changed:edited.changed,release,check,
      async backup() {
        const bytes=await check();
        if(!edited.changed || bytes===null)return null;
        const parent=path.join(directory,'workspace-pipeline-backups');
        await inspectDirectory(parent);await mkdir(parent,{recursive:true});await inspectDirectory(parent);
        backupDirectory=await mkdtemp(path.join(parent,'desired-'));
        const destination=path.join(backupDirectory,'config.toml');
        await writeFile(destination,bytes,{flag:'wx',mode:0o600});
        if(sha256(await readFile(destination))!==beforeHash)fail('desired.backup-verification');
        return backupDirectory;
      },
      async apply() {
        await check();if(!edited.changed)return;
        const staging=beforeHash===null?filename:path.join(directory,'config.toml.wpc-'+token+'.tmp');
        const handle=await open(staging,'wx',0o600);
        try{await handle.writeFile(edited.bytes);await handle.sync();}finally{await handle.close();}
        if(beforeHash!==null){await check();await rename(staging,filename);}
        const [after]=await observeTargets(root,[relative]);
        if(after.bytes===null || !after.bytes.equals(edited.bytes))fail('desired.global-readback');
      }
    };
  } catch(error){await release();throw error;}
}
