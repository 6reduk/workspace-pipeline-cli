import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {sha256} from '../src/source/inventory.js';
import {prepareLegacyUnityPreflight as prepare,recheckLegacyUnityPreflight as recheck} from '../src/migrations/legacy-unity-preflight.js';
import {prepareLegacyUnityPreview,verifyLegacyUnityPreview} from '../src/migrations/legacy-unity-preview.js';
import {contractDigest} from '../src/contracts/semantic.js';
import {beginLegacyUnityMigration} from '../src/migrations/legacy-unity-begin.js';
import {prepareLegacyUnityCloseoutResume} from '../src/migrations/legacy-unity-resume.js';
import {applyLegacyUnityCloseoutResume} from '../src/migrations/legacy-unity-resume-apply.js';
import {prepareLegacyUnityDeactivationResume} from '../src/migrations/legacy-unity-deactivation-resume.js';
import {applyLegacyUnityDeactivationResume} from '../src/migrations/legacy-unity-deactivation-resume-apply.js';
import {verifyLegacyUnityDeactivationJournal} from '../src/migrations/legacy-unity-install.js';
import {prepareLegacyUnityInstallResume,applyLegacyUnityInstallResume} from '../src/migrations/legacy-unity-install-resume.js';
import {prepareLegacyUnityInstallRecovery,applyLegacyUnityInstallRecovery} from '../src/migrations/legacy-unity-install-recovery.js';
import {prepareLegacyUnityCompensation,applyLegacyUnityCompensation} from '../src/migrations/legacy-unity-compensate.js';
import {acquireWorkspaceLock,assertLockHeld} from '../src/operations/lock.js';
import {inspectInstallation} from '../src/operations/doctor.js';
const id='unity-sdd-pipeline@unity-sdd';
async function fixture(){
 const root=await mkdtemp(path.join(tmpdir(),'wpc-s10-preflight-')),wrapper=path.join(root,'wrapper'),repo=path.join(root,'source'),temp=path.join(root,'staging');
 for(const d of [wrapper,repo,temp])await mkdir(d);
 const originals={'.codex/config.toml':`[plugins."${id}"]\nenabled=true\n`,'.claude/settings.local.json':JSON.stringify({enabledPlugins:{[id]:true}}),'AGENTS.md':'# old entry','CLAUDE.md':'# old Claude','.unity-sdd/workspace.json':'{}','.unity-sdd/claude.json':'{}','project/untouched.txt':'do not touch'};
 for(const [p,b] of Object.entries(originals)){await mkdir(path.dirname(path.join(wrapper,p)),{recursive:true});await writeFile(path.join(wrapper,p),b);}
 const decl={skills:'skills',agents:null,mcp:'mcp.json',entryInstructions:null,requires:[]};
 const files={'pipeline.json':JSON.stringify({schemaVersion:1,id:'unity-sdd',version:'1.0.0',inventory:'inventory.json',resources:'resources',agentsDocument:{mode:'default'},providers:{codex:decl,claude:decl}}),'resources/process.md':'# policy','skills/example/SKILL.md':'---\nname: example\ndescription: Fixture skill\n---\nRead policy.\n'};
 files['mcp.json']=JSON.stringify({mcpServers:{blender:{type:'stdio',command:'never-executed'}}});
 files['inventory.json']=JSON.stringify(Object.fromEntries(Object.entries(files).map(([p,b])=>[p,sha256(Buffer.from(b))])));
 for(const [p,b] of Object.entries(files)){await mkdir(path.dirname(path.join(repo,p)),{recursive:true});await writeFile(path.join(repo,p),b);}
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^GIT_/i.test(k)));Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'});
 for(const args of [['init','--template='],['add','--all'],['commit','-m','synthetic']]){
  const r=spawnSync('git',['-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],{env,encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);
 }
 return {wrapper,originals,source:{type:'git',transport:'local',path:'source',ref:'HEAD',subdirectory:'.'},manifestBase:root,tempRoot:temp};
}
test('prefetch/recheck preserves wrapper and rejects changed targets or staged source',async()=>{
 const f=await fixture(),record=await prepare(f);
 assert.equal((await recheck(record,f.wrapper)).authorized,false);
 for(const [p,b] of Object.entries(f.originals))assert.equal(await readFile(path.join(f.wrapper,p),'utf8'),b);
 assert.equal((await readdir(f.wrapper)).includes('.pipeline'),false);
 await assert.rejects(()=>recheck(record,path.dirname(f.wrapper)),e=>e.code==='migration.preflight-binding');
 await writeFile(path.join(f.wrapper,'AGENTS.md'),'new user edit');
 await assert.rejects(()=>recheck(record,f.wrapper),e=>e.code==='migration.observation-drift');
 await writeFile(path.join(f.wrapper,'AGENTS.md'),f.originals['AGENTS.md']);
 await writeFile(path.join(record.supply.snapshotPath,'resources/process.md'),'changed');
 await assert.rejects(()=>recheck(record,f.wrapper));
});
async function migrationProposal(){
 const f=await fixture(),manifestPath=path.join(f.manifestBase,'workspace.json');
 await writeFile(manifestPath,JSON.stringify({schemaVersion:1,pipeline:f.source,providers:['codex','claude'],layout:{kind:'single-repo',repositories:{game:{path:'project',role:'code'}},documentation:{repository:'game',path:'docs'}}}));
 const proposal=await prepareLegacyUnityPreview({...f,manifestPath});
 return {...f,proposal,approval:{decision:'approve',previewDigest:proposal.digest}};
}
test('pre-marker failure removes only newly-created empty metadata and allows fresh migration',async()=>{
 const f=await migrationProposal();
 await assert.rejects(()=>beginLegacyUnityMigration(f.proposal,f.approval,f.wrapper,{boundary:async phase=>{
  if(phase==='locked')await writeFile(path.join(f.wrapper,'AGENTS.md'),'concurrent edit');
 }}),e=>e.code==='migration.observation-drift');
 assert.equal((await readdir(f.wrapper)).includes('.pipeline'),false);
 assert.equal(await readFile(path.join(f.wrapper,'AGENTS.md'),'utf8'),'concurrent edit');
 await writeFile(path.join(f.wrapper,'AGENTS.md'),f.originals['AGENTS.md']);
 await recheck(f.proposal.preflight,f.wrapper);
 const begun=await beginLegacyUnityMigration(f.proposal,f.approval,f.wrapper);
 await begun.lock.release();
 const other=await migrationProposal();
 await assert.rejects(()=>beginLegacyUnityMigration(other.proposal,other.approval,other.wrapper,{boundary:async phase=>{
  if(phase==='locked') { await writeFile(path.join(other.wrapper,'.pipeline','foreign.txt'),'preserve'); throw Error('stop'); }
 }}),/stop/);
 assert.equal(await readFile(path.join(other.wrapper,'.pipeline','foreign.txt'),'utf8'),'preserve');
 assert.deepEqual(await readdir(path.join(other.wrapper,'.pipeline')),['foreign.txt']);
});

test('begin persists private recovery, uses authenticated lease and keeps providers untouched',async()=>{
 const f=await migrationProposal();
 await assert.rejects(()=>acquireWorkspaceLock(f.wrapper,{migrationOperation:{workspace:f.wrapper}}),e=>e.code==='migration.lease');
 assert.equal((await readdir(f.wrapper)).includes('.pipeline'),false);
 const begun=await beginLegacyUnityMigration(f.proposal,f.approval,f.wrapper);
 try{
  await assertLockHeld(begun.lock);
  const recovery=JSON.parse(await readFile(path.join(f.wrapper,begun.recoveryPath),'utf8'));
  assert.equal(recovery.preview.digest,f.proposal.digest);
  assert.equal(recovery.approval.previewDigest,f.proposal.digest);
  const untouched=await prepareLegacyUnityDeactivationResume(f.wrapper,begun.recoveryPath);
  assert.deepEqual(untouched.operations.map(o=>o.action),['write-disabled','write-disabled']);
  const cli=spawnSync(process.execPath,[path.resolve('src/cli.js'),'migration','unity','inspect','--workspace',f.wrapper,
   '--recovery',begun.recoveryPath,'--phase','deactivation','--json'],{encoding:'utf8',windowsHide:true,timeout:60000});
  assert.equal(cli.status,0,cli.stderr);assert.equal(JSON.parse(cli.stdout).preview.digest,untouched.digest);
  assert.equal(JSON.parse(cli.stdout).kind,'installer-bound-migration-preview');
  assert.match(cli.stderr,/private configuration/);
  const first=f.proposal.preflight.deactivation.targets[0];
  await writeFile(path.join(f.wrapper,first.path),Buffer.from(first.after,'base64'));
  assert.equal((await prepareLegacyUnityDeactivationResume(f.wrapper,begun.recoveryPath)).status,'blocked');
  await writeFile(path.join(f.wrapper,first.path),Buffer.from(first.before,'base64'));
  for(const [p,b] of Object.entries(f.originals))assert.equal(await readFile(path.join(f.wrapper,p),'utf8'),b);
  await assert.rejects(()=>acquireWorkspaceLock(f.wrapper),e=>e.code==='migration.pending');
  assert.equal((await inspectInstallation(f.wrapper)).ready,false);
  await writeFile(path.join(f.wrapper,begun.recoveryPath),'{}');
  await assert.rejects(()=>assertLockHeld(begun.lock),e=>e.code==='migration.recovery-drift');
 }finally{await begun.lock.release();}
});
test('interrupted marker/recovery persistence leaves blocker and never modifies providers',async()=>{
 for(const stop of ['marker:opened','recovery:written']){
  const f=await migrationProposal();
  await assert.rejects(()=>beginLegacyUnityMigration(f.proposal,f.approval,f.wrapper,{boundary:async phase=>{if(phase===stop)throw Error('synthetic interruption');}}));
  for(const [p,b] of Object.entries(f.originals))assert.equal(await readFile(path.join(f.wrapper,p),'utf8'),b);
  await assert.rejects(()=>acquireWorkspaceLock(f.wrapper),e=>e.code==='migration.pending');
  const doctor=await inspectInstallation(f.wrapper);assert.equal(doctor.ready,false);assert.equal(doctor.status,'needs-reconciliation');
  assert.equal((await readdir(path.join(f.wrapper,'.pipeline'))).includes('lock'),false);
 }
});
test('deactivation journals both exact settings, preserves entries and refuses implicit replay',async()=>{
 const f=await migrationProposal(),begun=await beginLegacyUnityMigration(f.proposal,f.approval,f.wrapper);
 try{
  const result=await begun.deactivate();assert.equal(result.outcome,'completed');assert.equal(result.status,'needs-reconciliation');
  for(const t of f.proposal.preflight.deactivation.targets)assert.equal(sha256(await readFile(path.join(f.wrapper,t.path))),t.afterHash);
  for(const p of ['AGENTS.md','CLAUDE.md','project/untouched.txt'])assert.equal(await readFile(path.join(f.wrapper,p),'utf8'),f.originals[p]);
  assert.equal((await readdir(path.join(f.wrapper,result.journal))).length,6);
  const first=f.proposal.preflight.deactivation.targets[0];
  await writeFile(path.join(f.wrapper,first.path),Buffer.from(first.before,'base64'));
  assert.equal((await prepareLegacyUnityDeactivationResume(f.wrapper,begun.recoveryPath)).status,'blocked');
  await writeFile(path.join(f.wrapper,first.path),Buffer.from(first.after,'base64'));
  await assert.rejects(()=>begun.deactivate());
 }finally{await begun.lock.release();}
 assert.equal((await inspectInstallation(f.wrapper)).ready,false);
});
test('fault after first target rename stops second target and records uncertainty',async()=>{
 const f=await migrationProposal(),begun=await beginLegacyUnityMigration(f.proposal,f.approval,f.wrapper);
 try{
  const result=await begun.deactivate({boundary:async step=>{if(step==='renamed')throw Error('synthetic crash');}});
  assert.equal(result.outcome,'uncertain');
  assert.equal(await readFile(path.join(f.wrapper,'.claude/settings.local.json'),'utf8'),f.originals['.claude/settings.local.json']);
  const events=await readdir(path.join(f.wrapper,result.journal));assert.equal(events.length,3);
  const last=JSON.parse(await readFile(path.join(f.wrapper,result.journal,events.at(-1)),'utf8'));assert.equal(last.detail.status,'uncertain');
  const resume=await prepareLegacyUnityDeactivationResume(f.wrapper,begun.recoveryPath);
  assert.equal(resume.status,'needs-approval');assert.equal(resume.executable,false);
  assert.deepEqual(resume.operations.map(o=>o.action),['confirm-observed','write-disabled']);
  const journalPath=path.join(f.wrapper,result.journal,events.at(-1)),original=await readFile(journalPath);
  await writeFile(journalPath,JSON.stringify({...last,previous:'sha256:'+'0'.repeat(64)}));
  await assert.rejects(()=>prepareLegacyUnityDeactivationResume(f.wrapper,begun.recoveryPath),e=>e.code==='migration.phase-evidence');
  await writeFile(journalPath,original);
  const config=path.join(f.wrapper,'.claude/settings.local.json');await writeFile(config,'{}');
  const conflict=await prepareLegacyUnityDeactivationResume(f.wrapper,begun.recoveryPath);
  assert.equal(conflict.status,'blocked');assert.deepEqual(conflict.operations,[]);
  await writeFile(config,f.originals['.claude/settings.local.json']);
  assert.equal((await prepareLegacyUnityDeactivationResume(f.wrapper,begun.recoveryPath)).digest,resume.digest);
 }finally{await begun.lock.release();}
 await assert.rejects(()=>acquireWorkspaceLock(f.wrapper),e=>e.code==='migration.pending');
});
test('second phase uses native setup and backups, but marker prevents premature readiness',async()=>{
 const f=await migrationProposal(),begun=await beginLegacyUnityMigration(f.proposal,f.approval,f.wrapper);
 try{
  await assert.rejects(()=>begun.install());
  await assert.rejects(()=>begun.finalize());
  await assert.rejects(()=>prepareLegacyUnityCloseoutResume(f.wrapper,begun.recoveryPath));
  assert.equal(await readFile(path.join(f.wrapper,'AGENTS.md'),'utf8'),f.originals['AGENTS.md']);
  await begun.deactivate();
  const installed=await begun.install();assert.equal(installed.installationStatus,'ready');
  assert.equal(installed.status,'needs-reconciliation');
  const state=JSON.parse(await readFile(path.join(f.wrapper,'.pipeline/state.json'),'utf8'));
  for(const name of ['AGENTS.md','CLAUDE.md']){
   const ownership=state.active.owned.find(o=>o.path===name);
   assert.equal(await readFile(path.join(f.wrapper,ownership.backup),'utf8'),f.originals[name]);
  }
  for(const name of ['.agents/skills/example/SKILL.md','.claude/skills/example/SKILL.md'])assert.match(await readFile(path.join(f.wrapper,name),'utf8'),/complete pipeline instruction/);
  const doctor=await inspectInstallation(f.wrapper);assert.equal(doctor.ready,false);assert.equal(doctor.status,'needs-reconciliation');
  assert.equal(await readFile(path.join(f.wrapper,'project/untouched.txt'),'utf8'),'do not touch');
  await assert.rejects(()=>begun.install());
  const resume=await prepareLegacyUnityCloseoutResume(f.wrapper,begun.recoveryPath);
  assert.equal(resume.executable,false);assert.deepEqual(resume.operations.map(o=>o.action),['create','delete']);
  const completed=await begun.finalize();assert.equal(completed.status,'completed');
  assert.ok(await readFile(path.join(f.wrapper,completed.completionPath)));
  await assert.rejects(()=>assertLockHeld(begun.lock),e=>e.code==='migration.marker-missing');
 }finally{await begun.lock.release();}
 assert.equal((await inspectInstallation(f.wrapper)).ready,true);
});
test('installation recovery before pending requires untouched targets and preserves original evidence',async()=>{
 const f=await migrationProposal(),begun=await beginLegacyUnityMigration(f.proposal,f.approval,f.wrapper);
 try {
  await begun.deactivate();
  await assert.rejects(()=>begun.install({boundary:async phase=>{if(phase==='recovery')throw Error('pre-pending stop');}}),/pre-pending stop/);
 }finally{await begun.lock.release();}
 assert.equal((await readdir(path.join(f.wrapper,'.pipeline'))).includes('state.json'),false);
 const locator=JSON.parse(await readFile(path.join(f.wrapper,path.dirname(begun.recoveryPath),'installation.json'),'utf8'));
 const original=await readFile(path.join(f.wrapper,locator.recoveryPath));
 const journalNames=await readdir(path.join(f.wrapper,locator.journal));
 const journalBytes=await Promise.all(journalNames.map(n=>readFile(path.join(f.wrapper,locator.journal,n))));
 const proposal=await prepareLegacyUnityInstallRecovery(f.wrapper,begun.recoveryPath);
 assert.equal(proposal.continuation.evidence.statePhase,'before');
 assert.equal(proposal.continuation.stateFileHash,null);
 assert.ok(proposal.continuation.actions.every(a=>a.action==='write-desired'&&a.recorded==='skipped'));
 await writeFile(path.join(f.wrapper,'AGENTS.md'),'foreign edit');
 await assert.rejects(()=>applyLegacyUnityInstallRecovery(proposal,{decision:'approve',previewDigest:proposal.digest},f.wrapper));
 assert.equal(await readFile(path.join(f.wrapper,'AGENTS.md'),'utf8'),'foreign edit');
 await writeFile(path.join(f.wrapper,'AGENTS.md'),f.originals['AGENTS.md']);
 const result=await applyLegacyUnityInstallRecovery(proposal,{decision:'approve',previewDigest:proposal.digest},f.wrapper);
 assert.equal(result.installationStatus,'ready');
 assert.deepEqual(await readFile(path.join(f.wrapper,locator.recoveryPath)),original);
 assert.deepEqual(await readdir(path.join(f.wrapper,locator.journal)),journalNames);
 for(let i=0;i<journalNames.length;i++)assert.deepEqual(await readFile(path.join(f.wrapper,locator.journal,journalNames[i])),journalBytes[i]);
 const closeout=await prepareLegacyUnityCloseoutResume(f.wrapper,begun.recoveryPath);
 assert.equal(closeout.verified.native.lineage.length,1);
 await applyLegacyUnityCloseoutResume(closeout,{decision:'approve',previewDigest:closeout.digest},f.wrapper);
 assert.equal((await inspectInstallation(f.wrapper)).ready,true);
 assert.equal(await readFile(path.join(f.wrapper,'project/untouched.txt'),'utf8'),f.originals['project/untouched.txt']);
});

test('interrupted native installation stays blocked and cannot implicitly replay',async()=>{
 const f=await migrationProposal(),begun=await beginLegacyUnityMigration(f.proposal,f.approval,f.wrapper);
 try{
  await begun.deactivate();
  await assert.rejects(()=>begun.install({boundary:async phase=>{if(phase==='write')throw Error('synthetic installation interruption');}}),/synthetic installation interruption/);
  const locator=JSON.parse(await readFile(path.join(f.wrapper,path.dirname(begun.recoveryPath),'installation.json'),'utf8'));
  assert.equal(locator.migrationRecoveryHash,begun.recoveryHash);
  assert.ok(await readFile(path.join(f.wrapper,locator.recoveryPath)));
  assert.equal((await inspectInstallation(f.wrapper)).ready,false);
  await assert.rejects(()=>begun.install());
  assert.equal(await readFile(path.join(f.wrapper,'project/untouched.txt'),'utf8'),'do not touch');
 }finally{await begun.lock.release();}
 const recoveryPreview=await prepareLegacyUnityInstallRecovery(f.wrapper,begun.recoveryPath);
 assert.equal(recoveryPreview.executable,false);assert.equal(recoveryPreview.status,'needs-approval');
 assert.ok(recoveryPreview.continuation.actions.some(a=>a.action==='verify-readback'));
 assert.ok(recoveryPreview.continuation.actions.some(a=>a.action==='write-desired'));
 assert.equal((await prepareLegacyUnityInstallRecovery(f.wrapper,begun.recoveryPath)).digest,recoveryPreview.digest);
 const locatorPath=path.join(f.wrapper,path.dirname(begun.recoveryPath),'installation.json'),saved=await readFile(locatorPath);
 const locator=JSON.parse(saved);locator.preparedDigest='sha256:'+'0'.repeat(64);await writeFile(locatorPath,JSON.stringify(locator));
 await assert.rejects(()=>prepareLegacyUnityInstallRecovery(f.wrapper,begun.recoveryPath),e=>e.code==='migration.install-binding');
 await writeFile(locatorPath,saved);
 await assert.rejects(()=>acquireWorkspaceLock(f.wrapper),e=>e.code==='migration.pending');
 await assert.rejects(()=>applyLegacyUnityInstallRecovery(recoveryPreview,{decision:'approve',previewDigest:'wrong'},f.wrapper),e=>e.code==='migration.resume-approval');
 const result=await applyLegacyUnityInstallRecovery(recoveryPreview,{decision:'approve',previewDigest:recoveryPreview.digest},f.wrapper);
 assert.equal(result.installationStatus,'ready');assert.equal((await inspectInstallation(f.wrapper)).ready,false);
 await assert.rejects(()=>prepareLegacyUnityInstallRecovery(f.wrapper,begun.recoveryPath),e=>e.code==='migration.continuation-started');
 const closeout=await prepareLegacyUnityCloseoutResume(f.wrapper,begun.recoveryPath);
 assert.equal(closeout.verified.native.lineage.length,1);
 await applyLegacyUnityCloseoutResume(closeout,{decision:'approve',previewDigest:closeout.digest},f.wrapper);
 assert.equal((await inspectInstallation(f.wrapper)).ready,true);
});

test('interrupted installation continuation never unblocks migration or permits implicit retry',async()=>{
 const f=await migrationProposal(),begun=await beginLegacyUnityMigration(f.proposal,f.approval,f.wrapper);
 try{
  await begun.deactivate();
  await assert.rejects(()=>begun.install({boundary:async step=>{if(step==='write')throw Error('initial failure');}}));
 }finally{await begun.lock.release();}
 const preview=await prepareLegacyUnityInstallRecovery(f.wrapper,begun.recoveryPath);
 await assert.rejects(()=>applyLegacyUnityInstallRecovery(preview,{decision:'approve',previewDigest:preview.digest},f.wrapper,
  {boundary:async step=>{if(step==='write')throw Error('continuation failure');}}),/continuation failure/);
 assert.equal((await inspectInstallation(f.wrapper)).ready,false);
 await assert.rejects(()=>prepareLegacyUnityCloseoutResume(f.wrapper,begun.recoveryPath),e=>e.code==='migration.install-incomplete');
 await assert.rejects(()=>applyLegacyUnityInstallRecovery(preview,{decision:'approve',previewDigest:preview.digest},f.wrapper),e=>e.code==='migration.continuation-started');
 await assert.rejects(()=>acquireWorkspaceLock(f.wrapper),e=>e.code==='migration.pending');
 assert.equal(await readFile(path.join(f.wrapper,'project/untouched.txt'),'utf8'),'do not touch');
});

test('completion interruption retains marker and rejects unapproved closeout replay',async()=>{
 const f=await migrationProposal(),begun=await beginLegacyUnityMigration(f.proposal,f.approval,f.wrapper);
 try{
  await begun.deactivate();await begun.install();
  const entry=path.join(f.wrapper,'AGENTS.md'),original=await readFile(entry);
  await writeFile(entry,'foreign edit');
  await assert.rejects(()=>begun.finalize(),e=>e.code==='migration.install-incomplete');
  await writeFile(entry,original);
  await assert.rejects(()=>begun.finalize({boundary:async phase=>{if(phase==='completion-recorded')throw Error('synthetic closeout interruption');}}),/synthetic closeout interruption/);
  assert.ok(await readFile(path.join(f.wrapper,path.dirname(begun.recoveryPath),'completion.json')));
  assert.equal((await inspectInstallation(f.wrapper)).ready,false);
  await assert.rejects(()=>begun.finalize());
  assert.equal(await readFile(path.join(f.wrapper,'project/untouched.txt'),'utf8'),'do not touch');
 }finally{await begun.lock.release();}
 const resume=await prepareLegacyUnityCloseoutResume(f.wrapper,begun.recoveryPath);
 assert.equal(resume.status,'needs-approval');assert.equal(resume.executable,false);
 assert.deepEqual(resume.operations.map(o=>o.action),['delete']);
 assert.equal((await prepareLegacyUnityCloseoutResume(f.wrapper,begun.recoveryPath)).digest,resume.digest);
 const completion=path.join(f.wrapper,path.dirname(begun.recoveryPath),'completion.json');
 const original=await readFile(completion);await writeFile(completion,'{}');
 await assert.rejects(()=>prepareLegacyUnityCloseoutResume(f.wrapper,begun.recoveryPath),e=>e.code==='migration.completion-drift');
 await writeFile(completion,original);
 await assert.rejects(()=>acquireWorkspaceLock(f.wrapper),e=>e.code==='migration.pending');
 await assert.rejects(()=>applyLegacyUnityCloseoutResume(resume,{decision:'approve',previewDigest:'wrong'},f.wrapper),e=>e.code==='migration.resume-approval');
 const forged=structuredClone(resume);forged.operations[0].path='project/untouched.txt';
 const {digest,...body}=forged;forged.digest=contractDigest(body);
 await assert.rejects(()=>applyLegacyUnityCloseoutResume(forged,{decision:'approve',previewDigest:forged.digest},f.wrapper),e=>e.code==='migration.resume-drift');
 const completed=await applyLegacyUnityCloseoutResume(resume,{decision:'approve',previewDigest:resume.digest},f.wrapper);
 assert.equal(completed.status,'completed');
 assert.equal(await readFile(completion,'utf8'),original.toString());
 assert.ok(await readFile(path.join(f.wrapper,completed.authorizationPath)));
 assert.equal((await inspectInstallation(f.wrapper)).ready,true);
});

test('restart closeout creates missing completion and re-previews after interruption',async()=>{
 const f=await migrationProposal(),begun=await beginLegacyUnityMigration(f.proposal,f.approval,f.wrapper);
 try{await begun.deactivate();await begun.install();}finally{await begun.lock.release();}
 const preview=await prepareLegacyUnityCloseoutResume(f.wrapper,begun.recoveryPath);
 const approval={decision:'approve',previewDigest:preview.digest};
 await assert.rejects(()=>applyLegacyUnityCloseoutResume(preview,approval,f.wrapper,{boundary:async phase=>{
  if(phase==='completion-recorded')throw Error('synthetic resumed interruption');
 }}),/synthetic resumed interruption/);
 assert.equal((await inspectInstallation(f.wrapper)).ready,false);
 await assert.rejects(()=>applyLegacyUnityCloseoutResume(preview,approval,f.wrapper),e=>e.code==='migration.resume-drift');
 const next=await prepareLegacyUnityCloseoutResume(f.wrapper,begun.recoveryPath);
 assert.notEqual(next.digest,preview.digest);assert.equal(next.operations.length,1);
 const result=await applyLegacyUnityCloseoutResume(next,{decision:'approve',previewDigest:next.digest},f.wrapper);
 assert.equal(result.status,'completed');assert.equal((await inspectInstallation(f.wrapper)).ready,true);
 assert.equal(await readFile(path.join(f.wrapper,'project/untouched.txt'),'utf8'),'do not touch');
});

test('approved partial deactivation preserves history and records resumed writes or uncertainty',async()=>{
 for(const interrupt of [false,true]){
  const f=await migrationProposal(),begun=await beginLegacyUnityMigration(f.proposal,f.approval,f.wrapper);let phase;
  try{phase=await begun.deactivate({boundary:async step=>{if(step==='renamed')throw Error('original interruption');}});}finally{await begun.lock.release();}
  const names=await readdir(path.join(f.wrapper,phase.journal));
  const before=await Promise.all(names.map(n=>readFile(path.join(f.wrapper,phase.journal,n))));
  const preview=await prepareLegacyUnityDeactivationResume(f.wrapper,begun.recoveryPath);
  await assert.rejects(()=>applyLegacyUnityDeactivationResume(preview,{decision:'approve',previewDigest:'wrong'},f.wrapper),e=>e.code==='migration.resume-approval');
  const result=await applyLegacyUnityDeactivationResume(preview,{decision:'approve',previewDigest:preview.digest},f.wrapper,
   {boundary:async step=>{if(interrupt&&step==='renamed')throw Error('resumed interruption');}});
  assert.equal(result.status,'needs-reconciliation');assert.equal(result.outcome,interrupt?'uncertain':'phase-observed');
  const verify=()=>verifyLegacyUnityDeactivationJournal(f.wrapper,begun.recoveryPath,begun.recoveryHash,f.proposal);
  if(interrupt)await assert.rejects(verify,e=>e.code==='migration.resume-incomplete');
  else{
   assert.equal((await verify()).directory,result.journal);
   const lastPath=path.join(f.wrapper,result.journal,'000005.json'),saved=await readFile(lastPath);
   const tampered=JSON.parse(saved);tampered.previous='sha256:'+'0'.repeat(64);await writeFile(lastPath,JSON.stringify(tampered));
   await assert.rejects(verify,e=>e.code==='migration.resume-evidence');await writeFile(lastPath,saved);
   const root=path.dirname(path.join(f.wrapper,result.journal));await mkdir(path.join(root,'0'.repeat(64)));
   await assert.rejects(verify,e=>e.code==='migration.resume-selection');
  }
  for(let i=0;i<names.length;i++)assert.deepEqual(await readFile(path.join(f.wrapper,phase.journal,names[i])),before[i]);
  for(const target of f.proposal.preflight.deactivation.targets)assert.equal(sha256(await readFile(path.join(f.wrapper,target.path))),target.afterHash);
  assert.equal(await readFile(path.join(f.wrapper,'AGENTS.md'),'utf8'),f.originals['AGENTS.md']);
  assert.equal(await readFile(path.join(f.wrapper,'project/untouched.txt'),'utf8'),'do not touch');
  await assert.rejects(()=>applyLegacyUnityDeactivationResume(preview,{decision:'approve',previewDigest:preview.digest},f.wrapper));
  assert.equal((await inspectInstallation(f.wrapper)).ready,false);
 }
});

test('fresh approved installation follows recovered deactivation and can close out',async()=>{
 const f=await migrationProposal(),begun=await beginLegacyUnityMigration(f.proposal,f.approval,f.wrapper);
 try{await begun.deactivate({boundary:async step=>{if(step==='renamed')throw Error('fixture interruption');}});}finally{await begun.lock.release();}
 const first=await prepareLegacyUnityDeactivationResume(f.wrapper,begun.recoveryPath);
 await applyLegacyUnityDeactivationResume(first,{decision:'approve',previewDigest:first.digest},f.wrapper);
 const proposal=await prepareLegacyUnityInstallResume(f.wrapper,begun.recoveryPath);
 const approval={decision:'approve',previewDigest:proposal.digest};
 await assert.rejects(()=>applyLegacyUnityInstallResume(proposal,{...approval,previewDigest:'wrong'},f.wrapper),e=>e.code==='migration.resume-approval');
 await writeFile(path.join(f.wrapper,'AGENTS.md'),'foreign edit');
 await assert.rejects(()=>applyLegacyUnityInstallResume(proposal,approval,f.wrapper),e=>e.code==='migration.observation-drift');
 await writeFile(path.join(f.wrapper,'AGENTS.md'),f.originals['AGENTS.md']);
 const installed=await applyLegacyUnityInstallResume(proposal,approval,f.wrapper);
 assert.equal(installed.installationStatus,'ready');assert.equal((await inspectInstallation(f.wrapper)).ready,false);
 assert.ok(await readFile(path.join(f.wrapper,installed.authorizationPath)));
 await assert.rejects(()=>prepareLegacyUnityInstallResume(f.wrapper,begun.recoveryPath),e=>e.code==='migration.install-started');
 const closeout=await prepareLegacyUnityCloseoutResume(f.wrapper,begun.recoveryPath);
 await applyLegacyUnityCloseoutResume(closeout,{decision:'approve',previewDigest:closeout.digest},f.wrapper);
 assert.equal((await inspectInstallation(f.wrapper)).ready,true);
 assert.equal(await readFile(path.join(f.wrapper,'project/untouched.txt'),'utf8'),'do not touch');
});

test('approved pre-install compensation restores exact legacy bytes and failure remains blocked',async()=>{
 for(const interrupt of [false,true]){
  const f=await migrationProposal(),begun=await beginLegacyUnityMigration(f.proposal,f.approval,f.wrapper);let first;
  try{first=await begun.deactivate();}finally{await begun.lock.release();}
  const names=await readdir(path.join(f.wrapper,first.journal));
  const before=await Promise.all(names.map(n=>readFile(path.join(f.wrapper,first.journal,n))));
  const preview=await prepareLegacyUnityCompensation(f.wrapper,begun.recoveryPath);
  await assert.rejects(()=>applyLegacyUnityCompensation(preview,{decision:'approve',previewDigest:'wrong'},f.wrapper),e=>e.code==='migration.resume-approval');
  const result=await applyLegacyUnityCompensation(preview,{decision:'approve',previewDigest:preview.digest},f.wrapper,
   {boundary:async phase=>{if(interrupt&&phase==='renamed')throw Error('compensation interruption');}});
  assert.equal(result.status,interrupt?'needs-reconciliation':'legacy-restored');
  for(let i=0;i<names.length;i++)assert.deepEqual(await readFile(path.join(f.wrapper,first.journal,names[i])),before[i]);
  if(interrupt)await assert.rejects(()=>acquireWorkspaceLock(f.wrapper),e=>e.code==='migration.pending');
  else{
   for(const [name,bytes] of Object.entries(f.originals))assert.equal(await readFile(path.join(f.wrapper,name),'utf8'),bytes);
   await assert.rejects(()=>readFile(path.join(f.wrapper,'.pipeline/migration-operation.json')),e=>e.code==='ENOENT');
  }
  assert.equal(await readFile(path.join(f.wrapper,'project/untouched.txt'),'utf8'),'do not touch');
 }
});

test('public CLI preview/apply rejects changed installer then completes synthetic migration',async()=>{
 const f=await fixture(),manifestPath=path.join(f.manifestBase,'workspace.json');
 await writeFile(manifestPath,JSON.stringify({schemaVersion:1,pipeline:f.source,providers:['codex','claude'],layout:{kind:'single-repo',repositories:{game:{path:'project',role:'code'}},documentation:{repository:'game',path:'docs'}}}));
 const cli=args=>spawnSync(process.execPath,[process.env.WPC_TEST_MIGRATION_CLI??path.resolve('src/cli.js'),...args,...(args.includes('--json')?[]:['--json'])],{encoding:'utf8',windowsHide:true,timeout:180000,maxBuffer:8*1024*1024});
 const prepared=cli(['migration','unity','preview','--workspace',f.wrapper,'--manifest',manifestPath]);
 assert.equal(prepared.status,0,prepared.stderr);const envelope=JSON.parse(prepared.stdout);
 assert.equal(envelope.kind,'installer-bound-migration-preview');assert.equal((await readdir(f.wrapper)).includes('.pipeline'),false);
 const file=path.join(f.manifestBase,'preview.json'),forged=structuredClone(envelope);
 forged.installer.version='changed';const {digest,...body}=forged;forged.digest=contractDigest(body);
 await writeFile(file,JSON.stringify(forged));
 const rejected=cli(['migration','unity','apply','--workspace',f.wrapper,'--preview',file]);
 assert.equal(rejected.status,2);assert.match(rejected.stderr,/installer.changed/);
 assert.equal((await readdir(f.wrapper)).includes('.pipeline'),false);
 await writeFile(file,prepared.stdout);
 const applied=cli(['migration','unity','apply','--workspace',f.wrapper,'--preview',file]);
 assert.equal(applied.status,0,applied.stderr);assert.equal(JSON.parse(applied.stdout).status,'completed');assert.match(applied.stderr,/"logs"/);
 assert.equal((await inspectInstallation(f.wrapper)).ready,true);
 for(const name of ['project/untouched.txt','.unity-sdd/workspace.json','.unity-sdd/claude.json'])assert.equal(await readFile(path.join(f.wrapper,name),'utf8'),f.originals[name]);
 assert.notEqual(cli(['migration','unity','apply','--workspace',f.wrapper,'--preview',file]).status,0);
});

test('existing installation or nested preparation rejects before acquisition',async()=>{
 const f=await fixture();
 await assert.rejects(()=>prepare({...f,tempRoot:f.wrapper}),e=>e.code==='migration.preparation-location');
 await mkdir(path.join(f.wrapper,'.pipeline'));
 await assert.rejects(()=>prepare(f),e=>e.code==='migration.already-managed');
 assert.deepEqual(await readdir(f.tempRoot),[]);
});
test('rendered preview retains entry backups and rejects foreign skill collision without wrapper writes',async()=>{
 const f=await fixture(),manifestPath=path.join(f.manifestBase,'workspace.json');
 const manifest={schemaVersion:1,pipeline:f.source,providers:['codex','claude'],layout:{kind:'single-repo',repositories:{game:{path:'project',role:'code'}},documentation:{repository:'game',path:'docs'}}};
 await writeFile(manifestPath,JSON.stringify(manifest));
 const proposal=await prepareLegacyUnityPreview({...f,manifestPath});
 const approval={decision:'approve',previewDigest:proposal.digest};
 assert.equal((await verifyLegacyUnityPreview(proposal,approval,f.wrapper)).digest,proposal.digest);
 await assert.rejects(()=>verifyLegacyUnityPreview(proposal,{...approval,previewDigest:'sha256:'+'0'.repeat(64)},f.wrapper),e=>e.code==='migration.approval');
 await assert.rejects(()=>verifyLegacyUnityPreview(proposal,approval,path.dirname(f.wrapper)),e=>e.code==='migration.preview-binding');
 for(const mutation of [p=>p.entries[0].after=Buffer.from('unapproved instruction').toString('base64'),p=>p.setup.plan.targets[0].path='project/AGENTS.md',p=>p.phases.reverse()]){
  const forged=structuredClone(proposal);mutation(forged);const {digest,...body}=forged;forged.digest=contractDigest(body);
  await assert.rejects(()=>verifyLegacyUnityPreview(forged,{decision:'approve',previewDigest:forged.digest},f.wrapper),e=>e.code==='migration.render-drift');
 }
 assert.equal(proposal.kind,'legacy-unity-preview');
 assert.deepEqual(proposal.phases,['deactivate-legacy','install-local-delivery']);
 for(const entry of proposal.entries){
  assert.equal(Buffer.from(entry.before,'base64').toString(),f.originals[entry.path]);
  assert.equal(proposal.setup.plan.desired.owned.find(o=>o.path===entry.path).beforeHash,entry.beforeHash);
  assert.ok(proposal.setup.plan.desired.owned.find(o=>o.path===entry.path).backup);
 }
 assert.match(Buffer.from(proposal.entries.find(e=>e.path==='AGENTS.md').after,'base64').toString(),/project\/docs/);
 const projectedConfig=proposal.setup.observations.find(o=>o.path==='.codex/config.toml');
 assert.match(Buffer.from(projectedConfig.bytes,'base64').toString(),/enabled=false/);
 const finalConfig=proposal.setup.outputs.find(o=>o.path==='.codex/config.toml');
 assert.match(Buffer.from(finalConfig.bytes,'base64').toString(),/enabled=false/);
 assert.match(Buffer.from(finalConfig.bytes,'base64').toString(),/never-executed/);
 for(const [p,b] of Object.entries(f.originals))assert.equal(await readFile(path.join(f.wrapper,p),'utf8'),b);
 assert.equal((await readdir(f.wrapper)).includes('.pipeline'),false);
 const foreign=path.join(f.wrapper,'.agents/skills/example/SKILL.md');await mkdir(path.dirname(foreign),{recursive:true});await writeFile(foreign,'user skill');
 await assert.rejects(()=>prepareLegacyUnityPreview({...f,manifestPath}),e=>e.code==='ownership.foreign');
 assert.equal(await readFile(foreign,'utf8'),'user skill');
});
