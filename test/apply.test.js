import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, readFile, writeFile, readdir, symlink, rename, cp, utimes } from 'node:fs/promises';
import { acquireWorkspaceLock } from '../src/operations/lock.js';
import { createJournal, readJournal } from '../src/operations/journal.js';
import { sha256, verifyPackage } from '../src/source/inventory.js';
import { saveBackup, verifyBackup, copySnapshot } from '../src/operations/backup.js';
import { materialize } from '../src/source/snapshot.js';
import { verifyPreparedSnapshot, readState, readRecord, previewRebind } from '../src/operations/state.js';
import { preflightPreview, verifyPreparedApproval, preflightApply, applyPrepared, applyRepair, applyRemoval, applyContinuation, inspectRecovery } from '../src/operations/apply.js';
import { bindPreview, preparePlan, composePlan, assertRecoveryBudget } from '../src/operations/plan.js';
import { parse, MAX_INPUT_BYTES } from '../src/contracts/parse.js';
import { spawn, spawnSync } from 'node:child_process';
import { contractDigest } from '../src/contracts/semantic.js';
import { providerDouble } from './fixtures/provider-double.js';
import {fileURLToPath} from 'node:url';
import { inspectInstallation } from '../src/operations/doctor.js';
import {prepareLifecycle,applyLifecycle} from '../src/operations/lifecycle.js';
import {inspectRepair,prepareRepairPreview,prepareRepairPlan,verifyRepairApproval} from '../src/operations/repair.js';
import {previewReconciliation,prepareContinuation,verifyContinuationApproval} from '../src/operations/reconciliation.js';
import {prepareRemoval,selectRemovalProviders,verifyRemovalApproval} from '../src/operations/remove.js';
import {prepareSwitch} from '../src/operations/switch-prepare.js';
import {createSwitchRecoveryRecord,validateSwitchRecoveryRecord} from '../src/operations/switch-records.js';
import {verifySwitchApproval} from '../src/operations/switch-preflight.js';
import {persistSwitchRecovery,readSwitchRecovery} from '../src/operations/switch-recovery-store.js';
import {markSwitchPending} from '../src/operations/switch-pending.js';
import {inspectPendingSwitch} from '../src/operations/switch-inspect.js';
import {executeSwitchPhase} from '../src/operations/switch-execute.js';
import {activateSwitch,inspectActivatedSwitch} from '../src/operations/switch-activate.js';
import {inspectHistory} from '../src/operations/history.js';
import {prepareSwitchContinuation,verifySwitchContinuationApproval} from '../src/operations/switch-continuation.js';
import {createSwitchContinuationCursor} from '../src/operations/switch-continuation-journal.js';
import {createSwitchContinuationJournal,readSwitchContinuationJournal} from '../src/operations/switch-continuation-store.js';
import {persistSwitchContinuationRecovery,readSwitchContinuationRecovery} from '../src/operations/switch-continuation-recovery.js';
import {assertSwitchContinuationPredecessor} from '../src/operations/switch-continuation-records.js';
import {markSwitchContinuationPending,inspectSelectedSwitchContinuation} from '../src/operations/switch-continuation-pending.js';
import {executeSwitchContinuationPhase,activateSwitchContinuation,inspectSwitchContinuation} from '../src/operations/switch-continuation-runtime.js';
import {scanRetention} from '../src/operations/retention-scan.js';
import {scanCombinedRetention} from '../src/operations/retention-combined-scan.js';
import {applyRetention} from '../src/operations/retention-apply.js';
import {previewRetentionPolicy,applyRetentionPolicy,readRetentionPolicy} from '../src/operations/retention-policy.js';
import {runCli} from '../src/commands/dispatch.js';
import {readTOMLField,reconcileTOMLFields} from '../src/operations/toml-fields.js';
import {sharedAdapter} from '../src/providers/shared.js';

test('S8 shared entry snapshot routing setup repair removal stays workspace local',async()=>{
  const f=await approvedFixture({providers:['codex','claude'],sharedPlan:sharedAdapter.plan});
  const sibling=await workspaceHashes(f.b);
  const installed=await applyLifecycle({command:'setup',wrapper:f.a,prepared:f.prepared,approval:f.approval},f.registry);
  assert.equal(installed.status,'ready',JSON.stringify(installed));
  const entry=await readFile(path.join(f.a,'AGENTS.md'));
  const state=(await readState(path.join(f.a,'.pipeline/state.json'))).value;
  assert.ok(entry.toString().includes(state.active.snapshot.path+'/resources'));
  assert.ok((await readFile(path.join(f.a,state.active.snapshot.path,'resources/process.md'))).length>0);
  assert.equal((await inspectInstallation(f.a)).ready,true);
  // Move only a synthetic installed entry to simulate loss; keep its bytes for comparison.
  await rename(path.join(f.a,'AGENTS.md'),path.join(f.root,'saved-entry.md'));
  const repair=await prepareRepairPlan(f.a,f.registry),lock=await acquireWorkspaceLock(f.a);
  try{await applyRepair(lock,repair,{decision:'approve',preparedDigest:repair.digest},f.registry);}finally{await lock.release();}
  assert.deepEqual(await readFile(path.join(f.a,'AGENTS.md')),entry);
  const removal=await prepareRemoval(f.a,f.registry),removeLock=await acquireWorkspaceLock(f.a);
  try{await applyRemoval(removeLock,removal,{decision:'approve',preparedDigest:removal.digest},f.registry);}finally{await removeLock.release();}
  await assert.rejects(readFile(path.join(f.a,'AGENTS.md')),e=>e.code==='ENOENT');
  assert.deepEqual(await workspaceHashes(f.b),sibling);
});

test('S8 shared entry repair preserves workspace source override after manifest loss',async()=>{
  const f=await approvedFixture({sharedPlan:sharedAdapter.plan});
  const manifest=JSON.parse(await readFile(f.manifestPath,'utf8'));
  // Existing verified fixture resource is a valid plain-text custom entry.
  manifest.agentsDocument={mode:'source',path:'resources/process.md'};
  await writeFile(f.manifestPath,JSON.stringify(manifest));
  const prepared=await preparePlan({wrapper:f.a,manifestPath:f.manifestPath,tempRoot:f.root,...f.registry});
  const installed=await applyLifecycle({command:'setup',wrapper:f.a,prepared,approval:{decision:'approve',preparedDigest:prepared.digest}},f.registry);
  assert.equal(installed.status,'ready',JSON.stringify(installed));
  const entry=await readFile(path.join(f.a,'AGENTS.md'));
  await rename(f.manifestPath,path.join(f.root,'saved-workspace.json'));
  await rename(path.join(f.a,'AGENTS.md'),path.join(f.root,'saved-entry.md'));
  const repair=await prepareRepairPlan(f.a,f.registry),lock=await acquireWorkspaceLock(f.a);
  try{await applyRepair(lock,repair,{decision:'approve',preparedDigest:repair.digest},f.registry);}finally{await lock.release();}
  assert.deepEqual(await readFile(path.join(f.a,'AGENTS.md')),entry);
});

test('S8 TOML lifecycle setup update doctor repair removal preserves foreign bytes',async()=>{
  const name='.codex/config.toml',pointer='/agents/unity_review';
  const foreign='# personal\r\nmodel="user-choice"\r\n[agents.foreign]\r\ndescription="mine"\r\n';
  let value={description:'review',config_file:'agents/review.toml'};
  const plan=()=>[{path:name,owner:'codex',kind:'toml-fields',fields:[{pointer,present:true,value}]}];
  const f=await approvedFixture({seed:{[name]:foreign},codex:{plan}}),other=await workspaceHashes(f.b);
  assert.equal((await applyLifecycle({command:'setup',wrapper:f.a,prepared:f.prepared,approval:f.approval},f.registry)).status,'ready');
  const filename=path.join(f.a,name);
  assert.ok((await readFile(filename,'utf8')).startsWith(foreign));
  await writeFile(filename,(await readFile(filename,'utf8'))+'# later foreign comment\r\n');
  assert.equal((await inspectInstallation(f.a)).ready,true);
  value={...value,description:'updated'};
  const update=await prepareLifecycle({command:'update',wrapper:f.a,tempRoot:f.root},f.registry);
  assert.equal((await applyLifecycle({command:'update',wrapper:f.a,prepared:update,approval:{decision:'approve',preparedDigest:update.digest}},f.registry)).status,'ready');
  assert.equal(readTOMLField(await readFile(filename),pointer).value.description,'updated');
  const missing=reconcileTOMLFields(await readFile(filename),[{pointer,present:false,managedHash:contractDigest(value)}]);
  await writeFile(filename,missing.bytes);
  const repair=await prepareRepairPlan(f.a,f.registry),lock=await acquireWorkspaceLock(f.a);
  try{await applyRepair(lock,repair,{decision:'approve',preparedDigest:repair.digest},f.registry);}finally{await lock.release();}
  assert.equal((await inspectInstallation(f.a)).ready,true);
  const removal=await prepareRemoval(f.a,f.registry),removeLock=await acquireWorkspaceLock(f.a);
  try{await applyRemoval(removeLock,removal,{decision:'approve',preparedDigest:removal.digest},f.registry);}finally{await removeLock.release();}
  const final=await readFile(filename,'utf8');assert.ok(final.startsWith(foreign));assert.ok(final.includes('# later foreign comment'));
  assert.equal(readTOMLField(Buffer.from(final),pointer).present,false);
  assert.deepEqual(await workspaceHashes(f.b),other);
});

test('S8 TOML takeover backup restores original value and preserves foreign data',async()=>{
  const name='.codex/config.toml',pointer='/mcp_servers/unity_probe';
  const original={command:'original'},value={command:'replacement',args:['never-executed']};
  const foreign='# untouched\nmodel="user"\n';
  const seed=reconcileTOMLFields(Buffer.from(foreign),[{pointer,present:true,value:original}]).bytes;
  let takeover={beforeHash:contractDigest(original),desiredHash:contractDigest(value)};
  const plan=()=>[{path:name,owner:'codex',kind:'toml-fields',fields:[{pointer,present:true,value,...(takeover?{takeover}:{})}]}];
  const f=await approvedFixture({seed:{[name]:seed},codex:{plan}});
  const result=await applyLifecycle({command:'setup',wrapper:f.a,prepared:f.prepared,approval:f.approval},f.registry);
  assert.equal(result.status,'ready');takeover=null;
  const removal=await prepareRemoval(f.a,f.registry),lock=await acquireWorkspaceLock(f.a);
  try{await applyRemoval(lock,removal,{decision:'approve',preparedDigest:removal.digest},f.registry);}finally{await lock.release();}
  const bytes=await readFile(path.join(f.a,name));assert.ok(bytes.toString().startsWith(foreign));
  assert.deepEqual(JSON.parse(JSON.stringify(readTOMLField(bytes,pointer).value)),original);
});

for(const mode of ['setup','remove','switch','switch-before','switch-between','switch-completed','switch-repeat'])test('CLI continuation exact pending operation '+mode,async()=>{
  const f=await approvedFixture({sharedPlan:c=>[{path:'AGENTS.md',owner:'shared',kind:'file',bytes:Buffer.from(c.pipeline.id)}]});
  let oldPath;
  if(mode!=='setup')await applyLifecycle({command:'setup',wrapper:f.a,prepared:f.prepared,approval:f.approval},f.registry);
  if(mode.startsWith('switch')) {
    const incoming=await approvedFixture({pipelineId:'replacement'}),manifest=JSON.parse(await readFile(incoming.manifestPath,'utf8'));
    manifest.pipeline.path=path.relative(f.a,path.resolve(incoming.a,manifest.pipeline.path)).split(path.sep).join('/');
    const manifestPath=path.join(f.a,'incoming.json');await writeFile(manifestPath,JSON.stringify(manifest));
    const prepared=await prepareSwitch({wrapper:f.a,manifestPath,tempRoot:f.root},f.registry),approval={decision:'approve',preparedDigest:prepared.digest};
    const previous=(await readState(path.join(f.a,'.pipeline/state.json'))).value,lock=await acquireWorkspaceLock(f.a);
    try {
      const saved=await persistSwitchRecovery(lock,prepared,approval,f.registry,previous);oldPath=saved.recoveryPath;
      await markSwitchPending(lock,saved.recoveryPath,saved.recoveryHash,approval,f.registry);
      if(mode==='switch')await assert.rejects(()=>executeSwitchPhase(lock,saved.recoveryPath,saved.recoveryHash,approval,'remove-old',{
          boundary:async stage=>{if(stage==='target-written')throw Error('synthetic stop');}
        }));
      else if(mode!=='switch-before') {
        await executeSwitchPhase(lock,saved.recoveryPath,saved.recoveryHash,approval,'remove-old');
        if(mode==='switch-completed')await executeSwitchPhase(lock,saved.recoveryPath,saved.recoveryHash,approval,'install-new');
        if(mode==='switch-repeat') {
          const nextPreview=await prepareSwitchContinuation(f.a,oldPath),decision={decision:'approve',previewDigest:nextPreview.digest};
          const next=await persistSwitchContinuationRecovery(lock,nextPreview,decision);
          await markSwitchContinuationPending(lock,next.recoveryPath,next.recoveryHash,decision);oldPath=next.recoveryPath;
        }
      }
    }finally{await lock.release();}
  }else {
    const prepared=mode==='remove'?await prepareRemoval(f.a,f.registry):f.prepared,lock=await acquireWorkspaceLock(f.a);
    try {
      const options={boundary:async phase=>{if(phase==='write')throw Error('synthetic stop');}};
      if(mode==='setup')await assert.rejects(()=>applyPrepared(lock,prepared,f.approval,f.registry,null,options));
      else {
        const result=await applyRemoval(lock,prepared,{decision:'approve',preparedDigest:prepared.digest},f.registry,
          {ioBoundary:async e=>{if(e.purpose==='target' && e.phase==='deleted')throw Error('synthetic stop');}});
        oldPath=result.recoveryPath;
      }
    }finally{await lock.release();}
    oldPath??=await recoveryFile(f.a);
  }
  const before=await workspaceHashes(f.a),other=await workspaceHashes(f.b),oldBytes=await readFile(path.join(f.a,oldPath));
  const invoke=async(args,stderr=()=>{})=>{let out='';const code=await runCli(args,{registry:f.registry,stdout:s=>{out+=s;},stderr});return {code,out};};
  const preview=await invoke(['continue','--workspace',f.a,'--recovery',oldPath]);assert.equal(preview.code,0,preview.out);
  assert.deepEqual(await workspaceHashes(f.a),before);
  const prepared=JSON.parse(preview.out),filename=path.join(f.root,'continue.json');await writeFile(filename,preview.out);
  if(mode.startsWith('switch-')) {
    assert.equal(prepared.uncertain,null);
    assert.deepEqual(prepared.remaining.map(p=>p.phase),mode==='switch-before'?['remove-old','install-new']:mode==='switch-completed'?[]:['install-new']);
  }
  const args=['continue','--workspace',f.a,'--apply','--preview',filename];
  const wrong=await invoke(['continue','--workspace',f.b,'--apply','--preview',filename]);assert.equal(wrong.code,1);
  assert.deepEqual(await workspaceHashes(f.b),other);
  await writeFile(filename,JSON.stringify({...prepared,digest:'wrong'}));assert.equal((await invoke(args)).code,1);
  assert.deepEqual(await workspaceHashes(f.a),before);
  await writeFile(filename,preview.out);const events=[];
  const applied=await invoke(args,s=>events.push(JSON.parse(s)));assert.equal(applied.code,0,applied.out);
  const result=JSON.parse(applied.out);assert.equal(result.status,mode==='remove'?'not-installed':'ready');
  assert.equal(result.lockRelease,'released');assert.ok(result.journal.path);assert.ok(result.recovery.path);
  assert.ok(events.some(e=>e.kind==='journal-location'));assert.notEqual(result.recovery.path,path.join(f.a,oldPath));
  assert.deepEqual(await readFile(path.join(f.a,oldPath)),oldBytes);assert.deepEqual(await workspaceHashes(f.b),other);
  assert.deepEqual((await inspectHistory(f.a)).diagnostics,[]);
  const after=await workspaceHashes(f.a);
  for(const [name,hash] of Object.entries(before))if(!['AGENTS.md','.pipeline/state.json'].includes(name))assert.equal(after[name],hash,name);
  assert.equal((await invoke(args)).code,1);assert.deepEqual(await workspaceHashes(f.a),after);
});

for(const interrupted of [false,true])test('CLI switch two phases interrupted='+interrupted,async()=>{
  const f=await approvedFixture({sharedPlan:c=>[{path:'AGENTS.md',owner:'shared',kind:'file',bytes:Buffer.from(c.pipeline.id)}]}),
    incoming=await approvedFixture({pipelineId:'replacement'});
  await applyLifecycle({command:'setup',wrapper:f.a,prepared:f.prepared,approval:f.approval},f.registry);
  const manifest=JSON.parse(await readFile(incoming.manifestPath,'utf8'));
  manifest.pipeline.path=path.relative(f.a,path.resolve(incoming.a,manifest.pipeline.path)).split(path.sep).join('/');
  const manifestPath=path.join(f.a,'incoming.json');await writeFile(manifestPath,JSON.stringify(manifest));
  const before=await workspaceHashes(f.a),other=await workspaceHashes(f.b),file=path.join(f.root,'switch-preview.json');
  const invoke=async(args,stop=false)=>{
    let out='',err='';const code=await runCli(args,{registry:f.registry,stdout:s=>{out+=s;},stderr:s=>{
      err+=s;const e=JSON.parse(s);
      if(stop && e.kind==='phase-start' && e.phase==='install-new')throw Error('synthetic private interruption');
    }});return {code,out,err};
  };
  const preview=await invoke(['switch','--workspace',f.a,'--manifest',manifestPath]);
  assert.equal(preview.code,0,preview.err);assert.deepEqual(await workspaceHashes(f.a),before);
  const prepared=JSON.parse(preview.out);assert.deepEqual(prepared.preview.phases.map(p=>p.name),['remove-old','install-new']);
  await writeFile(file,preview.out);
  const mismatch=await invoke(['switch','--workspace',f.b,'--apply','--preview',file]);
  assert.equal(mismatch.code,1);assert.deepEqual(await workspaceHashes(f.b),other);
  const forged=structuredClone(prepared);forged.digest=sha256(Buffer.from('forged'));await writeFile(file,JSON.stringify(forged));
  assert.equal((await invoke(['switch','--workspace',f.a,'--apply','--preview',file])).code,1);
  assert.deepEqual(await workspaceHashes(f.a),before);await writeFile(file,preview.out);
  const result=await invoke(['switch','--workspace',f.a,'--apply','--preview',file],interrupted),report=JSON.parse(result.out);
  assert.equal(result.code,interrupted?1:0,result.out+result.err);assert.equal(report.lockRelease,'released');
  assert.ok(result.err.includes('journal-location'));assert.ok(result.err.includes('recovery-location'));
  assert.equal(result.out.includes('synthetic private interruption'),false);
  const state=(await readState(path.join(f.a,'.pipeline/state.json'))).value;
  if(interrupted) {
    assert.equal(state.status,'needs-reconciliation');assert.equal(state.active.pipelineId,'fixture');
    assert.deepEqual(report.completedPhases,['remove-old']);assert.equal((await inspectInstallation(f.a)).ready,false);
    await assert.rejects(()=>readFile(path.join(f.a,'AGENTS.md')),e=>e.code==='ENOENT');
    const after=await workspaceHashes(f.a);
    assert.equal((await invoke(['switch','--workspace',f.a,'--apply','--preview',file])).code,1);
    assert.deepEqual(await workspaceHashes(f.a),after);
  }else {
    assert.equal(state.status,'ready');assert.equal(state.active.pipelineId,'replacement');
    assert.deepEqual(report.completedPhases,['remove-old','install-new']);
    assert.equal(await readFile(path.join(f.a,'AGENTS.md'),'utf8'),'replacement');
    assert.equal((await inspectInstallation(f.a)).ready,true);assert.deepEqual((await inspectHistory(f.a)).diagnostics,[]);
  }
  const after=await workspaceHashes(f.a);
  for(const [name,hash] of Object.entries(before))if(!['AGENTS.md','.pipeline/state.json'].includes(name))assert.equal(after[name],hash,name);
  assert.deepEqual(await workspaceHashes(f.b),other);
});

test('CLI maintenance repairs offline then removes selected providers without foreign loss',async()=>{
  const f=await approvedFixture({providers:['codex','claude'],
    codex:{plan:()=>[{path:'.codex/test.json',owner:'codex',kind:'json-fields',fields:[{pointer:'/ours',present:true,value:true}]}]},
    claude:{plan:()=>[{path:'.claude/skill.md',owner:'claude',kind:'file',bytes:Buffer.from('claude skill')}]}});
  await applyLifecycle({command:'setup',wrapper:f.a,prepared:f.prepared,approval:f.approval},f.registry);
  await rename(f.manifestPath,path.join(f.root,'offline-manifest.json'));
  await writeFile(path.join(f.a,'.codex/test.json'),'{"foreign":"keep"}');
  const other=await workspaceHashes(f.b),file=path.join(f.root,'maintenance.json');
  const invoke=async(verb,args=[],workspace=f.a)=>{
    let out='',err='';const code=await runCli([verb,'--workspace',workspace,...args],
      {registry:f.registry,stdout:s=>{out+=s;},stderr:s=>{err+=s;}});return {code,out,err};
  };
  let before=await workspaceHashes(f.a);
  const repair=await invoke('repair');assert.equal(repair.code,0,repair.err);
  assert.deepEqual(await workspaceHashes(f.a),before);await writeFile(file,repair.out);
  const mismatch=await invoke('repair',['--apply','--preview',file],f.b);
  assert.equal(mismatch.code,1);assert.deepEqual(await workspaceHashes(f.b),other);
  const forged=JSON.parse(repair.out);forged.digest=sha256(Buffer.from('forged'));
  await writeFile(file,JSON.stringify(forged));
  assert.equal((await invoke('repair',['--apply','--preview',file])).code,1);
  assert.deepEqual(await workspaceHashes(f.a),before);await writeFile(file,repair.out);
  const fixed=await invoke('repair',['--apply','--preview',file]);assert.equal(fixed.code,0,fixed.out+fixed.err);
  assert.ok(fixed.err.includes('journal-location'));assert.ok(fixed.err.includes('recovery-location'));
  assert.deepEqual(JSON.parse(await readFile(path.join(f.a,'.codex/test.json'),'utf8')),{foreign:'keep',ours:true});
  before=await workspaceHashes(f.a);
  const partial=await invoke('remove',['--providers','codex']);assert.equal(partial.code,0,partial.err);
  assert.deepEqual(await workspaceHashes(f.a),before);await writeFile(file,partial.out);
  const wrong=await invoke('repair',['--apply','--preview',file]);assert.equal(wrong.code,1);
  assert.deepEqual(await workspaceHashes(f.a),before);
  const removed=await invoke('remove',['--apply','--preview',file]);assert.equal(removed.code,0,removed.out+removed.err);
  assert.deepEqual((await readState(path.join(f.a,'.pipeline/state.json'))).value.active.providers,['claude']);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.a,'.codex/test.json'),'utf8')),{foreign:'keep'});
  assert.equal(await readFile(path.join(f.a,'AGENTS.md'),'utf8'),'entry');
  assert.equal(await readFile(path.join(f.a,'.claude/skill.md'),'utf8'),'claude skill');
  const full=await invoke('remove');assert.equal(full.code,0,full.err);await writeFile(file,full.out);
  const final=await invoke('remove',['--apply','--preview',file]);assert.equal(final.code,0,final.out+final.err);
  assert.equal(JSON.parse(final.out).status,'not-installed');
  assert.equal((await inspectInstallation(f.a)).status,'not-installed');
  assert.deepEqual(JSON.parse(await readFile(path.join(f.a,'.codex/test.json'),'utf8')),{foreign:'keep'});
  assert.deepEqual(await workspaceHashes(f.b),other);
});

test('CLI maintenance reporting failure stops before owned target writes',async()=>{
  const f=await approvedFixture();
  await applyLifecycle({command:'setup',wrapper:f.a,prepared:f.prepared,approval:f.approval},f.registry);
  let preview='';
  assert.equal(await runCli(['remove','--workspace',f.a],{registry:f.registry,stdout:s=>{preview+=s;},stderr(){}}),0);
  const file=path.join(f.root,'removal.json');await writeFile(file,preview);
  const entry=await readFile(path.join(f.a,'AGENTS.md')),state=await readFile(path.join(f.a,'.pipeline/state.json'));
  let out='';const code=await runCli(['remove','--workspace',f.a,'--apply','--preview',file],
    {registry:f.registry,stdout:s=>{out+=s;},stderr(){throw Error('private transport failure');}});
  assert.equal(code,1);assert.equal(JSON.parse(out).status,'failed');
  assert.equal(JSON.parse(out).outputError,'maintenance.report');assert.equal(out.includes('private transport failure'),false);
  assert.deepEqual(await readFile(path.join(f.a,'AGENTS.md')),entry);
  assert.deepEqual(await readFile(path.join(f.a,'.pipeline/state.json')),state);
  assert.equal(JSON.parse(out).lockRelease,'released');
});

test('CLI lifecycle routes exact setup and update through trusted registry and preserves isolation',async()=>{
  const f=await approvedFixture(),before=await workspaceHashes(f.a),other=await workspaceHashes(f.b);
  const invoke=async(args,options={})=>{
    let out='',err='';const code=await runCli(args,{registry:f.registry,stdout:s=>{out+=s;},stderr:s=>{err+=s;},...options});
    return {code,out,err};
  };
  const file=path.join(f.root,'cli-prepared.json');
  const preview=await invoke(['setup','--workspace',f.a,'--manifest',f.manifestPath]);
  assert.equal(preview.code,0,preview.err);const prepared=JSON.parse(preview.out);
  assert.equal(prepared.preview.plan.command,'setup');assert.deepEqual(await workspaceHashes(f.a),before);
  await writeFile(file,preview.out);
  const mismatched=await invoke(['setup','--workspace',f.b,'--apply','--preview',file]);
  assert.equal(mismatched.code,1);assert.equal(JSON.parse(mismatched.out).error,'lifecycle.prepared-binding');
  assert.deepEqual(await workspaceHashes(f.b),other);
  const installed=await invoke(['setup','--workspace',f.a,'--apply','--preview',file]);
  assert.equal(installed.code,0,installed.err);assert.equal(JSON.parse(installed.out).status,'ready');
  assert.ok(installed.err.includes('journal-location'));assert.ok(installed.err.includes('recovery-location'));
  assert.equal((await inspectInstallation(f.a)).ready,true);
  const updateBefore=await workspaceHashes(f.a);
  const update=await invoke(['update','--workspace',f.a]);
  assert.equal(update.code,0,update.err);assert.deepEqual(await workspaceHashes(f.a),updateBefore);
  await writeFile(file,update.out);
  const wrongVerb=await invoke(['setup','--workspace',f.a,'--apply','--preview',file]);
  assert.equal(wrongVerb.code,1);assert.equal(JSON.parse(wrongVerb.out).error,'lifecycle.prepared-binding');
  assert.deepEqual(await workspaceHashes(f.a),updateBefore);
  const changed=JSON.parse(update.out);changed.digest=sha256(Buffer.from('forged'));
  await writeFile(file,JSON.stringify(changed));
  const invalid=await invoke(['update','--workspace',f.a,'--apply','--preview',file]);
  assert.equal(invalid.code,1);assert.notEqual(JSON.parse(invalid.out).status,'ready');
  assert.deepEqual(await workspaceHashes(f.a),updateBefore);
  await writeFile(file,update.out);
  const applied=await invoke(['update','--workspace',f.a,'--apply','--preview',file]);
  assert.equal(applied.code,0,applied.err);assert.equal((await inspectInstallation(f.a)).ready,true);
  const again=await invoke(['update','--workspace',f.a]);await writeFile(file,again.out);
  const outputFailed=await invoke(['update','--workspace',f.a,'--apply','--preview',file],{stdout(){throw Error('private output error');}});
  assert.equal(outputFailed.code,2);assert.equal(outputFailed.err.includes('private output error'),false);
  const events=outputFailed.err.trim().split('\n').map(s=>JSON.parse(s));
  assert.equal(events.find(e=>e.kind==='operation-result').status,'ready');
  assert.equal((await inspectInstallation(f.a)).ready,true);
  assert.deepEqual(await workspaceHashes(f.b),other);
});

for(const mode of ['combined','success','interrupted','reference-drift','cli','startup','startup-stale','startup-unapproved','startup-output','startup-main-failure','startup-auto','startup-auto-conflict','startup-auto-drift'])test('retention cleanup '+mode+' uses exact unreferenced group and protects current run',async()=>{
  const f=await approvedFixture();
  assert.equal((await applyLifecycle({command:'setup',wrapper:f.a,prepared:f.prepared,approval:f.approval},f.registry)).status,'ready');
  const statePath=path.join(f.a,'.pipeline/state.json'),originalState=await readFile(statePath);
  const update=await prepareLifecycle({command:'update',wrapper:f.a,manifestPath:f.manifestPath,tempRoot:f.root},f.registry);
  const args={command:'update',wrapper:f.a,prepared:update,approval:{decision:'approve',preparedDigest:update.digest}};
  const abandoned=await applyLifecycle(args,f.registry);assert.equal(abandoned.status,'ready');
  // Synthetic branch fixture: reset only state to the identical pre-noop bytes.
  await writeFile(statePath,originalState);
  const active=await applyLifecycle(args,f.registry);assert.equal(active.status,'ready');
  if(mode.startsWith('startup-auto')) {
    const policyPreview=await previewRetentionPolicy(f.a,{action:'set',mode:'automatic',journals:{maxAgeDays:0,maxJournals:0,maxDeletesPerRun:1}});
    const policyLock=await acquireWorkspaceLock(f.a);
    try{await applyRetentionPolicy(policyLock,policyPreview,{decision:'approve',previewDigest:policyPreview.digest});}
    finally{await policyLock.release();}
  }
  const before=await workspaceHashes(f.a),other=await workspaceHashes(f.b);
  const options={policy:{maxAgeDays:0,maxJournals:0,maxDeletesPerRun:1},now:Date.now()+1000};
  const preview=await scanRetention(f.a,options);
  assert.equal(preview.complete,true);assert.deepEqual(preview.retention.selected.map(g=>g.id),[abandoned.journal.runId]);
  assert.ok(preview.groups.find(g=>g.id===active.journal.runId).protectionReasons.includes('current-state'));
  const protectedPreview=await scanRetention(f.a,{...options,currentRuns:[abandoned.journal.runId]});
  assert.deepEqual(protectedPreview.retention.selected,[]);
  assert.deepEqual(await workspaceHashes(f.a),before);assert.deepEqual(await workspaceHashes(f.b),other);
  if(mode==='combined') {
    const limits={journals:{maxAgeDays:0,maxJournals:0},cleanupReceipts:{maxAgeDays:0,maxReceipts:0},maxDeletesPerRun:1};
    const lock=await acquireWorkspaceLock(f.a);let oldReceipt;
    try {
      const empty=await scanRetention(f.a,{...options,policy:{...options.policy,maxDeletesPerRun:0}});
      oldReceipt=await applyRetention(lock,empty,{decision:'approve',previewDigest:empty.digest});
      assert.equal(oldReceipt.receiptCreated,false);
      // Historical v1 no-work receipt, deliberately seeded to test migration.
      const legacyId='00000000-0000-0000-0000-000000000001';
      oldReceipt={receiptPath:path.join(f.a,'.pipeline/cleanup',legacyId+'.json')};
      await mkdir(path.dirname(oldReceipt.receiptPath),{recursive:true});
      await writeFile(oldReceipt.receiptPath,JSON.stringify({schemaVersion:1,kind:'retention-result',runId:legacyId,
        workspace:f.a,previewDigest:empty.digest,policy:empty.retention.policy,status:'completed',recoverable:false,
        groups:[],removedFiles:[],removedDirectories:[],completedGroups:[],currentFile:null,error:null,reclaimedBytes:0}));
      await utimes(oldReceipt.receiptPath,1000,1000);
      const configured=await previewRetentionPolicy(f.a,{action:'set',mode:'automatic',...limits});
      await applyRetentionPolicy(lock,configured,{decision:'approve',previewDigest:configured.digest});
    }finally{await lock.release();}
    const first=await scanCombinedRetention(f.a,{policy:limits,now:Date.now()});
    assert.equal(first.retention.selected[0].type,'cleanup-receipt');
    assert.ok(first.retention.deferred.some(g=>g.type==='journal'&&g.id===abandoned.journal.runId));
    for(const expected of ['cleanup-receipt','journal']) {
      const next=await prepareLifecycle({command:'update',wrapper:f.a,manifestPath:f.manifestPath,tempRoot:f.root},f.registry);
      const result=await applyLifecycle({command:'update',wrapper:f.a,prepared:next,approval:{decision:'approve',preparedDigest:next.digest}},f.registry);
      assert.equal(result.status,'ready',JSON.stringify(result));assert.equal(result.cleanup.removedGroups,1);
      const receipt=JSON.parse(await readFile(result.cleanup.receiptPath,'utf8'));
      assert.equal(receipt.schemaVersion,2);assert.equal(receipt.groups.length,1);assert.equal(receipt.groups[0].type,expected);
      assert.equal((await inspectInstallation(f.a)).ready,true);
    }
    assert.deepEqual(await workspaceHashes(f.b),other);return;
  }
  if(mode.startsWith('startup')) {
    const next=await prepareLifecycle({command:'update',wrapper:f.a,manifestPath:f.manifestPath,tempRoot:f.root},f.registry);
    const events=[],retention={preview,approval:{decision:'approve',previewDigest:preview.digest}};
    if(mode==='startup-stale')retention.approval.previewDigest=sha256(Buffer.from('stale'));
    const result=await applyLifecycle({command:'update',wrapper:f.a,prepared:next,
      approval:mode==='startup-unapproved'?null:{decision:'approve',preparedDigest:next.digest}},f.registry,{
      retention:mode.startsWith('startup-auto') && mode!=='startup-auto-conflict'?null:retention,report:async event=>{
        events.push(event);
        if(mode==='startup-auto-drift' && event.kind==='startup-retention') {
          const current=await readRetentionPolicy(f.a);
          await writeFile(current.path,JSON.stringify({...current.policy,mode:'disabled'}));
        }
        if(mode==='startup-output' && event.kind==='startup-retention')throw Error('closed output');
        if(mode==='startup-main-failure' && event.kind==='cleanup-result')
          f.registry.sharedAdapter.plan=async()=>{throw Error('synthetic adapter failure after cleanup');};
      }
    });
    assert.deepEqual(await workspaceHashes(f.b),other);assert.equal(result.lockRelease,'released');
    if(mode==='startup-auto-conflict') {
      assert.equal(result.error,'lifecycle.retention-conflict');assert.equal(result.cleanup,undefined);
      assert.deepEqual(await workspaceHashes(f.a),before);
    }else if(mode==='startup-auto-drift') {
      assert.equal(result.status,'not-started');assert.equal(result.cleanup.error,'retention-apply.policy-drift');
      assert.equal(result.cleanup.removedFiles,0);assert.equal(result.journal,null);
      for(const group of preview.groups)for(const file of group.files)
        assert.equal(sha256(await readFile(path.join(f.a,file.path))),file.hash);
    }else if(mode==='startup-main-failure') {
      assert.equal(result.status,'failed');assert.equal(result.error,'lifecycle.io');
      assert.equal(result.cleanup.status,'completed');assert.equal(result.cleanup.removedGroups,1);
      assert.equal(result.journal,null);assert.equal(result.recovery,null);
      assert.equal((await inspectInstallation(f.a)).ready,true);
    }else if(mode==='startup' || mode==='startup-auto') {
      assert.equal(result.status,'ready');assert.equal(result.cleanup.status,'completed');
      assert.equal(result.cleanup.removedGroups,1);assert.equal((await inspectInstallation(f.a)).ready,true);
      const announcement=events.findIndex(e=>e.kind==='startup-retention');
      assert.ok(announcement>=0);assert.deepEqual(events[announcement].policy,options.policy);
      assert.ok(events.findIndex(e=>e.kind==='cleanup-result')<events.findIndex(e=>e.kind==='journal-location'));
      assert.equal(events.at(-1).cleanup.receiptPath,result.cleanup.receiptPath);
      if(mode==='startup-auto') {
        const receipt=JSON.parse(await readFile(result.cleanup.receiptPath,'utf8'));
        assert.equal(receipt.authorization.decision,'workspace-policy');
        const repeated=await prepareLifecycle({command:'update',wrapper:f.a,manifestPath:f.manifestPath,tempRoot:f.root},f.registry);
        const again=await applyLifecycle({command:'update',wrapper:f.a,prepared:repeated,
          approval:{decision:'approve',preparedDigest:repeated.digest}},f.registry);
        assert.equal(again.status,'ready');assert.equal(again.cleanup.removedGroups,0);
      }
    }else {
      assert.equal(result.journal,null);assert.equal(result.recovery,null);
      if(mode==='startup-unapproved')assert.equal(result.cleanup,undefined);
      else {assert.equal(result.status,'not-started');assert.equal(result.cleanup.status,'failed');}
      assert.deepEqual(await workspaceHashes(f.a),before);
    }
    return;
  }
  if(mode==='cli') {
    const previewFile=path.join(f.root,'cleanup-preview.json');await writeFile(previewFile,JSON.stringify(preview));
    const cli=fileURLToPath(new URL('../src/cli.js',import.meta.url));
    const result=spawnSync(process.execPath,[cli,'logs','clean','--workspace',f.a,'--apply','--preview',previewFile,'--json'],
      {encoding:'utf8',windowsHide:true,timeout:120000});
    assert.equal(result.status,0,result.stderr);const output=JSON.parse(result.stdout);
    assert.equal(output.removedGroups,1);assert.equal(output.status,'completed');
    assert.equal((await inspectInstallation(f.a)).ready,true);assert.deepEqual(await workspaceHashes(f.b),other);return;
  }
  const lock=await acquireWorkspaceLock(f.a);
  try {
    const lockedBefore=await workspaceHashes(f.a);
    await assert.rejects(()=>applyRetention(lock,preview,{decision:'approve',previewDigest:sha256(Buffer.from('wrong'))}),e=>e.code==='retention-apply.approval');
    assert.deepEqual(await workspaceHashes(f.a),lockedBefore);
    const reports=[];
    const result=await applyRetention(lock,preview,{decision:'approve',previewDigest:preview.digest},{
      report:async event=>reports.push(event),
      boundary:async stage=>{
        if(mode==='interrupted' && stage==='file-removed')throw Error('synthetic cleanup interruption');
        if(mode==='reference-drift' && stage==='before-file') {
          const activePath=path.join(f.a,'.pipeline/transactions',active.journal.runId,'recovery.json');
          await writeFile(activePath,(await readFile(activePath,'utf8'))+' '); // changed external record fixture
        }
      }
    });
    assert.equal(result.recoverable,false);assert.equal(result.receiptCreated,true);
    assert.equal(reports[0].status,'planned');assert.equal(reports.at(-1).kind,'cleanup-result');
    const receipt=JSON.parse(await readFile(result.receiptPath,'utf8'));
    assert.equal(receipt.status,result.status);
    assert.deepEqual(await workspaceHashes(f.b),other);
    if(mode==='success') {
      assert.equal(result.status,'completed');assert.equal(result.removedGroups,1);
      const group=preview.groups.find(g=>g.id===abandoned.journal.runId);
      assert.equal(result.reclaimedBytes,group.bytes);assert.equal(result.removedFiles,group.files.length);
      const after=await workspaceHashes(f.a),deleted=new Set([...group.paths,...group.files.map(file=>file.path)]);
      for(const [name,hash] of Object.entries(lockedBefore)) {
        if(deleted.has(name))assert.equal(after[name],undefined);else assert.equal(after[name],hash,'preserved '+name);
      }
      assert.deepEqual((await inspectHistory(f.a)).diagnostics,[]);
      assert.equal((await scanRetention(f.a,options)).retention.selected.length,0);
    }else {
      assert.equal(result.status,'failed');assert.equal(result.removedGroups,0);
      assert.equal(result.removedFiles,mode==='interrupted'?1:0);
      if(mode==='interrupted') {
        assert.equal(receipt.removedFiles.length,1);assert.ok(receipt.currentFile);
        assert.equal((await scanRetention(f.a,options)).complete,false);
      }else assert.equal(result.error,'retention-apply.drift');
    }
  }finally{await lock.release();}
});

for(const mode of ['retry','readback','interrupted','interrupted-before','interrupted-remove'])test('continuation lifecycle '+mode+' preserves evidence and selects exact activation',async()=>{
  const f=await approvedFixture({sharedPlan:c=>[{path:'AGENTS.md',owner:'shared',kind:'file',bytes:Buffer.from(c.pipeline.id)}]}),incoming=await approvedFixture({pipelineId:'replacement'});
  await applyLifecycle({command:'setup',wrapper:f.a,prepared:f.prepared,approval:f.approval},f.registry);
  const previous=(await readState(path.join(f.a,'.pipeline/state.json'))).value;
  const manifest=JSON.parse(await readFile(incoming.manifestPath,'utf8'));
  manifest.pipeline.path=path.relative(f.a,path.resolve(incoming.a,manifest.pipeline.path)).split(path.sep).join('/');
  const manifestPath=path.join(f.a,'incoming.json');await writeFile(manifestPath,JSON.stringify(manifest));
  const prepared=await prepareSwitch({wrapper:f.a,manifestPath,tempRoot:f.root},f.registry),approval={decision:'approve',preparedDigest:prepared.digest};
  const lock=await acquireWorkspaceLock(f.a);let released=false;
  try {
    const saved=await persistSwitchRecovery(lock,prepared,approval,f.registry,previous);
    await markSwitchPending(lock,saved.recoveryPath,saved.recoveryHash,approval,f.registry);
    await assert.rejects(()=>executeSwitchPhase(lock,saved.recoveryPath,saved.recoveryHash,approval,'remove-old',{
      boundary:async stage=>{if(stage===(mode==='readback'?'target-written':'intent'))throw Error('original interruption');}
    }),/original interruption/);
    const oldJournal=await workspaceHashes(path.join(f.a,(await readSwitchRecovery(f.a,saved.recoveryPath)).record.journal));
    const preview=await prepareSwitchContinuation(f.a,saved.recoveryPath),decision={decision:'approve',previewDigest:preview.digest};
    const next=await persistSwitchContinuationRecovery(lock,preview,decision);
    await markSwitchContinuationPending(lock,next.recoveryPath,next.recoveryHash,decision);
    assert.equal((await inspectInstallation(f.a)).recovery.path,next.recoveryPath);
    await assert.rejects(()=>activateSwitchContinuation(lock,next.recoveryPath,next.recoveryHash,decision),e=>e.code==='switch-continuation-runtime.incomplete');
    await assert.rejects(()=>executeSwitchContinuationPhase(lock,next.recoveryPath,next.recoveryHash,decision,'install-new'),e=>e.code==='switch-continuation-runtime.state');
    await assert.rejects(()=>executeSwitchContinuationPhase(lock,next.recoveryPath,next.recoveryHash,{decision:'approve',previewDigest:sha256(Buffer.from('wrong'))},'remove-old'),e=>e.code==='switch-continuation-runtime.approval');
    const events=[];
    if(mode!=='interrupted-remove') {
      await executeSwitchContinuationPhase(lock,next.recoveryPath,next.recoveryHash,decision,'remove-old',{boundary:async stage=>events.push(stage)});
      assert.equal(events.includes('intent'),mode!=='readback');assert.equal(events.includes('readback'),mode==='readback');
    }
    if(mode.startsWith('interrupted')) {
      const interruptedPhase=mode==='interrupted-remove'?'remove-old':'install-new';
      await assert.rejects(()=>executeSwitchContinuationPhase(lock,next.recoveryPath,next.recoveryHash,decision,interruptedPhase,{
        boundary:async stage=>{if(stage===(mode==='interrupted-before'?'intent':'target-written'))throw Error('continuation interruption');}
      }),/continuation interruption/);
      const uncertain=await inspectSwitchContinuation(f.a,next.recoveryPath);
      assert.equal(uncertain.journalStatus,'uncertain');assert.deepEqual(uncertain.conflicts,[]);
      await assert.rejects(()=>executeSwitchContinuationPhase(lock,next.recoveryPath,next.recoveryHash,decision,'install-new'),e=>e.code==='switch-continuation-runtime.state');
      await assert.rejects(()=>activateSwitchContinuation(lock,next.recoveryPath,next.recoveryHash,decision),e=>e.code==='switch-continuation-runtime.incomplete');
      assert.equal((await inspectInstallation(f.a)).ready,false);
      const preserved=await workspaceHashes(f.a),other=await workspaceHashes(f.b);
      const secondPreview=await prepareSwitchContinuation(f.a,next.recoveryPath);
      assert.deepEqual(secondPreview.remaining.map(p=>p.phase),mode==='interrupted-remove'?['remove-old','install-new']:['install-new']);
      assert.equal(secondPreview.uncertain.resolution,mode==='interrupted-before'?'retry-approved-target':'verify-desired');
      const secondDecision={decision:'approve',previewDigest:secondPreview.digest};
      const second=await persistSwitchContinuationRecovery(lock,secondPreview,secondDecision);
      await markSwitchContinuationPending(lock,second.recoveryPath,second.recoveryHash,secondDecision);
      await assert.rejects(()=>verifySwitchContinuationApproval(lock,secondPreview,secondDecision),e=>!!e.code);
      const completedEvents=[];
      await executeSwitchContinuationPhase(lock,second.recoveryPath,second.recoveryHash,secondDecision,interruptedPhase,{
        boundary:async stage=>completedEvents.push(stage)
      });
      assert.equal(completedEvents.includes('readback'),mode!=='interrupted-before');
      assert.equal(completedEvents.includes('intent'),mode==='interrupted-before');
      if(mode==='interrupted-remove')await executeSwitchContinuationPhase(lock,second.recoveryPath,second.recoveryHash,secondDecision,'install-new');
      await activateSwitchContinuation(lock,second.recoveryPath,second.recoveryHash,secondDecision);
      await lock.release();released=true;
      const history=await inspectHistory(f.a),doctor=await inspectInstallation(f.a);
      assert.deepEqual(history.diagnostics,[]);assert.equal(doctor.ready,true);
      assert.deepEqual(doctor.matchingTransactions,[second.recoveryPath]);
      assert.deepEqual(history.entries.find(e=>e.recovery===second.recoveryPath).resolvesChain,[next.recoveryPath,saved.recoveryPath]);
      const after=await workspaceHashes(f.a);
      const changedTargets=new Set(secondPreview.remaining.flatMap(p=>p.operations.map(o=>o.path)));
      for(const [name,hash] of Object.entries(preserved))if(name!=='.pipeline/state.json' &&
        name!=='.pipeline/lock' && !name.startsWith('.pipeline/lock/') && !changedTargets.has(name))assert.equal(after[name],hash,name);
      assert.deepEqual(await workspaceHashes(f.b),other);
      const ancestorPath=path.join(f.a,saved.recoveryPath),ancestorBytes=await readFile(ancestorPath);
      await writeFile(ancestorPath,'{}');
      await assert.rejects(()=>readSwitchContinuationRecovery(f.a,second.recoveryPath),e=>!!e.code);
      assert.equal((await inspectInstallation(f.a)).ready,false);
      await writeFile(ancestorPath,ancestorBytes); // restore synthetic corruption only
    }else {
      await executeSwitchContinuationPhase(lock,next.recoveryPath,next.recoveryHash,decision,'install-new');
      await writeFile(path.join(f.a,'AGENTS.md'),'foreign');
      await assert.rejects(()=>activateSwitchContinuation(lock,next.recoveryPath,next.recoveryHash,decision),e=>e.code==='switch-continuation-runtime.target-drift');
      await writeFile(path.join(f.a,'AGENTS.md'),'replacement'); // synthetic restoration only
      if(mode==='readback')await assert.rejects(()=>activateSwitchContinuation(lock,next.recoveryPath,next.recoveryHash,decision,{
        boundary:async stage=>{if(stage==='renamed')throw Error('activation interruption');}
      }),e=>e.code==='apply.write');
      else await activateSwitchContinuation(lock,next.recoveryPath,next.recoveryHash,decision);
      assert.equal((await inspectSwitchContinuation(f.a,next.recoveryPath,{active:true})).status,'applied');
      await lock.release();released=true;
      const before=await workspaceHashes(f.a),history=await inspectHistory(f.a),doctor=await inspectInstallation(f.a);
      assert.deepEqual(history.diagnostics,[]);assert.equal(doctor.ready,true);assert.equal(doctor.transactionEvidence,'pass');
      assert.deepEqual(doctor.matchingTransactions,[next.recoveryPath]);
      const retention=await scanRetention(f.a,{policy:{maxAgeDays:0,maxJournals:0,maxDeletesPerRun:10},now:Date.now()+1000});
      assert.equal(retention.complete,true);assert.deepEqual(retention.retention.selected,[]);
      assert.ok(retention.groups.find(g=>g.id===next.recoveryPath.split('/')[2]).protectionReasons.includes('current-state'));
      assert.ok(retention.groups.find(g=>g.id===saved.recoveryPath.split('/')[2]).protectionReasons.includes('retained-reference'));
      const old=history.entries.find(e=>e.recovery===saved.recoveryPath);
      assert.equal(old.status,'uncertain');assert.equal(old.resolution,'continued');assert.deepEqual(old.resolvedBy,[next.recoveryPath]);
      assert.deepEqual(await workspaceHashes(f.a),before);
      assert.equal((await inspectInstallation(f.a,{recoveryPath:saved.recoveryPath})).ready,false);
    }
    assert.deepEqual(await workspaceHashes(path.join(f.a,preview.predecessor.journal)),oldJournal);
  }finally{if(!released)await lock.release();}
});

test('switch doctor recognizes exact active and pending history and refuses stale selection or corrupt predecessor',async()=>{
  const f=await approvedFixture({sharedPlan:c=>[{path:'AGENTS.md',owner:'shared',kind:'file',bytes:Buffer.from(c.pipeline.id)}]}),incoming=await approvedFixture({pipelineId:'replacement'});
  await applyLifecycle({command:'setup',wrapper:f.a,prepared:f.prepared,approval:f.approval},f.registry);
  const previous=(await readState(path.join(f.a,'.pipeline/state.json'))).value;
  const manifest=JSON.parse(await readFile(incoming.manifestPath,'utf8'));
  manifest.pipeline.path=path.relative(f.a,path.resolve(incoming.a,manifest.pipeline.path)).split(path.sep).join('/');
  const manifestPath=path.join(f.a,'incoming.json');await writeFile(manifestPath,JSON.stringify(manifest));
  const prepared=await prepareSwitch({wrapper:f.a,manifestPath,tempRoot:f.root},f.registry),approval={decision:'approve',preparedDigest:prepared.digest};
  const lock=await acquireWorkspaceLock(f.a);let released=false;
  try {
    const saved=await persistSwitchRecovery(lock,prepared,approval,f.registry,previous);
    await markSwitchPending(lock,saved.recoveryPath,saved.recoveryHash,approval,f.registry);
    const pending=await inspectInstallation(f.a);
    assert.equal(pending.ready,false);assert.equal(pending.recovery.path,saved.recoveryPath);assert.equal(pending.recovery.statePhase,'pending');
    await executeSwitchPhase(lock,saved.recoveryPath,saved.recoveryHash,approval,'remove-old');
    await executeSwitchPhase(lock,saved.recoveryPath,saved.recoveryHash,approval,'install-new');
    await activateSwitch(lock,saved.recoveryPath,saved.recoveryHash,approval);
    await lock.release();released=true;
    const before=await workspaceHashes(f.a),history=await inspectHistory(f.a),doctor=await inspectInstallation(f.a);
    assert.deepEqual(history.diagnostics,[]);assert.equal(history.entries.length,2);
    assert.equal(history.entries.filter(e=>e.kind==='switch' && e.status==='journal-completed').length,1);
    assert.equal(doctor.ready,true);assert.equal(doctor.pipeline.id,'replacement');assert.equal(doctor.transactionEvidence,'pass');
    assert.deepEqual(doctor.matchingTransactions,[saved.recoveryPath]);assert.deepEqual(await workspaceHashes(f.a),before);
    const stale=await inspectInstallation(f.a,{recoveryPath:previous.activation.recovery});
    assert.equal(stale.ready,false);assert.ok(stale.diagnostics.some(d=>d.code==='doctor.activation-selection'));
    await writeFile(path.join(f.a,previous.activation.recovery),'{}');
    const corrupt=await inspectInstallation(f.a,{recoveryPath:saved.recoveryPath});
    assert.equal(corrupt.ready,false);assert.equal(corrupt.transactionEvidence,'fail');
  }finally{if(!released)await lock.release();}
});

test('switch staging persists original incoming backup without replacing old history',async()=>{
  const original=Buffer.from('original entry');
  const sharedPlan=c=>{const bytes=Buffer.from(c.pipeline.id);return [{path:'AGENTS.md',owner:'shared',kind:'file',bytes,
    takeover:{beforeHash:sha256(original),desiredHash:sha256(bytes)}}];};
  const f=await approvedFixture({sharedPlan,seed:{'AGENTS.md':original}}),incoming=await approvedFixture({pipelineId:'replacement'});
  await applyLifecycle({command:'setup',wrapper:f.a,prepared:f.prepared,approval:f.approval},f.registry);
  const manifest=JSON.parse(await readFile(incoming.manifestPath,'utf8'));
  manifest.pipeline.path=path.relative(f.a,path.resolve(incoming.a,manifest.pipeline.path)).split(path.sep).join('/');
  const manifestPath=path.join(f.a,'incoming.json');await writeFile(manifestPath,JSON.stringify(manifest));
  const previous=(await readState(path.join(f.a,'.pipeline/state.json'))).value;
  const prepared=await prepareSwitch({wrapper:f.a,manifestPath,tempRoot:f.root},f.registry),lock=await acquireWorkspaceLock(f.a);
  try {
    const backup=prepared.preview.phases[1].preview.plan.desired.owned[0].backup;
    assert.equal(backup,previous.active.owned[0].backup);
    const before=await readFile(path.join(f.a,backup));assert.deepEqual(before,original);
    const saved=await persistSwitchRecovery(lock,prepared,{decision:'approve',preparedDigest:prepared.digest},f.registry,previous);
    assert.deepEqual(await readFile(path.join(f.a,backup)),before);
    assert.equal(await readFile(path.join(f.a,'AGENTS.md'),'utf8'),'fixture');
    await readSwitchRecovery(f.a,saved.recoveryPath);
    const pending=await markSwitchPending(lock,saved.recoveryPath,saved.recoveryHash,{decision:'approve',preparedDigest:prepared.digest},f.registry);
    const current=(await readState(path.join(f.a,'.pipeline/state.json'))).value;
    assert.equal(current.status,'needs-reconciliation');assert.equal(current.pending,pending.pending);
    assert.equal(current.pending,(await readSwitchRecovery(f.a,saved.recoveryPath)).record.digest);
    assert.deepEqual(current.active,previous.active);assert.deepEqual(current.activation,previous.activation);
    assert.equal(await readFile(path.join(f.a,'AGENTS.md'),'utf8'),'fixture');
    const readBefore=await workspaceHashes(f.a),inspection=await inspectPendingSwitch(f.a,saved.recoveryPath);
    assert.deepEqual(inspection.conflicts,[]);assert.equal(inspection.executionAllowed,false);
    const boundaryPreview=await prepareSwitchContinuation(f.a,saved.recoveryPath);
    assert.equal(boundaryPreview.uncertain,null);
    assert.deepEqual(boundaryPreview.remaining.map(p=>p.phase),['remove-old','install-new']);
    assert.deepEqual(boundaryPreview.remaining.map(p=>p.operations.map(o=>o.operationId)),
      prepared.preview.phases.map(p=>p.preview.plan.targets.map(t=>t.id)));
    assert.equal(boundaryPreview.requiresFreshApproval,true);
    assert.deepEqual(await workspaceHashes(f.a),readBefore);
    await assert.rejects(()=>executeSwitchPhase(lock,saved.recoveryPath,saved.recoveryHash,{decision:'approve',preparedDigest:prepared.digest},'remove-old',{
      boundary:async phase=>{if(phase==='intent')throw Error('synthetic interrupted intent');}
    }),/synthetic interrupted intent/);
    assert.equal((await inspectPendingSwitch(f.a,saved.recoveryPath)).targets.find(t=>t.path==='AGENTS.md').disposition,'uncertain-before');
    const continuationBefore=await workspaceHashes(f.a),retry=await prepareSwitchContinuation(f.a,saved.recoveryPath);
    assert.equal(retry.uncertain.resolution,'retry-approved-target');assert.equal(retry.applySupported,false);
    assert.deepEqual(retry.remaining.map(p=>p.phase),['remove-old','install-new']);
    const retryApproval={decision:'approve',previewDigest:retry.digest};
    const checkedRetry=await verifySwitchContinuationApproval(lock,retry,retryApproval);
    assert.equal(checkedRetry.applySupported,false);assert.equal(checkedRetry.preview.digest,retry.digest);
    const continuationCursor=createSwitchContinuationCursor(checkedRetry.preview);
    assert.equal(continuationCursor.append({schemaVersion:1,seq:0,previous:null,previewDigest:retry.digest,
      kind:'start',payload:retry.predecessor}).status,'open');
    await assert.rejects(()=>verifySwitchContinuationApproval(lock,retry,{decision:'approve',previewDigest:sha256(Buffer.from('wrong'))}),e=>e.code==='switch-continuation.approval');
    await assert.rejects(()=>verifySwitchContinuationApproval(lock,retry,{...retryApproval,extra:true}),e=>e.code==='switch-continuation.approval');
    assert.deepEqual(await workspaceHashes(f.a),continuationBefore);
    await assert.rejects(()=>executeSwitchPhase(lock,saved.recoveryPath,saved.recoveryHash,{decision:'approve',preparedDigest:prepared.digest},'remove-old'),e=>e.code==='switch-execute.state');
    await writeFile(path.join(f.a,'AGENTS.md'),original);
    const uncertain=await inspectPendingSwitch(f.a,saved.recoveryPath);
    assert.equal(uncertain.targets.find(t=>t.path==='AGENTS.md').disposition,'uncertain-desired');
    assert.equal(uncertain.journalCompleted,false);assert.equal(uncertain.status,'needs-reconciliation');
    const verifyOnly=await prepareSwitchContinuation(f.a,saved.recoveryPath);
    assert.equal(verifyOnly.uncertain.resolution,'verify-desired');
    assert.equal(verifyOnly.predecessor.head,retry.predecessor.head);
    assert.notEqual(verifyOnly.digest,retry.digest);
    await assert.rejects(()=>verifySwitchContinuationApproval(lock,retry,retryApproval),e=>e.code==='switch-continuation.plan-drift');
    assert.equal((await verifySwitchContinuationApproval(lock,verifyOnly,{decision:'approve',previewDigest:verifyOnly.digest})).preview.digest,verifyOnly.digest);
    const durableBefore=await workspaceHashes(f.a),decision={decision:'approve',previewDigest:verifyOnly.digest};
    await assert.rejects(()=>createSwitchContinuationJournal(lock,retry,retryApproval),e=>e.code==='switch-continuation.plan-drift');
    assert.deepEqual(await workspaceHashes(f.a),durableBefore);
    const locations=[];let interrupt=false;
    const journal=await createSwitchContinuationJournal(lock,verifyOnly,decision,{
      onLocation:async detail=>locations.push(detail.status),
      ioBoundary:async phase=>{if(interrupt && phase==='opened')throw Error('synthetic continuation interruption');}
    });
    assert.deepEqual(locations,['planned','created','initialized']);
    assert.notEqual(journal.relative,verifyOnly.predecessor.journal);
    const u=verifyOnly.uncertain;
    await journal.readback(u.phase,u.operationId,'completed',u.desiredHash);
    const durable=await readSwitchContinuationJournal(f.a,journal.relative,verifyOnly);
    assert.equal(durable.sequence,2);assert.equal(durable.status,'open');
    assert.equal(durable.activationSupported,false);
    assert.deepEqual(journal.metrics(),{headReads:1,recordReadbacks:2,fullAudits:1});
    await journal.phaseChecked(u.phase,durable.expectedProjectionDigest);
    assert.equal((await readSwitchContinuationJournal(f.a,journal.relative,verifyOnly)).phase,'install-new');
    assert.equal(journal.metrics().fullAudits,2);
    assert.equal((await readSwitchRecovery(f.a,saved.recoveryPath)).journal.head,verifyOnly.predecessor.head);
    const afterJournal=await workspaceHashes(f.a);
    for(const [name,value] of Object.entries(durableBefore))assert.deepEqual(afterJournal[name],value,'preserved '+name);
    interrupt=true;
    const install=verifyOnly.remaining[1].operations[0];
    await assert.rejects(()=>journal.intent('install-new',install.operationId),e=>e.code==='switch-continuation-store.io');
    assert.equal((await readFile(path.join(f.a,journal.relative,'000003.json'))).length,0);
    await assert.rejects(()=>journal.intent('install-new',install.operationId),e=>e.code==='switch-continuation-store.unavailable');
    await assert.rejects(()=>readSwitchContinuationJournal(f.a,journal.relative,verifyOnly),e=>!!e.code);
    const headJournal=await createSwitchContinuationJournal(lock,verifyOnly,decision);
    await writeFile(path.join(f.a,headJournal.relative,'000000.json'),'{}');
    await assert.rejects(()=>headJournal.readback(u.phase,u.operationId,'completed',u.desiredHash),e=>e.code==='switch-continuation-store.drift');
    assert.equal((await readSwitchRecovery(f.a,saved.recoveryPath)).journal.head,verifyOnly.predecessor.head);
    const recoveryBefore=await workspaceHashes(f.a);
    const continuationSaved=await persistSwitchContinuationRecovery(lock,verifyOnly,decision);
    assert.equal(continuationSaved.applySupported,false);
    const continuationEvidence=await readSwitchContinuationRecovery(f.a,continuationSaved.recoveryPath);
    assert.equal(continuationEvidence.fileHash,continuationSaved.recoveryHash);
    assert.equal(continuationEvidence.journal.sequence,1);
    assert.equal(contractDigest(continuationEvidence.record.approval),contractDigest(decision));
    const recoveryAfter=await workspaceHashes(f.a);
    for(const [name,value] of Object.entries(recoveryBefore))assert.deepEqual(recoveryAfter[name],value,'preserved '+name);
    assert.deepEqual(await workspaceHashes(f.a),recoveryAfter);
    const predecessorEvidence=await readSwitchRecovery(f.a,saved.recoveryPath);
    for(const scenario of ['lineage','plan','observations']) {
      const tampered=structuredClone(verifyOnly);
      if(scenario==='lineage')tampered.predecessor.sequence++;
      if(scenario==='plan')tampered.remaining[1].operations[0].desiredHash=sha256(Buffer.from('tampered'));
      if(scenario==='observations')tampered.observations[0].hash=sha256(Buffer.from('tampered'));
      assert.throws(()=>assertSwitchContinuationPredecessor(tampered,predecessorEvidence),e=>e.code==='switch-continuation-record.'+scenario);
    }
    let partialPath;
    await assert.rejects(()=>persistSwitchContinuationRecovery(lock,verifyOnly,decision,{
      boundary:async (phase,detail)=>{if(phase==='opened'){partialPath=detail.path;throw Error('synthetic record interruption');}}
    }),e=>e.code==='switch-continuation-recovery.io');
    assert.equal((await readFile(path.join(f.a,partialPath))).length,0);
    await assert.rejects(()=>readSwitchContinuationRecovery(f.a,partialPath),e=>!!e.code);
    await writeFile(path.join(f.a,'AGENTS.md'),'foreign edit');
    // Historical evidence remains readable, but does not approve current drift.
    assert.equal((await readSwitchContinuationRecovery(f.a,continuationSaved.recoveryPath)).fileHash,continuationSaved.recoveryHash);
    assert.deepEqual((await inspectPendingSwitch(f.a,saved.recoveryPath)).conflicts,['AGENTS.md']);
    await assert.rejects(()=>prepareSwitchContinuation(f.a,saved.recoveryPath),e=>e.code==='switch-continuation.state');
    await writeFile(path.join(f.a,'AGENTS.md'),original); // Restore synthetic drift before selection.
    const selectionBefore=await workspaceHashes(f.a);
    await assert.rejects(()=>inspectSelectedSwitchContinuation(f.a,continuationSaved.recoveryPath,continuationSaved.recoveryHash),e=>e.code==='switch-continuation-pending.selection');
    await assert.rejects(()=>markSwitchContinuationPending(lock,continuationSaved.recoveryPath,sha256(Buffer.from('wrong')),decision),e=>e.code==='switch-continuation-pending.evidence');
    assert.deepEqual(await workspaceHashes(f.a),selectionBefore);
    const oldStateBytes=await readFile(path.join(f.a,'.pipeline/state.json'));
    await assert.rejects(()=>markSwitchContinuationPending(lock,continuationSaved.recoveryPath,continuationSaved.recoveryHash,decision,{
      boundary:async phase=>{if(phase==='before-rename')throw Error('synthetic before selection');}
    }),e=>e.code==='switch-continuation-pending.io');
    assert.deepEqual(await readFile(path.join(f.a,'.pipeline/state.json')),oldStateBytes);
    await assert.rejects(()=>markSwitchContinuationPending(lock,continuationSaved.recoveryPath,continuationSaved.recoveryHash,decision,{
      boundary:async phase=>{if(phase==='renamed')throw Error('synthetic after selection');}
    }),e=>e.code==='switch-continuation-pending.io');
    const selected=await inspectSelectedSwitchContinuation(f.a,continuationSaved.recoveryPath,continuationSaved.recoveryHash);
    assert.equal(selected.pending,continuationEvidence.record.digest);assert.equal(selected.executionAllowed,false);
    const selectedState=(await readState(path.join(f.a,'.pipeline/state.json'))).value;
    assert.deepEqual(selectedState.active,current.active);assert.deepEqual(selectedState.activation,current.activation);
    const afterSelection=await workspaceHashes(f.a);
    for(const [name,value] of Object.entries(selectionBefore))if(name!=='.pipeline/state.json')assert.deepEqual(afterSelection[name],value,'selection preserved '+name);
    await assert.rejects(()=>markSwitchContinuationPending(lock,continuationSaved.recoveryPath,continuationSaved.recoveryHash,decision),e=>e.code==='switch-inspect.activation-binding');
    await assert.rejects(()=>executeSwitchPhase(lock,saved.recoveryPath,saved.recoveryHash,{decision:'approve',preparedDigest:prepared.digest},'remove-old'),e=>e.code==='switch-inspect.activation-binding');
    await writeFile(path.join(f.a,backup),'corrupt fixture backup');
    await assert.rejects(()=>readSwitchRecovery(f.a,saved.recoveryPath),e=>e.code==='switch-recovery.backup');
    await assert.rejects(()=>readSwitchContinuationRecovery(f.a,continuationSaved.recoveryPath),e=>e.code==='switch-recovery.backup');
  }finally{await lock.release();}
});

test('switch staging verifies incoming Git and projects removal without workspace writes',async()=>{
  const sharedPlan=c=>[{path:'AGENTS.md',owner:'shared',kind:'file',bytes:Buffer.from(c.pipeline.id)}];
  const f=await approvedFixture({sharedPlan}),incoming=await approvedFixture({pipelineId:'replacement'});
  await applyLifecycle({command:'setup',wrapper:f.a,prepared:f.prepared,approval:f.approval},f.registry);
  const manifest=JSON.parse(await readFile(incoming.manifestPath,'utf8'));
  manifest.pipeline.path=path.relative(f.a,path.resolve(incoming.a,manifest.pipeline.path)).split(path.sep).join('/');
  const manifestPath=path.join(f.a,'incoming.json');await writeFile(manifestPath,JSON.stringify(manifest));
  const before=await workspaceHashes(f.a),other=await workspaceHashes(f.b);
  const prepared=await prepareSwitch({wrapper:f.a,manifestPath,tempRoot:f.root},f.registry);
  const recovery=createSwitchRecoveryRecord({prepared,approval:{decision:'approve',preparedDigest:prepared.digest},
    previous:(await readState(path.join(f.a,'.pipeline/state.json'))).value,
    journal:'.pipeline/journals/00000000-0000-0000-0000-000000000001'});
  assert.deepEqual(validateSwitchRecoveryRecord(recovery),recovery);
  const switchLock=await acquireWorkspaceLock(f.a);
  try {
    const lockedBefore=await workspaceHashes(f.a);
    const checked=await verifySwitchApproval(switchLock,prepared,recovery.approval,f.registry,recovery.previous);
    assert.equal(checked.applySupported,false);assert.deepEqual(await workspaceHashes(f.a),lockedBefore);
    await assert.rejects(()=>verifySwitchApproval(switchLock,prepared,{decision:'approve',preparedDigest:sha256(Buffer.from('wrong'))},f.registry,recovery.previous),e=>e.code==='switch-record.approval');
    const oldPlan=f.registry.sharedAdapter.plan;
    f.registry.sharedAdapter.plan=c=>c.pipeline.id==='replacement'?[{path:'AGENTS.md',owner:'shared',kind:'file',bytes:Buffer.from('drift')}]:oldPlan(c);
    await assert.rejects(()=>verifySwitchApproval(switchLock,prepared,recovery.approval,f.registry,recovery.previous),e=>e.code==='switch-preflight.adapter-drift');
    f.registry.sharedAdapter.plan=oldPlan;
    const staged=path.join(prepared.preparation.snapshot,'resources/process.md'),original=await readFile(staged);
    await writeFile(staged,'corrupt');
    await assert.rejects(()=>verifySwitchApproval(switchLock,prepared,recovery.approval,f.registry,recovery.previous),e=>e.code==='inventory.hash');
    await writeFile(staged,original);
    assert.deepEqual(await workspaceHashes(f.a),lockedBefore);
  }finally{await switchLock.release();}
  assert.equal(prepared.applySupported,false);assert.equal(prepared.sourceVerification,'verified-at-preparation');
  assert.equal(prepared.preview.toPipeline,'replacement');
  const [remove,install]=prepared.preview.phases.map(p=>p.preview);
  assert.equal(remove.plan.targets.find(t=>t.path==='AGENTS.md').action,'delete');
  assert.equal(install.plan.targets.find(t=>t.path==='AGENTS.md').action,'create');
  assert.equal(install.observations.find(o=>o.path==='AGENTS.md').bytes,null);
  assert.equal(Buffer.from(install.outputs.find(o=>o.path==='AGENTS.md').bytes,'base64').toString(),'replacement');
  assert.equal(await readFile(path.join(prepared.preparation.snapshot,'resources/process.md'),'utf8'),'rules');
  assert.deepEqual(await workspaceHashes(f.a),before);assert.deepEqual(await workspaceHashes(f.b),other);
  await assert.rejects(()=>prepareSwitch({wrapper:f.a,manifestPath:f.manifestPath,tempRoot:f.root},f.registry),e=>e.code==='switch.same-pipeline');
  await assert.rejects(()=>prepareSwitch({wrapper:f.a,manifestPath,tempRoot:f.a},f.registry),e=>e.code==='plan.preparation-location');
  assert.deepEqual(await workspaceHashes(f.a),before);
  const metadataLock=await acquireWorkspaceLock(f.a);
  try {
    const stateBytes=await readFile(path.join(f.a,'.pipeline/state.json')),entryBytes=await readFile(path.join(f.a,'AGENTS.md'));
    const locations=[];
    const persisted=await persistSwitchRecovery(metadataLock,prepared,recovery.approval,f.registry,recovery.previous,{onJournal:v=>locations.push(v)});
    const evidence=await readSwitchRecovery(f.a,persisted.recoveryPath);
    assert.equal(evidence.fileHash,persisted.recoveryHash);assert.equal(evidence.journal.sequence,1);
    assert.equal(evidence.journal.status,'open');assert.equal(persisted.applySupported,false);
    assert.equal(locations.at(-1).relative,persisted.journalPath);
    assert.deepEqual(await readFile(path.join(f.a,'.pipeline/state.json')),stateBytes);
    assert.deepEqual(await readFile(path.join(f.a,'AGENTS.md')),entryBytes);
    await assert.rejects(()=>persistSwitchRecovery(metadataLock,prepared,recovery.approval,f.registry,recovery.previous,{boundary:async phase=>{
      if(phase==='snapshot')throw Error('synthetic stop before journal');
    }}),/synthetic stop/);
    let corruptPath;
    await assert.rejects(()=>persistSwitchRecovery(metadataLock,prepared,recovery.approval,f.registry,recovery.previous,{boundary:async(phase,detail)=>{
      if(phase==='recovery-written'){corruptPath=detail.path;await writeFile(path.join(f.a,detail.path),'{}');}
    }}),e=>e.code==='switch-recovery.readback');
    assert.equal(await readFile(path.join(f.a,corruptPath),'utf8'),'{}');
    assert.deepEqual(await readFile(path.join(f.a,'.pipeline/state.json')),stateBytes);
    assert.deepEqual(await readFile(path.join(f.a,'AGENTS.md')),entryBytes);
    assert.deepEqual(await workspaceHashes(f.b),other);
    await assert.rejects(()=>markSwitchPending(metadataLock,persisted.recoveryPath,persisted.recoveryHash,recovery.approval,f.registry,{boundary:async phase=>{
      if(phase==='renamed')throw Error('synthetic interruption after pending');
    }}),e=>e.code==='switch-pending.io');
    const pendingState=(await readState(path.join(f.a,'.pipeline/state.json'))).value;
    assert.equal(pendingState.status,'needs-reconciliation');
    assert.equal(pendingState.pending,(await readSwitchRecovery(f.a,persisted.recoveryPath)).record.digest);
    assert.deepEqual(await readFile(path.join(f.a,'AGENTS.md')),entryBytes);
    assert.deepEqual((await inspectPendingSwitch(f.a,persisted.recoveryPath)).conflicts,[]);
    await assert.rejects(()=>executeSwitchPhase(metadataLock,persisted.recoveryPath,persisted.recoveryHash,recovery.approval,'install-new'),e=>e.code==='switch-execute.state');
    await assert.rejects(()=>activateSwitch(metadataLock,persisted.recoveryPath,persisted.recoveryHash,recovery.approval),e=>e.code==='switch-activation.incomplete');
    const removed=await executeSwitchPhase(metadataLock,persisted.recoveryPath,persisted.recoveryHash,recovery.approval,'remove-old');
    assert.equal(removed.nextPhase,'install-new');
    await assert.rejects(()=>readFile(path.join(f.a,'AGENTS.md')),e=>e.code==='ENOENT');
    const installed=await executeSwitchPhase(metadataLock,persisted.recoveryPath,persisted.recoveryHash,recovery.approval,'install-new');
    assert.equal(installed.journalCompleted,true);assert.equal(installed.activationSupported,false);
    assert.equal(await readFile(path.join(f.a,'AGENTS.md'),'utf8'),'replacement');
    assert.equal((await readState(path.join(f.a,'.pipeline/state.json'))).value.status,'needs-reconciliation');
    assert.deepEqual((await inspectPendingSwitch(f.a,persisted.recoveryPath)).conflicts,[]);
    await writeFile(path.join(f.a,'AGENTS.md'),'foreign drift');
    await assert.rejects(()=>activateSwitch(metadataLock,persisted.recoveryPath,persisted.recoveryHash,recovery.approval),e=>e.code==='switch-activation.target-drift');
    await writeFile(path.join(f.a,'AGENTS.md'),'replacement');
    const activated=await activateSwitch(metadataLock,persisted.recoveryPath,persisted.recoveryHash,recovery.approval);
    assert.equal(activated.status,'applied');
    const ready=(await readState(path.join(f.a,'.pipeline/state.json'))).value;
    assert.equal(ready.status,'ready');assert.equal(ready.pending,null);assert.equal(ready.active.pipelineId,'replacement');
    assert.equal(ready.activation.recovery,persisted.recoveryPath);assert.equal(ready.activation.recoveryHash,persisted.recoveryHash);
    const completedBefore=await workspaceHashes(f.a);
    assert.equal((await inspectActivatedSwitch(f.a,persisted.recoveryPath)).status,'applied');
    assert.deepEqual(await workspaceHashes(f.a),completedBefore);
    // Recreate the pre-activation state in this fixture to exercise an interrupted
    // successful rename. This is test setup, not production rollback behavior.
    await writeFile(path.join(f.a,'.pipeline/state.json'),JSON.stringify(pendingState)+'\n');
    await assert.rejects(()=>activateSwitch(metadataLock,persisted.recoveryPath,persisted.recoveryHash,recovery.approval,{boundary:async phase=>{
      if(phase==='renamed')throw Error('synthetic interruption after activation');
    }}),e=>e.code==='apply.write');
    assert.equal((await inspectActivatedSwitch(f.a,persisted.recoveryPath)).status,'applied');
  }finally{await metadataLock.release();}
});

test('switch staging preserves restored foreign JSON fields and rejects validation or origin drift',async()=>{
  let rejectIncoming=false,onIncoming=async()=>{};
  const codex={validate:async c=>{if(c.pipeline.id==='replacement')await onIncoming();return {valid:!(rejectIncoming && c.pipeline.id==='replacement')};},
    plan:c=>[{path:'.codex/test.json',owner:'codex',kind:'json-fields',fields:[{pointer:'/pipeline',present:true,value:c.pipeline.id}]}]};
  const f=await approvedFixture({codex,seed:{'.codex/test.json':'{"foreign":"keep"}'}}),incoming=await approvedFixture({pipelineId:'replacement'});
  await applyLifecycle({command:'setup',wrapper:f.a,prepared:f.prepared,approval:f.approval},f.registry);
  const manifest=JSON.parse(await readFile(incoming.manifestPath,'utf8'));
  manifest.pipeline.path=path.relative(f.a,path.resolve(incoming.a,manifest.pipeline.path)).split(path.sep).join('/');
  const manifestPath=path.join(f.a,'incoming.json');await writeFile(manifestPath,JSON.stringify(manifest));
  const before=await workspaceHashes(f.a);
  const prepared=await prepareSwitch({wrapper:f.a,manifestPath,tempRoot:f.root},f.registry);
  const install=prepared.preview.phases[1].preview;
  assert.deepEqual(JSON.parse(Buffer.from(install.observations.find(o=>o.path==='.codex/test.json').bytes,'base64')),{foreign:'keep'});
  assert.deepEqual(JSON.parse(Buffer.from(install.outputs.find(o=>o.path==='.codex/test.json').bytes,'base64')),{foreign:'keep',pipeline:'replacement'});
  rejectIncoming=true;
  await assert.rejects(()=>prepareSwitch({wrapper:f.a,manifestPath,tempRoot:f.root},f.registry),e=>e.code==='provider.validation');
  assert.deepEqual(await workspaceHashes(f.a),before);
  rejectIncoming=false;
  const original=await readFile(manifestPath);
  onIncoming=()=>writeFile(manifestPath,Buffer.concat([original,Buffer.from('\n')]));
  await assert.rejects(()=>prepareSwitch({wrapper:f.a,manifestPath,tempRoot:f.root},f.registry),e=>e.code==='plan.origin-drift');
  // Only the test double changed this fixture manifest; restore it to verify no
  // preparer writes, including journal/state or provider destinations, occurred.
  await writeFile(manifestPath,original);
  assert.deepEqual(await workspaceHashes(f.a),before);
});

test('removal selection retains shared ownership while another provider remains',()=>{
  assert.deepEqual(selectRemovalProviders(['codex','claude'],['claude']),{providers:['claude'],remaining:['codex'],owners:['claude']});
  assert.deepEqual(selectRemovalProviders(['codex']),{providers:['codex'],remaining:[],owners:['codex','shared']});
  for(const providers of [[],['grok'],['codex','codex']])assert.throws(()=>selectRemovalProviders(['codex'],providers),e=>e.code==='remove.providers');
});

test('partial removal integrates two providers and locked approval preserves shared and foreign scopes',async()=>{
  const f=await approvedFixture({providers:['codex','claude'],
    codex:{plan:()=>[{path:'.codex/test.json',owner:'codex',kind:'json-fields',fields:[{pointer:'/ours',present:true,value:true}]}]},
    claude:{plan:()=>[{path:'.claude/skill.md',owner:'claude',kind:'file',bytes:Buffer.from('claude skill')}]}});
  await applyLifecycle({command:'setup',wrapper:f.a,prepared:f.prepared,approval:f.approval},f.registry);
  await writeFile(path.join(f.a,'.codex/test.json'),'{"ours":true,"foreign":"keep"}');
  const before=await workspaceHashes(f.a),other=await workspaceHashes(f.b);
  const prepared=await prepareRemoval(f.a,f.registry,{providers:['codex']});
  assert.deepEqual(prepared.preview.plan.desired.providers,['claude']);
  assert.deepEqual(prepared.preview.plan.targets.map(t=>t.path),['.codex/test.json']);
  assert.deepEqual(prepared.preview.plan.desired.owned.map(o=>o.owner).sort(),['claude','shared']);
  assert.deepEqual(JSON.parse(Buffer.from(prepared.preview.outputs[0].bytes,'base64').toString()),{foreign:'keep'});
  assert.deepEqual(await workspaceHashes(f.a),before);assert.deepEqual(await workspaceHashes(f.b),other);
  const lock=await acquireWorkspaceLock(f.a),approval={decision:'approve',preparedDigest:prepared.digest};
  try {
    await assert.rejects(()=>verifyRemovalApproval(lock,prepared,f.approval,f.registry),e=>e.code==='remove.approval');
    assert.deepEqual(await verifyRemovalApproval(lock,prepared,approval,f.registry),prepared);
    const forged=structuredClone(prepared);forged.preview.plan.targets[0].path='project/foreign.md';
    const {digest,...body}=forged;forged.digest=contractDigest(body);
    await assert.rejects(()=>verifyRemovalApproval(lock,forged,{decision:'approve',preparedDigest:forged.digest},f.registry),e=>e.code==='remove.plan-drift');
    await writeFile(path.join(f.a,'.codex/test.json'),'{"ours":true,"foreign":"changed"}');
    await assert.rejects(()=>verifyRemovalApproval(lock,prepared,approval,f.registry),e=>e.code==='remove.plan-drift');
    await writeFile(path.join(f.a,'.codex/test.json'),'{"ours":true,"foreign":"keep"}');
    await writeFile(path.join(f.a,'.claude/skill.md'),'user edit');
    await assert.rejects(()=>verifyRemovalApproval(lock,prepared,approval,f.registry),e=>e.code==='remove.conflict');
    await writeFile(path.join(f.a,'.claude/skill.md'),'claude skill');
  }finally{await lock.release();}
  await assert.rejects(()=>verifyRemovalApproval(lock,prepared,approval,f.registry),e=>e.code==='lock.released');
  assert.deepEqual(await workspaceHashes(f.a),before);assert.deepEqual(await workspaceHashes(f.b),other);
});

test('removal preview restores original field only, deletes owned file and preserves foreign state',async()=>{
  const original=Buffer.from('{"managed":false,"foreign":"original"}');
  const f=await approvedFixture({seed:{'.codex/test.json':original},codex:{plan:()=>[{path:'.codex/test.json',owner:'codex',kind:'json-fields',
    fields:[{pointer:'/managed',present:true,value:true,takeover:{beforeHash:contractDigest(false),desiredHash:contractDigest(true)}}]}]}});
  await applyLifecycle({command:'setup',wrapper:f.a,prepared:f.prepared,approval:f.approval},f.registry);
  await writeFile(path.join(f.a,'.codex/test.json'),'{"managed":true,"foreign":"current","extra":7}');
  const before=await workspaceHashes(f.a),other=await workspaceHashes(f.b),prepared=await prepareRemoval(f.a,f.registry);
  assert.equal(prepared.preview.plan.command,'remove');assert.equal(prepared.preview.plan.desired,null);
  assert.equal(prepared.preview.plan.targets.find(t=>t.path==='AGENTS.md').action,'delete');
  assert.deepEqual(JSON.parse(Buffer.from(prepared.preview.outputs[0].bytes,'base64').toString()),{managed:false,foreign:'current',extra:7});
  assert.equal(prepared.applySupported,true);assert.equal(prepared.backups.length,1);
  assert.deepEqual(await workspaceHashes(f.a),before);assert.deepEqual(await workspaceHashes(f.b),other);
  await writeFile(path.join(f.a,'AGENTS.md'),'user change');
  await assert.rejects(()=>prepareRemoval(f.a,f.registry),e=>e.code==='remove.conflict');
});

test('removal preview restores original file bytes and refuses corrupt backup',async()=>{
  const original=Buffer.from('foreign entry'),desired=Buffer.from('entry');
  const f=await approvedFixture({seed:{'AGENTS.md':original},sharedPlan:()=>[{path:'AGENTS.md',owner:'shared',kind:'file',bytes:desired,
    takeover:{beforeHash:sha256(original),desiredHash:sha256(desired)}}]});
  await applyLifecycle({command:'setup',wrapper:f.a,prepared:f.prepared,approval:f.approval},f.registry);
  const prepared=await prepareRemoval(f.a,f.registry);
  assert.equal(prepared.preview.plan.targets[0].action,'replace');
  assert.deepEqual(Buffer.from(prepared.preview.outputs[0].bytes,'base64'),original);
  await writeFile(path.join(f.a,prepared.backups[0].path),'corrupt');const before=await workspaceHashes(f.a);
  await assert.rejects(()=>prepareRemoval(f.a,f.registry),e=>e.code==='remove.backup-mismatch');
  assert.deepEqual(await workspaceHashes(f.a),before);
});

test('removal executor deletes only created files, restores original fields and retains evidence',async()=>{
  const original=Buffer.from('{"managed":false,"foreign":"old"}');
  const f=await approvedFixture({seed:{'.codex/test.json':original},codex:{plan:()=>[{path:'.codex/test.json',owner:'codex',kind:'json-fields',
    fields:[{pointer:'/managed',present:true,value:true,takeover:{beforeHash:contractDigest(false),desiredHash:contractDigest(true)}}]}]}});
  await applyLifecycle({command:'setup',wrapper:f.a,prepared:f.prepared,approval:f.approval},f.registry);
  await writeFile(path.join(f.a,'.codex/test.json'),'{"managed":true,"foreign":"current"}');
  const other=await workspaceHashes(f.b),prepared=await prepareRemoval(f.a,f.registry),lock=await acquireWorkspaceLock(f.a);
  let result;
  try{result=await applyRemoval(lock,prepared,{decision:'approve',preparedDigest:prepared.digest},f.registry);}
  finally{await lock.release();}
  assert.equal(result.status,'not-installed');assert.equal(result.state.active,null);
  await assert.rejects(()=>readFile(path.join(f.a,'AGENTS.md')),e=>e.code==='ENOENT');
  assert.deepEqual(JSON.parse(await readFile(path.join(f.a,'.codex/test.json'),'utf8')),{managed:false,foreign:'current'});
  assert.deepEqual(await readFile(path.join(f.a,prepared.backups[0].path)),original);
  assert.equal((await inspectRecovery(f.a,result.recoveryPath)).status,'applied');
  assert.equal((await inspectRecovery(f.a,result.recoveryPath,{evidenceOnly:true})).status,'completed-evidence');
  assert.deepEqual(await workspaceHashes(f.b),other);
});

test('removal executor retains other provider and shared files then restores taken-over file on full removal',async()=>{
  const original=Buffer.from('original entry'),entry=Buffer.from('entry');
  const f=await approvedFixture({providers:['codex','claude'],seed:{'AGENTS.md':original},
    sharedPlan:()=>[{path:'AGENTS.md',owner:'shared',kind:'file',bytes:entry,takeover:{beforeHash:sha256(original),desiredHash:sha256(entry)}}],
    codex:{plan:()=>[{path:'.codex/skill.md',owner:'codex',kind:'file',bytes:Buffer.from('codex')}]},
    claude:{plan:()=>[{path:'.claude/skill.md',owner:'claude',kind:'file',bytes:Buffer.from('claude')}]}});
  await applyLifecycle({command:'setup',wrapper:f.a,prepared:f.prepared,approval:f.approval},f.registry);
  for(const providers of [['codex'],['claude']]) {
    const prepared=await prepareRemoval(f.a,f.registry,{providers}),lock=await acquireWorkspaceLock(f.a);let result;
    try{result=await applyRemoval(lock,prepared,{decision:'approve',preparedDigest:prepared.digest},f.registry);}
    finally{await lock.release();}
    assert.equal((await inspectRecovery(f.a,result.recoveryPath)).status,'applied');
    if(providers[0]==='codex') {
      assert.equal(result.status,'ready');assert.deepEqual(result.state.active.providers,['claude']);
      assert.equal(await readFile(path.join(f.a,'.claude/skill.md'),'utf8'),'claude');
      assert.deepEqual(await readFile(path.join(f.a,'AGENTS.md')),entry);
    }else {assert.equal(result.status,'not-installed');assert.deepEqual(await readFile(path.join(f.a,'AGENTS.md')),original);}
    await assert.rejects(()=>readFile(path.join(f.a,'.'+providers[0]+'/skill.md')),e=>e.code==='ENOENT');
  }
});

for(const fault of ['drift','after-delete'])test('removal executor preserves pending evidence on '+fault,async()=>{
  const f=await approvedFixture();await applyLifecycle({command:'setup',wrapper:f.a,prepared:f.prepared,approval:f.approval},f.registry);
  const prepared=await prepareRemoval(f.a,f.registry),lock=await acquireWorkspaceLock(f.a);let result;
  try{result=await applyRemoval(lock,prepared,{decision:'approve',preparedDigest:prepared.digest},f.registry,{ioBoundary:async event=>{
    if(event.purpose==='target' && event.phase==='before-delete' && fault==='drift')await writeFile(path.join(f.a,event.path),'foreign edit');
    if(event.purpose==='target' && event.phase==='deleted' && fault==='after-delete')throw new Error('synthetic interruption');
  }});}finally{await lock.release();}
  assert.equal(result.status,'needs-reconciliation');assert.equal(result.receipt.status,'uncertain');
  const recovery=await inspectRecovery(f.a,result.recoveryPath);
  assert.equal(recovery.statePhase,'pending');assert.equal(recovery.status,'needs-reconciliation');
  if(fault==='drift')assert.equal(await readFile(path.join(f.a,'AGENTS.md'),'utf8'),'foreign edit');
  else {
    assert.deepEqual(recovery.diagnostics,[]);assert.equal(recovery.targets[0].position,'desired');
    const continuation=await prepareContinuation(f.a,result.recoveryPath);
    assert.equal(continuation.preview.plan.command,'remove');
    assert.equal(continuation.preview.plan.targets[0].action,'verify-absent');
  }
});

for(const partial of [false,true])test('removal continuation records absence and remaining writes '+partial,async()=>{
  const f=await approvedFixture({providers:['codex','claude'],
    codex:{plan:()=>[{path:'.codex/a.md',owner:'codex',kind:'file',bytes:Buffer.from('a')},{path:'.codex/b.md',owner:'codex',kind:'file',bytes:Buffer.from('b')}]},
    claude:{plan:()=>[{path:'.claude/c.md',owner:'claude',kind:'file',bytes:Buffer.from('c')}]}});
  await applyLifecycle({command:'setup',wrapper:f.a,prepared:f.prepared,approval:f.approval},f.registry);
  const remove=await prepareRemoval(f.a,f.registry,partial?{providers:['codex']}:{});
  let lock=await acquireWorkspaceLock(f.a),old;
  try{old=await applyRemoval(lock,remove,{decision:'approve',preparedDigest:remove.digest},f.registry,
    {ioBoundary:async e=>{if(e.purpose==='target' && e.phase==='deleted')throw new Error('synthetic interruption');}});}
  finally{await lock.release();}
  const history=await readFile(path.join(f.a,old.recoveryPath)),other=await workspaceHashes(f.b);
  const prepared=await prepareContinuation(f.a,old.recoveryPath);
  assert.ok(prepared.preview.plan.targets.some(t=>t.action==='verify-absent'));
  assert.ok(prepared.preview.plan.targets.some(t=>t.action==='delete'));
  lock=await acquireWorkspaceLock(f.a);let result;const writes=[];
  try {
    await assert.rejects(()=>applyContinuation(lock,prepared,{decision:'approve',preparedDigest:remove.digest}),e=>e.code==='reconciliation.approval');
    let finalPrepared=prepared;
    if(!partial) {
      let journal;
      await assert.rejects(()=>applyContinuation(lock,prepared,{decision:'approve',preparedDigest:prepared.digest},{
        onJournal:async e=>{journal=e.relative;},boundary:async phase=>{if(phase==='write')throw new Error('second interruption');}
      }));
      const recovery=journal.replace('/journals/','/transactions/')+'/recovery.json';
      finalPrepared=await prepareContinuation(f.a,recovery);
      assert.equal(finalPrepared.evidence.lineage.length,1);
    }
    result=await applyContinuation(lock,finalPrepared,{decision:'approve',preparedDigest:finalPrepared.digest},{ioBoundary:async e=>{
      if(e.purpose==='target')writes.push(e.path);
    }});
  }finally{await lock.release();}
  assert.equal(result.status,partial?'ready':'not-installed');
  assert.ok(!writes.includes(prepared.actions.find(a=>a.action==='verify-readback').path));
  assert.equal((await inspectRecovery(f.a,result.recoveryPath)).status,'applied');
  const doctor=await inspectInstallation(f.a);assert.deepEqual(doctor.diagnostics,[]);
  assert.equal(doctor.status,partial?'ready':'not-installed');
  assert.deepEqual(await readFile(path.join(f.a,old.recoveryPath)),history);
  assert.deepEqual(await workspaceHashes(f.b),other);
});

for(const scenario of ['restore','file-backup','field-backup','foreign-drift','target-drift','late-backup'])
test('removal restore continuation '+scenario,async()=>{
  const original=Buffer.from('original entry'),entry=Buffer.from('entry'),json=Buffer.from('{"managed":false,"foreign":"old"}');
  const f=await approvedFixture({seed:{'AGENTS.md':original,'.codex/test.json':json},
    sharedPlan:()=>[{path:'AGENTS.md',owner:'shared',kind:'file',bytes:entry,takeover:{beforeHash:sha256(original),desiredHash:sha256(entry)}}],
    codex:{plan:()=>[{path:'.codex/test.json',owner:'codex',kind:'json-fields',fields:[{pointer:'/managed',present:true,value:true,
      takeover:{beforeHash:contractDigest(false),desiredHash:contractDigest(true)}}]}]}});
  await applyLifecycle({command:'setup',wrapper:f.a,prepared:f.prepared,approval:f.approval},f.registry);
  await writeFile(path.join(f.a,'.codex/test.json'),'{"managed":true,"foreign":"current","extra":7}');
  const removal=await prepareRemoval(f.a,f.registry),lock=await acquireWorkspaceLock(f.a);let journal;
  try {
    await assert.rejects(()=>applyRemoval(lock,removal,{decision:'approve',preparedDigest:removal.digest},f.registry,{
      onJournal:async e=>{journal=e.relative;},boundary:async phase=>{if(phase==='pending')throw new Error('synthetic stop before targets');}
    }));
    const recovery=journal.replace('/journals/','/transactions/')+'/recovery.json';
    const history=await workspaceHashes(path.join(f.a,journal)),oldRecord=await readFile(path.join(f.a,recovery));
    const prepared=await prepareContinuation(f.a,recovery),approval={decision:'approve',preparedDigest:prepared.digest};
    const previous=(await readState(path.join(f.a,'.pipeline/state.json'))).value;
    const fileBackup=previous.active.owned.find(o=>o.kind==='file').backup;
    const fieldBackup=previous.active.owned.find(o=>o.kind==='field').backup;
    if(scenario==='file-backup')await writeFile(path.join(f.a,fileBackup),'corrupted');
    if(scenario==='field-backup')await writeFile(path.join(f.a,fieldBackup),'{"managed":false,"foreign":"tampered backup"}');
    if(scenario==='foreign-drift')await writeFile(path.join(f.a,'.codex/test.json'),'{"managed":true,"foreign":"new user edit","extra":7}');
    if(scenario==='target-drift')await writeFile(path.join(f.a,'AGENTS.md'),'new user entry');
    const before=await workspaceHashes(f.a),other=await workspaceHashes(f.b);
    if(['file-backup','field-backup','foreign-drift','target-drift'].includes(scenario)) {
      await assert.rejects(()=>applyContinuation(lock,prepared,approval),e=>e.code==='reconciliation.conflict');
      assert.deepEqual(await workspaceHashes(f.a),before);
    }else if(scenario==='late-backup') {
      await assert.rejects(()=>applyContinuation(lock,prepared,approval,{boundary:async phase=>{
        if(phase==='before-active')await writeFile(path.join(f.a,fileBackup),'late corruption');
      }}),e=>e.code==='backup.mismatch');
      const state=(await readState(path.join(f.a,'.pipeline/state.json'))).value;
      assert.equal(state.status,'needs-reconciliation');assert.deepEqual(state.active,previous.active);
      assert.deepEqual(await readFile(path.join(f.a,'AGENTS.md')),original);
    }else {
      const result=await applyContinuation(lock,prepared,approval);
      assert.equal(result.status,'not-installed');
      assert.deepEqual(await readFile(path.join(f.a,'AGENTS.md')),original);
      assert.deepEqual(JSON.parse(await readFile(path.join(f.a,'.codex/test.json'),'utf8')),{managed:false,foreign:'current',extra:7});
      assert.deepEqual(await readFile(path.join(f.a,fileBackup)),original);
      assert.deepEqual(await readFile(path.join(f.a,fieldBackup)),json);
      assert.equal((await inspectRecovery(f.a,result.recoveryPath)).status,'applied');
    }
    assert.deepEqual(await workspaceHashes(f.b),other);
    assert.deepEqual(await workspaceHashes(path.join(f.a,journal)),history);
    assert.deepEqual(await readFile(path.join(f.a,recovery)),oldRecord);
  }finally{await lock.release();}
});

test('repeated removal activation distinguishes cycles without hiding old evidence',async()=>{
  let original=Buffer.from('original first');const entry=Buffer.from('entry');
  const f=await approvedFixture({seed:{'AGENTS.md':original},sharedPlan:()=>[{path:'AGENTS.md',owner:'shared',kind:'file',bytes:entry,
    takeover:{beforeHash:sha256(original),desiredHash:sha256(entry)}}]});
  const states=[],removals=[];
  for(let cycle=0;cycle<2;cycle++) {
    const prepared=cycle===0?f.prepared:await prepareLifecycle({command:'setup',wrapper:f.a,manifestPath:f.manifestPath},f.registry);
    const setup=await applyLifecycle({command:'setup',wrapper:f.a,prepared,approval:{decision:'approve',preparedDigest:prepared.digest}},f.registry);
    assert.equal(setup.status,'ready');
    const removal=await prepareRemoval(f.a,f.registry),lock=await acquireWorkspaceLock(f.a);let result;
    try{result=await applyRemoval(lock,removal,{decision:'approve',preparedDigest:removal.digest},f.registry);}
    finally{await lock.release();}
    assert.equal(result.status,'not-installed');removals.push(result);
    states.push(await readFile(path.join(f.a,'.pipeline/state.json')));
    if(cycle===0) {
      assert.equal((await inspectInstallation(f.a)).status,'not-installed');
      original=Buffer.from('original second');await writeFile(path.join(f.a,'AGENTS.md'),original);
    }
  }
  assert.notDeepEqual(states[0],states[1]);assert.notEqual(removals[0].recoveryPath,removals[1].recoveryPath);
  assert.equal(JSON.parse(states[1]).activation.recovery,removals[1].recoveryPath);
  assert.equal((await inspectRecovery(f.a,removals[1].recoveryPath)).status,'applied');
  const before=await workspaceHashes(f.a),other=await workspaceHashes(f.b);
  for(const options of [{},{recoveryPath:removals[1].recoveryPath}]) {
    const doctor=await inspectInstallation(f.a,options);
    assert.equal(doctor.status,'not-installed',JSON.stringify(doctor.diagnostics));
    assert.deepEqual(doctor.diagnostics,[]);
  }
  assert.deepEqual(await workspaceHashes(f.a),before);assert.deepEqual(await workspaceHashes(f.b),other);
  const stale=await inspectInstallation(f.a,{recoveryPath:removals[0].recoveryPath});
  assert.ok(stale.diagnostics.some(d=>d.code==='doctor.activation-selection'));
  // Backward-compatible unanchored state retains conservative behavior.
  const state=JSON.parse(states[1]),legacy={...state};delete legacy.activation;
  await writeFile(path.join(f.a,'.pipeline/state.json'),JSON.stringify(legacy));
  assert.equal((await inspectInstallation(f.a)).status,'needs-reconciliation');
  await writeFile(path.join(f.a,'.pipeline/state.json'),states[1]);
  state.activation.journalHead.hash='sha256:'+'0'.repeat(64);
  await writeFile(path.join(f.a,'.pipeline/state.json'),JSON.stringify(state));
  assert.ok((await inspectInstallation(f.a)).diagnostics.some(d=>d.code==='doctor.activation-binding'));
  await writeFile(path.join(f.a,'.pipeline/state.json'),states[1]);
  const name=path.join(f.a,removals[0].recoveryPath),old=JSON.parse(await readFile(name,'utf8'));
  old.approval.preparedDigest='sha256:'+'0'.repeat(64);await writeFile(name,JSON.stringify(old));
  const invalid=await inspectInstallation(f.a);
  assert.equal(invalid.status,'needs-reconciliation');assert.ok(invalid.history.diagnostics.length);
});

for(const scenario of ['clean','target-drift','missing-removal','wrong-selection','corrupt-removal'])
test('doctor removal history '+scenario+' stays read-only',async()=>{
  const f=await approvedFixture();
  const first=await applyLifecycle({command:'setup',wrapper:f.a,prepared:f.prepared,approval:f.approval},f.registry);
  let removed;
  if(scenario==='missing-removal') {
    const state=(await readState(path.join(f.a,'.pipeline/state.json'))).value;
    await writeFile(path.join(f.a,'.pipeline/state.json'),JSON.stringify({...state,status:'not-installed',active:null,pending:null}));
  }else {
    const prepared=await prepareRemoval(f.a,f.registry),lock=await acquireWorkspaceLock(f.a);
    try{removed=await applyRemoval(lock,prepared,{decision:'approve',preparedDigest:prepared.digest},f.registry);}
    finally{await lock.release();}
  }
  if(scenario==='target-drift')await writeFile(path.join(f.a,'AGENTS.md'),'unexpected recreation');
  if(scenario==='corrupt-removal') {
    const name=path.join(f.a,removed.recoveryPath),value=JSON.parse(await readFile(name,'utf8'));
    value.approval.preparedDigest='sha256:'+'0'.repeat(64);
    await writeFile(name,JSON.stringify(value));
  }
  const before=await workspaceHashes(f.a),other=await workspaceHashes(f.b);
  const options=scenario==='wrong-selection'?{recoveryPath:first.recoveryPath}:{};
  // Lifecycle reporting may wrap its result; use the known setup journal when
  // constructing explicit old selection rather than guessing latest evidence.
  if(scenario==='wrong-selection') {
    const dirs=await readdir(path.join(f.a,'.pipeline/transactions'));
    options.recoveryPath=dirs.map(id=>'.pipeline/transactions/'+id+'/recovery.json').find(p=>p!==removed.recoveryPath);
  }
  const result=await inspectInstallation(f.a,options);
  assert.equal(result.ready,false);
  if(scenario==='clean') {
    assert.equal(result.status,'not-installed');assert.equal(result.configuration,'not-installed');
    assert.equal(result.transactionEvidence,'pass');assert.deepEqual(result.diagnostics,[]);
  }else {
    assert.equal(result.status,'needs-reconciliation');assert.ok(result.diagnostics.length);
    if(scenario==='missing-removal')assert.ok(result.diagnostics.some(d=>d.code==='doctor.transaction-missing'));
  }
  assert.deepEqual(await workspaceHashes(f.a),before);assert.deepEqual(await workspaceHashes(f.b),other);
});

test('repair preserves historical file and field backups and refuses corrupt backup before writes',async()=>{
  const original=Buffer.from('original entry'),json=Buffer.from('{"managed":false,"foreign":"original"}'),desired=Buffer.from('entry');
  const f=await approvedFixture({seed:{'AGENTS.md':original,'.codex/test.json':json},
    sharedPlan:()=>[{path:'AGENTS.md',owner:'shared',kind:'file',bytes:desired,takeover:{beforeHash:sha256(original),desiredHash:sha256(desired)}}],
    codex:{plan:()=>[{path:'.codex/test.json',owner:'codex',kind:'json-fields',fields:[{pointer:'/managed',present:true,value:true,
      takeover:{beforeHash:contractDigest(false),desiredHash:contractDigest(true)}}]}]}});
  const lock=await acquireWorkspaceLock(f.a);
  try {
    const first=await applyPrepared(lock,f.prepared,f.approval,f.registry);
    const owned=first.state.active.owned,file=owned.find(o=>o.kind==='file'),field=owned.find(o=>o.kind==='field');
    await rename(path.join(f.a,'AGENTS.md'),path.join(f.a,'AGENTS.saved'));
    await writeFile(path.join(f.a,'.codex/test.json'),'{"foreign":"current"}');
    const prepared=await prepareRepairPlan(f.a,f.registry),approval={decision:'approve',preparedDigest:prepared.digest};
    await writeFile(path.join(f.a,file.backup),'corrupt');
    const before=await workspaceHashes(f.a);
    await assert.rejects(()=>applyRepair(lock,prepared,approval,f.registry),e=>e.code==='apply.backup-lineage');
    assert.deepEqual(await workspaceHashes(f.a),before);
    await writeFile(path.join(f.a,file.backup),original);
    const result=await applyRepair(lock,prepared,approval,f.registry);
    assert.equal(result.status,'ready');assert.deepEqual(result.state.active.owned,owned);
    assert.deepEqual(await readFile(path.join(f.a,file.backup)),original);
    assert.deepEqual(await readFile(path.join(f.a,field.backup)),json);
    assert.deepEqual(JSON.parse(await readFile(path.join(f.a,'.codex/test.json'),'utf8')),{foreign:'current',managed:true});
  }finally{await lock.release();}
});

for(const entry of ['repair','continuation'])for(const corruption of ['backup','recovery'])
test(`new entrypoint ${entry} rejects ${corruption} corruption before activation`,async()=>{
  const original=Buffer.from('original'),desired=Buffer.from('entry');
  const f=await approvedFixture({seed:{'AGENTS.md':original},sharedPlan:()=>[{path:'AGENTS.md',owner:'shared',kind:'file',bytes:desired,
    takeover:{beforeHash:sha256(original),desiredHash:sha256(desired)}}]}),lock=await acquireWorkspaceLock(f.a);
  try {
    let prepared;
    if(entry==='repair') {
      await applyPrepared(lock,f.prepared,f.approval,f.registry);
      await rename(path.join(f.a,'AGENTS.md'),path.join(f.a,'AGENTS.saved'));
      prepared=await prepareRepairPlan(f.a,f.registry);
    }else {
      await assert.rejects(()=>applyPrepared(lock,f.prepared,f.approval,f.registry,null,{boundary:async phase=>{if(phase==='write')throw Error('stop');}}));
      prepared=await prepareContinuation(f.a,await recoveryFile(f.a));
    }
    const before=(await readState(path.join(f.a,'.pipeline/state.json'))).value,backup=f.prepared.preview.plan.desired.owned[0].backup;
    let journal;
    const options={onJournal:async e=>{journal=e.relative;},boundary:async phase=>{
      if(phase==='before-active') {
        const relative=corruption==='backup'?backup:'.pipeline/transactions/'+journal.split('/').at(-1)+'/recovery.json';
        const filename=path.join(f.a,relative),bytes=await readFile(filename);
        await writeFile(filename,Buffer.concat([bytes,Buffer.from(' ')]));
      }
    }};
    const approval={decision:'approve',preparedDigest:prepared.digest};
    const apply=()=>entry==='repair'?applyRepair(lock,prepared,approval,f.registry,options):applyContinuation(lock,prepared,approval,options);
    await assert.rejects(apply,e=>e.code===(corruption==='backup'?'backup.mismatch':'apply.recovery-drift'));
    const after=(await readState(path.join(f.a,'.pipeline/state.json'))).value;
    assert.equal(after.status,'needs-reconciliation');assert.notEqual(after.pending,null);
    assert.equal(contractDigest(after.active),contractDigest(before.active));
    assert.equal((await inspectInstallation(f.a)).ready,false);
  }finally{await lock.release();}
});

test('continuation proposal separates uncertain readback and skipped writes with fresh approval',async()=>{
  const f=await approvedFixture({codex:{plan:()=>[{path:'.codex/test.json',owner:'codex',kind:'json-fields',
    fields:[{pointer:'/ours',present:true,value:false}]}]}});
  const lock=await acquireWorkspaceLock(f.a);
  try {
    await assert.rejects(()=>applyPrepared(lock,f.prepared,f.approval,f.registry,null,
      {boundary:async phase=>{if(phase==='write')throw Error('stop');}}));
    const relative=await recoveryFile(f.a),before=await workspaceHashes(f.a),proposal=await prepareContinuation(f.a,relative);
    assert.equal(proposal.actions.length,2);
    assert.equal(proposal.actions[0].action,'verify-readback');assert.equal(proposal.actions[0].recorded,'uncertain');
    assert.equal(proposal.actions[1].action,'write-desired');assert.equal(proposal.actions[1].recorded,'skipped');
    assert.equal(proposal.applySupported,true);assert.ok(proposal.evidence.journalHead.hash);
    await assert.rejects(()=>verifyContinuationApproval(lock,proposal,f.approval),e=>e.code==='reconciliation.approval');
    assert.deepEqual(await verifyContinuationApproval(lock,proposal,{decision:'approve',preparedDigest:proposal.digest}),proposal);
    assert.deepEqual(await workspaceHashes(f.a),before);
    const forged=structuredClone(proposal);forged.actions[0].bytes=Buffer.from('forged').toString('base64');
    const {digest,...body}=forged;forged.digest=contractDigest(body);
    await assert.rejects(()=>verifyContinuationApproval(lock,forged,{decision:'approve',preparedDigest:forged.digest}),e=>e.code==='reconciliation.plan-drift');
    const head=proposal.evidence.journalHead;
    await writeFile(path.join(f.a,proposal.evidence.journal,String(head.sequence).padStart(6,'0')+'.json'),JSON.stringify({
      schemaVersion:1,seq:head.sequence,previous:head.hash,planDigest:contractDigest(f.prepared.preview.plan),
      kind:'outcome',payload:{status:'completed',observedHash:proposal.actions[0].desiredHash}})+'\n');
    await assert.rejects(()=>verifyContinuationApproval(lock,proposal,{decision:'approve',preparedDigest:proposal.digest}),e=>e.code==='reconciliation.plan-drift');
    await writeFile(path.join(f.a,proposal.actions[0].path),'user change');
    await assert.rejects(()=>prepareContinuation(f.a,relative),e=>e.code==='reconciliation.conflict');
  }finally{await lock.release();}
});

test('continuation proposal excludes nonpending successful transactions',async()=>{
  const f=await approvedFixture();await applyLifecycle({command:'setup',wrapper:f.a,prepared:f.prepared,approval:f.approval},f.registry);
  const before=await workspaceHashes(f.a);
  const relative=await recoveryFile(f.a);
  await assert.rejects(()=>prepareContinuation(f.a,relative),e=>e.code==='reconciliation.not-pending');
  assert.deepEqual(await workspaceHashes(f.a),before);
});

test('doctor resolves exact continued history across later update without concealing invalid evidence',async()=>{
  const f=await approvedFixture(),lock=await acquireWorkspaceLock(f.a);let oldPath,result;
  try {
    await assert.rejects(()=>applyPrepared(lock,f.prepared,f.approval,f.registry,null,{boundary:async phase=>{if(phase==='write')throw Error('stop');}}));
    oldPath=await recoveryFile(f.a);const proposal=await prepareContinuation(f.a,oldPath);
    result=await applyContinuation(lock,proposal,{decision:'approve',preparedDigest:proposal.digest});
  }finally{await lock.release();}
  const before=await workspaceHashes(f.a),doctor=await inspectInstallation(f.a);
  assert.equal(doctor.ready,true,JSON.stringify(doctor.diagnostics));
  const old=doctor.history.entries.find(e=>e.recovery===oldPath);
  assert.equal(old.status,'uncertain');assert.equal(old.resolution,'continued');assert.deepEqual(old.resolvedBy,[result.recoveryPath]);
  assert.equal(old.protected,true);assert.deepEqual(await workspaceHashes(f.a),before);
  const proof=await inspectRecovery(f.a,result.recoveryPath,{evidenceOnly:true});
  assert.equal(proof.status,'completed-evidence');assert.equal(proof.activation,'not-verified');
  assert.equal(proof.currentTargets,'not-verified');
  const registry={...f.registry,sharedAdapter:{plan:()=>[{path:'AGENTS.md',kind:'file',owner:'shared',bytes:Buffer.from('updated entry')}]}};
  const update=await prepareLifecycle({command:'update',wrapper:f.a,manifestPath:f.manifestPath},registry);
  const applied=await applyLifecycle({command:'update',wrapper:f.a,prepared:update,approval:{decision:'approve',preparedDigest:update.digest}},registry);
  assert.equal(applied.status,'ready',JSON.stringify(applied));
  const afterUpdate=await inspectInstallation(f.a);
  assert.equal(afterUpdate.ready,true,JSON.stringify(afterUpdate.diagnostics));
  assert.equal(afterUpdate.history.entries.find(e=>e.recovery===oldPath).resolution,'continued');
  const filename=path.join(f.a,result.recoveryPath),record=JSON.parse(await readFile(filename,'utf8'));
  record.approval.preparedDigest='sha256:'+'0'.repeat(64);await writeFile(filename,JSON.stringify(record));
  const broken=await inspectInstallation(f.a);
  assert.equal(broken.ready,false);assert.ok(broken.history.diagnostics.some(d=>d.code==='history.unfinished'));
  assert.ok(broken.history.diagnostics.some(d=>d.code==='reconciliation.approval'));
});

test('continuation executor uses separate journal and never rewrites desired target or old evidence',async()=>{
  const f=await approvedFixture({codex:{plan:()=>[{path:'.codex/test.json',owner:'codex',kind:'json-fields',
    fields:[{pointer:'/ours',present:true,value:false}]}]}}),lock=await acquireWorkspaceLock(f.a);
  try {
    await assert.rejects(()=>applyPrepared(lock,f.prepared,f.approval,f.registry,null,{boundary:async phase=>{if(phase==='write')throw Error('stop');}}));
    const oldPath=await recoveryFile(f.a),proposal=await prepareContinuation(f.a,oldPath);
    const oldBytes=await readFile(path.join(f.a,oldPath)),oldJournal=await workspaceHashes(path.join(f.a,proposal.evidence.journal));
    const writes=[];
    const result=await applyContinuation(lock,proposal,{decision:'approve',preparedDigest:proposal.digest},
      {ioBoundary:async event=>{if(event.purpose==='target' && event.phase==='opened')writes.push(event.path);}});
    assert.equal(result.status,'ready');assert.deepEqual(writes,[proposal.actions[1].path]);
    assert.notEqual(result.recoveryPath,oldPath);
    assert.deepEqual(await readFile(path.join(f.a,oldPath)),oldBytes);
    assert.deepEqual(await workspaceHashes(path.join(f.a,proposal.evidence.journal)),oldJournal);
    assert.equal((await inspectRecovery(f.a,result.recoveryPath)).status,'applied');
    assert.equal((await inspectRecovery(f.a,oldPath)).status,'needs-reconciliation');
  }finally{await lock.release();}
});

test('continuation executor recovers two interruptions while preserving complete ancestry',async()=>{
  const f=await approvedFixture(),lock=await acquireWorkspaceLock(f.a);let newJournal,finished;
  try {
    await assert.rejects(()=>applyPrepared(lock,f.prepared,f.approval,f.registry,null,{boundary:async phase=>{if(phase==='write')throw Error('stop');}}));
    const oldPath=await recoveryFile(f.a),proposal=await prepareContinuation(f.a,oldPath),oldJournal=await workspaceHashes(path.join(f.a,proposal.evidence.journal));
    await assert.rejects(()=>applyContinuation(lock,proposal,{decision:'approve',preparedDigest:proposal.digest},
      {onJournal:async e=>{newJournal=e.relative;},boundary:async phase=>{if(phase==='write')throw Error('again');}}));
    const relative='.pipeline/transactions/'+newJournal.split('/').at(-1)+'/recovery.json';
    const result=await inspectRecovery(f.a,relative);
    assert.equal(result.statePhase,'pending');assert.equal(result.status,'needs-reconciliation');
    assert.equal(result.targets[0].recorded,'uncertain');
    assert.deepEqual(await workspaceHashes(path.join(f.a,proposal.evidence.journal)),oldJournal);
    const second=await prepareContinuation(f.a,relative);
    assert.equal(second.evidence.lineage.length,1);
    const intermediate=await workspaceHashes(path.join(f.a,newJournal));
    finished=await applyContinuation(lock,second,{decision:'approve',preparedDigest:second.digest});
    assert.equal(finished.status,'ready');
    assert.deepEqual(await workspaceHashes(path.join(f.a,proposal.evidence.journal)),oldJournal);
    assert.deepEqual(await workspaceHashes(path.join(f.a,newJournal)),intermediate);
    const proof=await inspectRecovery(f.a,finished.recoveryPath,{evidenceOnly:true});
    assert.equal(proof.lineage.length,2);
  }finally{await lock.release();}
  const doctor=await inspectInstallation(f.a);
  assert.equal(doctor.ready,true,JSON.stringify(doctor.diagnostics));
  assert.equal(doctor.history.entries.filter(e=>e.resolution==='continued').length,2);
  const evidence=JSON.parse(await readFile(path.join(f.a,finished.recoveryPath),'utf8'));
  const ancestor=evidence.prepared.evidence.lineage[0].recovery;
  const filename=path.join(f.a,ancestor),bytes=await readFile(filename,'utf8');
  await writeFile(filename,bytes+' ');
  const corrupt=await inspectInstallation(f.a);
  assert.equal(corrupt.ready,false);assert.ok(corrupt.history.diagnostics.some(d=>d.code==='reconciliation.lineage'));
});

test('doctor after field repair checks all history by ownership without hiding corruption',async()=>{
  const f=await approvedFixture({codex:{plan:()=>[{path:'.codex/test.json',owner:'codex',kind:'json-fields',
    fields:[{pointer:'/ours',present:true,value:false}]}]}});
  const setup=await applyLifecycle({command:'setup',wrapper:f.a,prepared:f.prepared,approval:f.approval},f.registry);
  const initialRecovery=await recoveryFile(f.a);
  await writeFile(path.join(f.a,'.codex/test.json'),'{"foreign":"keep"}');
  const prepared=await prepareRepairPlan(f.a,f.registry),lock=await acquireWorkspaceLock(f.a);let repaired;
  try{repaired=await applyRepair(lock,prepared,{decision:'approve',preparedDigest:prepared.digest},f.registry);}
  finally{await lock.release();}
  assert.equal(setup.status,'ready');assert.equal(repaired.status,'ready');
  const before=await workspaceHashes(f.a),doctor=await inspectInstallation(f.a);
  assert.equal(doctor.ready,true,JSON.stringify(doctor.diagnostics));assert.deepEqual(doctor.matchingTransactions,[repaired.recoveryPath]);
  assert.equal(doctor.history.entries.length,2);assert.deepEqual(doctor.history.diagnostics,[]);
  const strict=await inspectRecovery(f.a,initialRecovery);
  assert.equal(strict.status,'needs-reconciliation');assert.deepEqual(strict.fieldProjections,[]);
  const scoped=await inspectRecovery(f.a,initialRecovery,{fieldOwnershipOnly:true});
  assert.equal(scoped.status,'needs-reconciliation');assert.ok(scoped.diagnostics.includes('recovery.activation-binding'));
  assert.equal(scoped.targets.find(t=>t.path==='.codex/test.json').position,'desired-owned-fields');
  assert.equal((await inspectRecovery(f.a,initialRecovery,{evidenceOnly:true})).status,'completed-evidence');
  assert.deepEqual(await workspaceHashes(f.a),before);
  await writeFile(path.join(f.a,'.codex/test.json'),'{"foreign":"keep","ours":true}');
  assert.equal((await inspectInstallation(f.a)).ready,false);
  await writeFile(path.join(f.a,'.codex/test.json'),'{"foreign":"keep","ours":false}');
  const filename=path.join(f.a,initialRecovery),record=JSON.parse(await readFile(filename,'utf8'));
  record.approval.preparedDigest='sha256:'+'0'.repeat(64);await writeFile(filename,JSON.stringify(record));
  const corrupted=await inspectInstallation(f.a,{recoveryPath:repaired.recoveryPath});
  assert.equal(corrupted.ready,false);assert.ok(corrupted.diagnostics.some(d=>d.code==='apply.approval'));
});

test('repair executor restores missing file offline and records applied recovery',async()=>{
  const f=await approvedFixture();await applyLifecycle({command:'setup',wrapper:f.a,prepared:f.prepared,approval:f.approval},f.registry);
  const previous=(await readState(path.join(f.a,'.pipeline/state.json'))).value;
  await rename(path.join(f.a,'AGENTS.md'),path.join(f.a,'AGENTS.saved'));
  const source=previous.active.snapshot.origin.resolvedSource;assert.ok(source.startsWith(f.root+path.sep));
  await rename(source,source+'-offline');await rename(f.manifestPath,f.manifestPath+'.offline');
  const prepared=await prepareRepairPlan(f.a,f.registry),lock=await acquireWorkspaceLock(f.a);let result;
  try {result=await applyRepair(lock,prepared,{decision:'approve',preparedDigest:prepared.digest},f.registry);}
  finally{await lock.release();}
  assert.equal(result.status,'ready');assert.equal(await readFile(path.join(f.a,'AGENTS.md'),'utf8'),'entry');
  assert.deepEqual(result.state.active,structuredClone(previous.active));
  const recovered=await inspectRecovery(f.a,result.recoveryPath);
  assert.equal(recovered.status,'applied');assert.deepEqual(recovered.diagnostics,[]);
});

test('repair executor preserves foreign fields and interrupted write remains uncertain',async()=>{
  const f=await approvedFixture({codex:{plan:()=>[{path:'.codex/test.json',owner:'codex',kind:'json-fields',
    fields:[{pointer:'/ours',present:true,value:false}]}]}});
  await applyLifecycle({command:'setup',wrapper:f.a,prepared:f.prepared,approval:f.approval},f.registry);
  await writeFile(path.join(f.a,'.codex/test.json'),'{"foreign":"keep"}');
  const prepared=await prepareRepairPlan(f.a,f.registry),lock=await acquireWorkspaceLock(f.a);let journal;
  try {await assert.rejects(()=>applyRepair(lock,prepared,{decision:'approve',preparedDigest:prepared.digest},f.registry,
    {onJournal:async event=>{journal=event.relative;},boundary:async phase=>{if(phase==='write')throw Error('interrupted');}}));}
  finally{await lock.release();}
  assert.deepEqual(JSON.parse(await readFile(path.join(f.a,'.codex/test.json'),'utf8')),{foreign:'keep',ours:false});
  const recovery='.pipeline/transactions/'+journal.split('/').at(-1)+'/recovery.json';
  const result=await inspectRecovery(f.a,recovery);
  assert.equal(result.status,'needs-reconciliation');assert.equal(result.statePhase,'pending');
  assert.equal(result.targets[0].recorded,'uncertain');assert.equal(result.targets[0].position,'desired');
  await writeFile(path.join(f.a,'.codex/test.json'),'{"foreign":"changed","ours":false}');
  const scoped=await inspectRecovery(f.a,recovery,{fieldOwnershipOnly:true});
  assert.equal(scoped.status,'needs-reconciliation');assert.deepEqual(scoped.fieldProjections,[]);
  assert.equal((await inspectInstallation(f.a)).ready,false);
});

test('native repair plan preserves deployment and works offline with fresh locked approval',async()=>{
  const f=await approvedFixture();await applyLifecycle({command:'setup',wrapper:f.a,prepared:f.prepared,approval:f.approval},f.registry);
  const previous=(await readState(path.join(f.a,'.pipeline/state.json'))).value;
  const source=previous.active.snapshot.origin.resolvedSource;assert.ok(source.startsWith(f.root+path.sep));
  await rename(source,source+'-offline');await rename(f.manifestPath,f.manifestPath+'.offline');
  await rename(path.join(f.a,'AGENTS.md'),path.join(f.a,'AGENTS.saved'));
  const before=await workspaceHashes(f.a),prepared=await prepareRepairPlan(f.a,f.registry);
  assert.equal(prepared.preview.plan.command,'repair');assert.deepEqual(prepared.preview.plan.desired,structuredClone(previous.active));
  assert.equal(prepared.preview.plan.targets[0].action,'create');assert.deepEqual(prepared.preview.plan.targets[0].fields,[]);
  assert.deepEqual(await workspaceHashes(f.a),before);
  const lock=await acquireWorkspaceLock(f.a);
  try {
    await assert.rejects(()=>verifyRepairApproval(lock,prepared,f.approval,f.registry),e=>e.code==='repair.approval');
    assert.deepEqual(await verifyRepairApproval(lock,prepared,{decision:'approve',preparedDigest:prepared.digest},f.registry),prepared);
    await assert.rejects(()=>applyPrepared(lock,prepared,{decision:'approve',preparedDigest:prepared.digest},f.registry,previous));
  }finally{await lock.release();}
  assert.deepEqual(await workspaceHashes(f.a),before);
});

test('native repair plan binds foreign siblings and unchanged dependencies without taking ownership',async()=>{
  const f=await approvedFixture({codex:{plan:()=>[{path:'.codex/test.json',owner:'codex',kind:'json-fields',
    fields:[{pointer:'/ours',present:true,value:false}]}]}});
  await applyLifecycle({command:'setup',wrapper:f.a,prepared:f.prepared,approval:f.approval},f.registry);
  await writeFile(path.join(f.a,'.codex/test.json'),'{"foreign":1}');
  const prepared=await prepareRepairPlan(f.a,f.registry),target=prepared.preview.plan.targets[0];
  assert.equal(target.action,'edit-fields');assert.equal(target.fields[0].beforeHash,null);
  assert.equal(prepared.preview.observations.length,2);
  const lock=await acquireWorkspaceLock(f.a),approval={decision:'approve',preparedDigest:prepared.digest};
  try {
    await writeFile(path.join(f.a,'.codex/test.json'),'{"foreign":2}');
    await assert.rejects(()=>verifyRepairApproval(lock,prepared,approval,f.registry),e=>e.code==='repair.plan-drift');
    await writeFile(path.join(f.a,'.codex/test.json'),'{"foreign":1}');
    await writeFile(path.join(f.a,'AGENTS.md'),'user change');
    await assert.rejects(()=>verifyRepairApproval(lock,prepared,approval,f.registry),e=>e.code==='repair.conflict');
  }finally{await lock.release();}
});

test('native repair plan creates absent JSON files and rejects rehashed forged payload',async()=>{
  const f=await approvedFixture({codex:{plan:()=>[{path:'.codex/test.json',owner:'codex',kind:'json-fields',
    fields:[{pointer:'/ours',present:true,value:null}]}]}});
  await applyLifecycle({command:'setup',wrapper:f.a,prepared:f.prepared,approval:f.approval},f.registry);
  await rename(path.join(f.a,'.codex/test.json'),path.join(f.a,'.codex/test.saved'));
  const prepared=await prepareRepairPlan(f.a,f.registry);
  assert.equal(prepared.preview.plan.targets[0].action,'create');assert.deepEqual(prepared.preview.plan.targets[0].fields,[]);
  const forged=structuredClone(prepared);forged.preview.outputs[0].bytes=Buffer.from('forged').toString('base64');
  const {digest,...body}=forged;forged.digest=contractDigest(body);
  const lock=await acquireWorkspaceLock(f.a);
  try {await assert.rejects(()=>verifyRepairApproval(lock,forged,{decision:'approve',preparedDigest:forged.digest},f.registry),e=>e.code==='repair.plan-drift');}
  finally{await lock.release();}
});

test('repair preview supplies exact missing file bytes without writing or approving',async()=>{
  const f=await approvedFixture();await applyLifecycle({command:'setup',wrapper:f.a,prepared:f.prepared,approval:f.approval},f.registry);
  await rename(path.join(f.a,'AGENTS.md'),path.join(f.a,'AGENTS.saved'));
  const before=await workspaceHashes(f.a),preview=await prepareRepairPreview(f.a,f.registry);
  assert.equal(preview.targets.length,1);assert.equal(preview.targets[0].beforeHash,null);
  assert.equal(Buffer.from(preview.outputs[0].bytes,'base64').toString(),'entry');
  assert.equal(preview.targets[0].desiredHash,sha256(Buffer.from('entry')));
  assert.equal(preview.applySupported,false);assert.equal(preview.requiresFreshApproval,true);
  assert.deepEqual(await workspaceHashes(f.a),before);
});

test('repair preview fills only missing fields and blocks whole preview on user conflict',async()=>{
  const f=await approvedFixture({codex:{plan:()=>[{path:'.codex/test.json',owner:'codex',kind:'json-fields',
    fields:[{pointer:'/ours',present:true,value:null}]}]}});
  await applyLifecycle({command:'setup',wrapper:f.a,prepared:f.prepared,approval:f.approval},f.registry);
  await writeFile(path.join(f.a,'.codex/test.json'),'{"foreign":"preserve"}');
  let before=await workspaceHashes(f.a),preview=await prepareRepairPreview(f.a,f.registry);
  assert.deepEqual(JSON.parse(Buffer.from(preview.outputs[0].bytes,'base64').toString()),{foreign:'preserve',ours:null});
  assert.deepEqual(await workspaceHashes(f.a),before);
  await writeFile(path.join(f.a,'AGENTS.md'),'user');before=await workspaceHashes(f.a);
  preview=await prepareRepairPreview(f.a,f.registry);
  assert.equal(preview.blockers.length,1);assert.deepEqual(preview.outputs,[]);assert.deepEqual(preview.targets,[]);
  assert.deepEqual(await workspaceHashes(f.a),before);
});

test('reconciliation preview preserves pending uncertainty and exact evidence without writes',async()=>{
  const f=await approvedFixture(),lock=await acquireWorkspaceLock(f.a);
  await assert.rejects(()=>applyPrepared(lock,f.prepared,f.approval,f.registry,null,{boundary:async phase=>{if(phase==='write')throw Error('stop');}}));
  const before=await workspaceHashes(f.a),relative=await recoveryFile(f.a),preview=await previewReconciliation(f.a,relative);
  assert.equal(preview.requiresDecision,true);assert.equal(preview.applySupported,false);
  assert.equal(preview.statePhase,'pending');assert.equal(preview.targets[0].recorded,'uncertain');
  assert.equal(preview.targets[0].position,'desired');assert.deepEqual(await workspaceHashes(f.a),before);
  await lock.release();
});

test('repair inspection uses installed snapshot without original source or manifest and preserves user drift',async()=>{
  const f=await approvedFixture();
  const applied=await applyLifecycle({command:'setup',wrapper:f.a,prepared:f.prepared,approval:f.approval},f.registry);
  assert.equal(applied.status,'ready');
  const source=f.prepared.preview.plan.source.origin.resolvedSource;
  assert.ok(source.startsWith(f.root+path.sep));await rename(source,source+'-offline');
  await rename(f.manifestPath,f.manifestPath+'.offline');
  await rename(path.join(f.a,'AGENTS.md'),path.join(f.a,'AGENTS.user-copy'));
  let before=await workspaceHashes(f.a),result=await inspectRepair(f.a,f.registry);
  assert.equal(result.entries[0].disposition,'missing');assert.equal(result.applySupported,false);
  assert.deepEqual(await workspaceHashes(f.a),before);
  await writeFile(path.join(f.a,'AGENTS.md'),'user change');before=await workspaceHashes(f.a);
  result=await inspectRepair(f.a,f.registry);assert.equal(result.entries[0].disposition,'conflict');
  assert.equal(result.runtime,'not-run');assert.equal(result.requiresFreshApproval,true);
  assert.deepEqual(await workspaceHashes(f.a),before);
});

test('repair inspection rejects changed adapter output and corrupt installed snapshot',async()=>{
  const f=await approvedFixture();
  await applyLifecycle({command:'setup',wrapper:f.a,prepared:f.prepared,approval:f.approval},f.registry);
  const before=await workspaceHashes(f.a);
  await assert.rejects(()=>inspectRepair(f.a,{...f.registry,sharedAdapter:{plan:()=>[
    {path:'AGENTS.md',owner:'shared',kind:'file',bytes:Buffer.from('new semantics')}]
  }}),e=>e.code==='repair.replay-mismatch');
  assert.deepEqual(await workspaceHashes(f.a),before);
  await writeFile(path.join(f.a,f.prepared.preview.plan.desired.snapshot.path,'foreign.txt'),'foreign');
  await assert.rejects(()=>inspectRepair(f.a,f.registry));
});

test('repair inspection preserves foreign JSON fields and treats malformed ancestors as conflict',async()=>{
  const f=await approvedFixture({seed:{'.codex/test.json':Buffer.from('{"foreign":"private"}')},codex:{plan:()=>[
    {path:'.codex/test.json',owner:'codex',kind:'json-fields',fields:[{pointer:'/ours/enabled',present:true,value:true}]}]}});
  const applied=await applyLifecycle({command:'setup',wrapper:f.a,prepared:f.prepared,approval:f.approval},f.registry);
  assert.equal(applied.status,'ready');
  const filename=path.join(f.a,'.codex/test.json');
  await writeFile(filename,'{"foreign":"private","ours":{"enabled":false}}');
  let result=await inspectRepair(f.a,f.registry);
  assert.equal(result.entries.find(e=>e.pointer!==null).disposition,'conflict');
  assert.ok(!JSON.stringify(result).includes('private'));
  await writeFile(filename,'{"foreign":"private","ours":2}');
  result=await inspectRepair(f.a,f.registry);
  assert.equal(result.entries.find(e=>e.pointer!==null).disposition,'conflict');
  assert.equal(await readFile(filename,'utf8'),'{"foreign":"private","ours":2}');
});

test('repair inspection refuses pending operations without clearing state or lock',async()=>{
  const f=await approvedFixture(),lock=await acquireWorkspaceLock(f.a);
  await assert.rejects(()=>applyPrepared(lock,f.prepared,f.approval,f.registry,null,{boundary:async phase=>{if(phase==='write')throw Error('stop');}}));
  const before=await workspaceHashes(f.a);
  await assert.rejects(()=>inspectRepair(f.a,f.registry),e=>['repair.pending','repair.state'].includes(e.code));
  assert.deepEqual(await workspaceHashes(f.a),before);await lock.release();
});

test('lifecycle setup emits early journal and recovery locations then successful summary',async()=>{
  const f=await approvedFixture(),events=[];
  const result=await applyLifecycle({command:'setup',wrapper:f.a,prepared:f.prepared,approval:f.approval},f.registry,{report:async event=>{
    events.push(event);
    if(event.kind==='journal-location' && event.status==='planned')
      await assert.rejects(()=>readdir(event.path),e=>e.code==='ENOENT');
    if(event.kind==='journal-location' && event.status==='created') assert.deepEqual(await readdir(event.path),[]);
  }});
  assert.equal(result.status,'ready');assert.equal(result.error,null);assert.equal(result.lockRelease,'released');
  assert.deepEqual(events.filter(e=>e.kind==='journal-location').map(e=>e.status),['planned','created','initialized']);
  assert.deepEqual(events.filter(e=>e.kind==='recovery-location').map(e=>e.status),['created-unverified','verified']);
  assert.equal(events.at(-1).kind,'operation-result');assert.equal(result.recovery.status,'verified');
  assert.equal((await inspectInstallation(f.a)).ready,true);
});

test('lifecycle failure after journal directory creation reports orphan and preserves provider bytes',async()=>{
  const f=await approvedFixture();
  const before=await workspaceHashes(f.a);
  const result=await applyLifecycle({command:'setup',wrapper:f.a,prepared:f.prepared,approval:f.approval},f.registry,{report:async e=>{
    if(e.kind==='journal-location' && e.status==='created')throw Error('output failed secret');
  }});
  assert.equal(result.status,'failed');assert.equal(result.error,'lifecycle.report');
  assert.equal(result.journal.status,'created');assert.equal(result.recovery.status,'not-created');
  assert.deepEqual(await readdir(result.journal.path),[]);
  assert.equal(JSON.stringify(result).includes('secret'),false);
  const after=await workspaceHashes(f.a);
  for(const [name,hash] of Object.entries(before)) assert.equal(after[name],hash);
  assert.equal(result.lockRelease,'released');
});

test('lifecycle missing approval fails before journal and wrong command does not create metadata',async()=>{
  const f=await approvedFixture();
  const before=await workspaceHashes(f.a);
  const wrong=await applyLifecycle({command:'update',wrapper:f.a,prepared:f.prepared,approval:f.approval},f.registry);
  assert.equal(wrong.error,'lifecycle.prepared-binding');assert.deepEqual(await workspaceHashes(f.a),before);
  const bad=await applyLifecycle({command:'setup',wrapper:f.a,prepared:f.prepared,approval:null},f.registry);
  assert.equal(bad.status,'failed');assert.equal(bad.journal,null);assert.equal(bad.recovery,null);
});

test('lifecycle update preview remains nonmutating and requires its own approval',async()=>{
  const f=await approvedFixture();
  const initial=await applyLifecycle({command:'setup',wrapper:f.a,prepared:f.prepared,approval:f.approval},f.registry);
  assert.equal(initial.status,'ready');
  const before=await workspaceHashes(f.a);
  const prepared=await prepareLifecycle({command:'update',wrapper:f.a,manifestPath:f.manifestPath,tempRoot:f.root},f.registry);
  assert.equal(prepared.preview.plan.command,'update');assert.deepEqual(await workspaceHashes(f.a),before);
  const result=await applyLifecycle({command:'update',wrapper:f.a,prepared,approval:{decision:'approve',preparedDigest:prepared.digest}},f.registry);
  assert.equal(result.status,'ready');assert.equal(result.lockRelease,'released');
  const inspected=await inspectInstallation(f.a);
  assert.equal(inspected.ready,true,JSON.stringify(inspected.diagnostics));
});

test('lifecycle final output failure preserves actual successful apply result',async()=>{
  const f=await approvedFixture();
  const result=await applyLifecycle({command:'setup',wrapper:f.a,prepared:f.prepared,approval:f.approval},f.registry,{report:async e=>{
    if(e.kind==='operation-result')throw Error('output');
  }});
  assert.equal(result.status,'ready');assert.equal(result.outputError,'lifecycle.report');
  assert.equal((await inspectInstallation(f.a)).ready,true);
});

test('lifecycle planned-path output failure does not claim an existing journal',async()=>{
  const f=await approvedFixture();
  const result=await applyLifecycle({command:'setup',wrapper:f.a,prepared:f.prepared,approval:f.approval},f.registry,{report:async e=>{
    if(e.kind==='journal-location' && e.status==='planned')throw Error('output');
  }});
  assert.equal(result.status,'failed');assert.equal(result.journal.status,'planned');
  await assert.rejects(()=>readdir(result.journal.path),e=>e.code==='ENOENT');
  assert.equal(result.recovery.status,'not-created');assert.equal(result.lockRelease,'released');
});

test('lifecycle busy lock is preserved without inventing a journal',async()=>{
  const f=await approvedFixture(),lock=await acquireWorkspaceLock(f.a),before=await workspaceHashes(f.a);
  const result=await applyLifecycle({command:'setup',wrapper:f.a,prepared:f.prepared,approval:f.approval},f.registry);
  assert.equal(result.error,'lock.busy');assert.equal(result.journal,null);assert.equal(result.lockRelease,'not-acquired');
  assert.deepEqual(await workspaceHashes(f.a),before);await lock.release();
});

test('doctor selected recovery proves active transaction offline without mutating workspace',async()=>{
  const f=await approvedFixture(),lock=await acquireWorkspaceLock(f.a);
  const applied=await applyPrepared(lock,f.prepared,f.approval,f.registry);await lock.release();
  await rename(f.manifestPath,f.manifestPath+'.moved');
  await rename(f.prepared.preparation.snapshot,f.prepared.preparation.snapshot+'-moved');
  const before=await workspaceHashes(f.a);
  const without=await inspectInstallation(f.a);
  assert.equal(without.configuration,'pass');assert.equal(without.transactionEvidence,'pass');
  assert.equal(without.ready,true);
  const cli=spawnSync(process.execPath,[fileURLToPath(new URL('../src/cli.js',import.meta.url)),
    'doctor','--workspace',f.a,'--json'],{encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(cli.status,0,cli.stderr);assert.equal(JSON.parse(cli.stdout).ready,true);
  assert.equal(JSON.parse(cli.stdout).runtime,'not-run');
  const report=await inspectInstallation(f.a,{recoveryPath:applied.recoveryPath});
  assert.equal(report.configuration,'pass');assert.equal(report.transactionEvidence,'pass');
  assert.equal(report.history.complete,true);assert.equal(report.history.entries.length,1);
  assert.equal(report.history.entries[0].status,'journal-completed');
  assert.equal(report.history.entries[0].protected,true);
  assert.equal(report.recovery.statePhase,'active');assert.deepEqual(report.diagnostics,[]);
  assert.equal(report.ready,true);assert.equal(report.status,'ready');assert.equal(report.runtime,'not-run');
  assert.deepEqual(await workspaceHashes(f.a),before);
});

test('doctor orphan journal prevents readiness despite selected successful transaction',async()=>{
  const f=await approvedFixture(),lock=await acquireWorkspaceLock(f.a);
  const applied=await applyPrepared(lock,f.prepared,f.approval,f.registry);await lock.release();
  await mkdir(path.join(f.a,'.pipeline/journals/11111111-1111-1111-1111-111111111111'));
  const before=await workspaceHashes(f.a),report=await inspectInstallation(f.a,{recoveryPath:applied.recoveryPath});
  assert.equal(report.ready,false);assert.ok(report.diagnostics.some(d=>d.code==='history.orphan'));
  assert.deepEqual(await workspaceHashes(f.a),before);
});

test('doctor activation selects one current transaction while checking copied historical evidence',async()=>{
  const f=await approvedFixture(),lock=await acquireWorkspaceLock(f.a);
  const applied=await applyPrepared(lock,f.prepared,f.approval,f.registry);await lock.release();
  const id='22222222-2222-2222-2222-222222222222';
  await cp(path.join(f.a,applied.journal),path.join(f.a,'.pipeline/journals',id),{recursive:true});
  await mkdir(path.join(f.a,'.pipeline/transactions',id));
  await cp(path.join(f.a,applied.recoveryPath),path.join(f.a,'.pipeline/transactions',id,'recovery.json'));
  const before=await workspaceHashes(f.a),report=await inspectInstallation(f.a,{recoveryPath:applied.recoveryPath});
  assert.equal(report.ready,true);assert.deepEqual(report.matchingTransactions,[applied.recoveryPath]);
  assert.equal(report.history.entries.length,2);assert.deepEqual(report.history.diagnostics,[]);
  assert.deepEqual(await workspaceHashes(f.a),before);
  const copiedPath=path.join(f.a,'.pipeline/transactions',id,'recovery.json');
  const copied=JSON.parse(await readFile(copiedPath,'utf8'));copied.approval.preparedDigest='sha256:'+'f'.repeat(64);
  await writeFile(copiedPath,JSON.stringify(copied));
  const failed=await inspectInstallation(f.a,{recoveryPath:applied.recoveryPath});
  assert.equal(failed.ready,false);assert.equal(failed.transactionEvidence,'fail');
  assert.ok(failed.diagnostics.some(d=>d.code==='apply.approval'));
});

test('doctor corrupted snapshot prevents configuration readiness',async()=>{
  const f=await approvedFixture(),lock=await acquireWorkspaceLock(f.a);
  await applyPrepared(lock,f.prepared,f.approval,f.registry);await lock.release();
  const snapshot=f.prepared.preview.plan.desired.snapshot.path;
  await writeFile(path.join(f.a,snapshot,'unexpected.txt'),'foreign');
  const before=await workspaceHashes(f.a),report=await inspectInstallation(f.a);
  assert.equal(report.ready,false);assert.equal(report.configuration,'fail');
  assert.ok(report.diagnostics.some(d=>d.subject==='snapshot'));
  assert.deepEqual(await workspaceHashes(f.a),before);
});

test('doctor rejects corrupt selected journal and does not change history',async()=>{
  const f=await approvedFixture(),lock=await acquireWorkspaceLock(f.a);
  const applied=await applyPrepared(lock,f.prepared,f.approval,f.registry);await lock.release();
  await writeFile(path.join(f.a,applied.journal,'000002.json'),'{');
  const before=await workspaceHashes(f.a),report=await inspectInstallation(f.a,{recoveryPath:applied.recoveryPath});
  assert.equal(report.transactionEvidence,'fail');assert.equal(report.ready,false);
  assert.ok(report.diagnostics.some(d=>d.code==='parse.syntax'));
  assert.deepEqual(await workspaceHashes(f.a),before);
});

test('doctor selected interrupted transaction remains pending with desired bytes',async()=>{
  const f=await approvedFixture(),lock=await acquireWorkspaceLock(f.a);
  await assert.rejects(()=>applyPrepared(lock,f.prepared,f.approval,f.registry,null,{boundary:async phase=>{if(phase==='write')throw Error('stop');}}));
  const before=await workspaceHashes(f.a);
  const report=await inspectInstallation(f.a,{recoveryPath:await recoveryFile(f.a)});
  assert.equal(report.status,'needs-reconciliation');assert.equal(report.transactionEvidence,'fail');
  assert.equal(report.ready,false);assert.ok(report.diagnostics.some(d=>d.code==='doctor.lock-present'));
  assert.deepEqual(await workspaceHashes(f.a),before);await lock.release();
});

async function workspaceHashes(root) {
  const result={};
  async function walk(relative='') {
    for(const entry of await readdir(path.join(root,relative),{withFileTypes:true})) {
      const name=relative?relative+'/'+entry.name:entry.name;
      if(entry.isDirectory()){result[name]='directory';await walk(name);}
      else{assert.ok(entry.isFile());result[name]=sha256(await readFile(path.join(root,name)));}
    }
  }
  await walk();return result;
}
async function recoveryFile(workspace) {
  const names=await readdir(path.join(workspace,'.pipeline/transactions'));assert.equal(names.length,1);
  return '.pipeline/transactions/'+names[0]+'/recovery.json';
}

// Only the child created by this test is terminated, after it announces the
// exact trusted I/O seam. No process-name enumeration or external PID is used.
async function forceKillAtIo(f,point) {
  const input=path.join(f.root,'io-input.json');
  await writeFile(input,JSON.stringify({workspace:f.a,prepared:f.prepared,approval:f.approval,point}));
  const script=`import {readFile,writeFile} from 'node:fs/promises';import path from 'node:path';
    import {applyPrepared} from ${JSON.stringify(new URL('../src/operations/apply.js',import.meta.url).href)};
    import {acquireWorkspaceLock} from ${JSON.stringify(new URL('../src/operations/lock.js',import.meta.url).href)};
    import {providerDouble} from ${JSON.stringify(new URL('./fixtures/provider-double.js',import.meta.url).href)};
    const input=JSON.parse(await readFile(process.argv[1],'utf8')),target=input.prepared.preview.plan.targets[0];
    const request={path:'AGENTS.md',owner:'shared',kind:'file',bytes:Buffer.from('entry')};
    if(target.beforeHash!==null)request.takeover={beforeHash:target.beforeHash,desiredHash:target.desiredHash};
    const lock=await acquireWorkspaceLock(input.workspace);
    await applyPrepared(lock,input.prepared,input.approval,{adapters:{codex:providerDouble('codex')},sharedAdapter:{plan:()=>[request]}},null,
      {ioBoundary:async detail=>{
        const point=input.point;
        if(detail.purpose!==point.purpose || detail.phase!==point.phase || (point.suffix && !detail.path.endsWith(point.suffix)))return;
        if(point.partial)await writeFile(path.join(input.workspace,detail.stagedPath),point.partial);
        process.stdout.write('WPC-IO-READY\\n');
        await new Promise(()=>{setInterval(()=>{},1000);});
      }});process.exit(99);`;
  const child=spawn(process.execPath,['--input-type=module','-e',script,input],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  const result=await new Promise(resolve=>{
    let output='',error='',requested=false,timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},30000);
    child.stdout.on('data',chunk=>{
      output=(output+chunk.toString()).slice(-1024);
      if(!requested && output.includes('WPC-IO-READY'))requested=child.kill('SIGKILL');
    });
    child.stderr.on('data',chunk=>{error=(error+chunk.toString()).slice(-2048);});
    child.once('error',e=>{clearTimeout(timer);resolve({error:e.code,requested,timedOut});});
    child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,error,requested,timedOut});});
  });
  assert.equal(result.timedOut,false,'I/O fault child timed out');
  assert.equal(result.requested,true,'I/O seam was not reached: '+result.error);
  assert.equal(result.signal,'SIGKILL','test child was not forcibly terminated');
}

const ioCases=[
  {purpose:'recovery',phase:'opened',corrupt:true},{purpose:'recovery',phase:'written',status:'before-state'},
  {purpose:'pending',phase:'opened',corrupt:true},{purpose:'pending',phase:'written'},
  ...['opened','written','synced','readback'].map(phase=>({purpose:'target',phase})),
  {purpose:'journal',phase:'opened',suffix:'000001.json',corrupt:true},
  {purpose:'journal',phase:'written',suffix:'000001.json'},
  {purpose:'journal',phase:'opened',suffix:'000002.json',corrupt:true},
  {purpose:'journal',phase:'synced',suffix:'000002.json'},
  ...['opened','written','synced','before-rename','renamed','readback'].map(phase=>({purpose:'active',phase,status:['renamed','readback'].includes(phase)?'applied':undefined})),
  ...['opened','written','synced','before-rename','renamed','readback'].map(phase=>({purpose:'target',phase,replace:true})),
  {purpose:'target',phase:'opened',partial:'e'},
  {purpose:'journal',phase:'opened',suffix:'000001.json',partial:'{',corrupt:true},
  {purpose:'pending',phase:'opened',partial:'{',corrupt:true},
  {purpose:'recovery',phase:'opened',partial:'{',corrupt:true}
];
for(const point of ioCases)test('I/O forced termination '+[point.purpose,point.phase,point.suffix,point.replace?'replace':'create',point.partial?'partial':''].filter(Boolean).join(' '),async()=>{
  const old=Buffer.from('old'),desired=Buffer.from('entry');
  const options=point.replace?{seed:{'AGENTS.md':old},sharedPlan:()=>[{path:'AGENTS.md',owner:'shared',kind:'file',bytes:desired,
    takeover:{beforeHash:sha256(old),desiredHash:sha256(desired)}}]}:{};
  const f=await approvedFixture(options);await forceKillAtIo(f,point);
  const before=await workspaceHashes(f.a),relative=await recoveryFile(f.a);
  if(point.corrupt)await assert.rejects(()=>inspectRecovery(f.a,relative),e=>e.code==='parse.syntax');
  else {
    const report=await inspectRecovery(f.a,relative);assert.equal(report.status,point.status??'needs-reconciliation');
    if(point.purpose==='target') {
      assert.equal(report.targets[0].recorded,'uncertain');
      const position=point.replace && !['renamed','readback'].includes(point.phase)?'before':point.phase==='opened'?'other':'desired';
      assert.equal(report.targets[0].position,position);
    }
  }
  assert.deepEqual(await workspaceHashes(f.a),before);await assert.rejects(()=>acquireWorkspaceLock(f.a),e=>e.code==='lock.busy');
});
for(const point of [{phase:'opened'},{phase:'opened',partial:'{'},{phase:'synced'}])
test('orphan journal start termination '+point.phase+(point.partial?' partial':''),async()=>{
  const f=await approvedFixture();
  const original=await workspaceHashes(f.a);
  await forceKillAtIo(f,{purpose:'journal',suffix:'000000.json',...point});
  const stopped=await workspaceHashes(f.a);
  const nonMetadata=entries=>Object.fromEntries(Object.entries(entries).filter(([name])=>name!=='.pipeline' && !name.startsWith('.pipeline/')));
  assert.deepEqual(nonMetadata(stopped),nonMetadata(original),'provider files and original workspace bytes unchanged');
  await assert.rejects(()=>readState(path.join(f.a,'.pipeline/state.json')),e=>e.code==='record.missing');
  await assert.rejects(()=>readdir(path.join(f.a,'.pipeline/transactions')),e=>e.code==='ENOENT');
  const journals=await readdir(path.join(f.a,'.pipeline/journals'));assert.equal(journals.length,1);
  const relative='.pipeline/journals/'+journals[0];
  assert.deepEqual(await readdir(path.join(f.a,relative)),['000000.json']);
  const bytes=await readFile(path.join(f.a,relative,'000000.json'));
  if(point.phase==='synced') {
    const record=JSON.parse(bytes.toString('utf8'));assert.equal(record.kind,'start');assert.equal(record.seq,0);
    const report=await readJournal(f.a,relative,f.prepared.preview.plan);
    assert.equal(report.receipt,null);assert.equal(report.nextIndex,0);
  } else assert.equal(bytes.toString('utf8'),point.partial??'');
  await assert.rejects(()=>inspectRecovery(f.a,'.pipeline/transactions/'+journals[0]+'/recovery.json'),e=>e.code==='record.missing');
  await assert.rejects(()=>acquireWorkspaceLock(f.a),e=>e.code==='lock.busy');
  assert.deepEqual(await workspaceHashes(f.a),stopped,'inspection must preserve orphan evidence and lock');
});

test('recovery inspects applied transaction without source, preparation or manifest and never changes files',async()=>{
  const f=await approvedFixture(),lock=await acquireWorkspaceLock(f.a),result=await applyPrepared(lock,f.prepared,f.approval,f.registry);
  await lock.release();
  await rename(f.manifestPath,f.manifestPath+'.moved');
  await rename(f.prepared.preparation.snapshot,f.prepared.preparation.snapshot+'-moved');
  await rename(f.prepared.preparation.objects,f.prepared.preparation.objects+'-moved');
  const before=await workspaceHashes(f.a),report=await inspectRecovery(f.a,result.recoveryPath);
  assert.equal(report.status,'applied');assert.equal(report.statePhase,'active');assert.deepEqual(report.diagnostics,[]);
  assert.equal(report.automaticActions,false);assert.equal(report.runtime,'not-run');assert.equal(report.requiresFreshPreview,true);
  assert.deepEqual(await workspaceHashes(f.a),before);
});
test('recovery does not promote interrupted journal even when bytes match desired result',async()=>{
  const f=await approvedFixture(),lock=await acquireWorkspaceLock(f.a);
  await assert.rejects(()=>applyPrepared(lock,f.prepared,f.approval,f.registry,null,{boundary:async phase=>{if(phase==='write')throw Error('interruption');}}));
  const relative=await recoveryFile(f.a),before=await workspaceHashes(f.a),report=await inspectRecovery(f.a,relative);
  assert.equal(report.status,'needs-reconciliation');assert.equal(report.statePhase,'pending');
  assert.equal(report.targets[0].recorded,'uncertain');assert.equal(report.targets[0].position,'desired');assert.equal(report.receipt.status,'uncertain');
  assert.deepEqual(await workspaceHashes(f.a),before);await lock.release();
});
test('recovery detects drift after completed apply without rewriting historical receipt or ready state',async()=>{
  const f=await approvedFixture(),lock=await acquireWorkspaceLock(f.a),result=await applyPrepared(lock,f.prepared,f.approval,f.registry);
  await writeFile(path.join(f.a,'AGENTS.md'),'foreign change');const before=await workspaceHashes(f.a);
  const report=await inspectRecovery(f.a,result.recoveryPath);
  assert.equal(report.status,'needs-reconciliation');assert.ok(report.diagnostics.includes('recovery.target-drift'));
  assert.equal(report.targets[0].recorded,'completed');assert.equal(report.targets[0].position,'other');
  assert.deepEqual(await workspaceHashes(f.a),before);await lock.release();
});
test('recovery refuses corrupted journal or mismatching approval rather than guessing outcomes',async()=>{
  const f=await approvedFixture(),lock=await acquireWorkspaceLock(f.a),result=await applyPrepared(lock,f.prepared,f.approval,f.registry);
  const journalFile=path.join(f.a,result.journal,'000002.json'),original=await readFile(journalFile);
  await writeFile(journalFile,'{"torn":');await assert.rejects(()=>inspectRecovery(f.a,result.recoveryPath),e=>e.code==='parse.syntax');
  await writeFile(journalFile,original);
  const filename=path.join(f.a,result.recoveryPath),recovery=JSON.parse(await readFile(filename,'utf8'));
  recovery.approval.preparedDigest=contentHash;await writeFile(filename,JSON.stringify(recovery));
  await assert.rejects(()=>inspectRecovery(f.a,result.recoveryPath),e=>e.code==='apply.approval');
  await lock.release();
});
test('recovery requires complete backup inventory and reports corrupted backup bytes',async()=>{
  const original=Buffer.from('foreign entry'),f=await approvedFixture({seed:{'AGENTS.md':original},sharedPlan:()=>[
    {path:'AGENTS.md',owner:'shared',kind:'file',bytes:Buffer.from('entry'),takeover:{beforeHash:sha256(original),desiredHash:sha256(Buffer.from('entry'))}}
  ]}),lock=await acquireWorkspaceLock(f.a),result=await applyPrepared(lock,f.prepared,f.approval,f.registry);
  const filename=path.join(f.a,result.recoveryPath),recovery=JSON.parse(await readFile(filename,'utf8'));
  await writeFile(filename,JSON.stringify({...recovery,backups:[]}));await assert.rejects(()=>inspectRecovery(f.a,result.recoveryPath),e=>e.code==='recovery.backup');
  await writeFile(filename,JSON.stringify(recovery));await writeFile(path.join(f.a,recovery.backups[0].path),'bad backup');
  const report=await inspectRecovery(f.a,result.recoveryPath);assert.equal(report.status,'needs-reconciliation');assert.ok(report.diagnostics.includes('backup.mismatch'));
  await lock.release();
});
test('oversized recovery envelope is rejected at preview before staging or target writes',async()=>{
  const f=await approvedFixture(),before=await workspaceHashes(f.a);
  await assert.rejects(()=>preparePlan({wrapper:f.a,manifestPath:f.manifestPath,...f.registry,
    sharedAdapter:{plan:()=>[{path:'AGENTS.md',owner:'shared',kind:'file',bytes:Buffer.alloc(2*1024*1024,65)}]}}),
    e=>e.code==='plan.recovery-budget');
  assert.deepEqual(await workspaceHashes(f.a),before);
});

test('missing provider registry produces stable contract error in planner and apply',async()=>{
  const f=await approvedFixture(),lock=await acquireWorkspaceLock(f.a),before=await workspaceHashes(f.a);
  for(const adapters of [undefined,null,[],{}, {codex:{}}]) {
    await assert.rejects(()=>preparePlan({wrapper:f.a,manifestPath:f.manifestPath,...f.registry,adapters}),e=>e.code==='provider.interface');
    await assert.rejects(()=>applyPrepared(lock,f.prepared,f.approval,{...f.registry,adapters}),e=>e.code==='provider.interface');
  }
  assert.deepEqual(await workspaceHashes(f.a),before);await lock.release();
});

test('whole apply registry null or omitted fails with ContractError without writes',async()=>{
  const f=await approvedFixture(),lock=await acquireWorkspaceLock(f.a),before=await workspaceHashes(f.a);
  for(const registry of [null,undefined,[],42,'bad']) {
    await assert.rejects(()=>applyPrepared(lock,f.prepared,f.approval,registry),e=>e.name==='ContractError' && e.code==='provider.interface');
    await assert.rejects(()=>preflightApply(lock,f.prepared,f.approval,registry),e=>e.name==='ContractError' && e.code==='provider.interface');
  }
  await assert.rejects(()=>applyPrepared(lock,f.prepared,f.approval),e=>e.code==='provider.interface');
  assert.deepEqual(await workspaceHashes(f.a),before);await lock.release();
});

test('recovery budget helper rejects malformed direct input without invoking getters',()=>{
  let invoked=false;
  for(const value of [null,undefined,{},[],1,{get preview(){invoked=true;return {};}}])
    assert.throws(()=>assertRecoveryBudget(value),e=>e.name==='ContractError' && e.code==='plan.recovery-input');
  assert.equal(invoked,false);
});

test('recovery budget remaps node complexity below the byte limit on a composed plan',async()=>{
  const f=await approvedFixture(),verified=await verifyPreparedSnapshot({snapshotPath:f.prepared.preparation.snapshot,
    manifest:{id:f.prepared.preview.plan.desired.pipelineId,version:f.prepared.preview.plan.desired.version},
    digest:f.prepared.preview.plan.source.digest,inventoryDigest:f.prepared.preview.plan.source.inventoryDigest});
  const workspace=JSON.parse(await readFile(f.manifestPath,'utf8'));
  const requests=Array.from({length:1200},(_,i)=>({path:'.codex/f'+i,owner:'codex',kind:'file',bytes:Buffer.from('x')}));
  const preview=composePlan({pipeline:verified.manifest,workspace,wrapper:f.a,snapshot:f.prepared.preview.plan.source,
    adapters:f.registry.adapters,requests,observations:requests.map(r=>({path:r.path,bytes:null}))});
  const body={...f.prepared,preview};delete body.digest;
  const prepared={...body,digest:contractDigest(body)};
  const record=JSON.stringify({schemaVersion:1,prepared,approval:{decision:'approve',preparedDigest:prepared.digest},previous:null,backups:[]})+'\n';
  assert.ok(Buffer.byteLength(record)<MAX_INPUT_BYTES,'must exercise complexity, not byte size');
  assert.throws(()=>parse(record,'json'),e=>e.code==='parse.complexity');
  assert.throws(()=>assertRecoveryBudget(prepared),e=>e.code==='plan.recovery-budget');
});

test('oversized update preview preserves active state, backups and provider files',async()=>{
  const original=Buffer.from('original');
  const f=await approvedFixture({seed:{'AGENTS.md':original},sharedPlan:()=>[{path:'AGENTS.md',owner:'shared',kind:'file',bytes:Buffer.from('entry'),
    takeover:{beforeHash:sha256(original),desiredHash:sha256(Buffer.from('entry'))}}]});
  const lock=await acquireWorkspaceLock(f.a);
  await applyPrepared(lock,f.prepared,f.approval,f.registry);await lock.release();
  const before=await workspaceHashes(f.a),state=(await readState(path.join(f.a,'.pipeline/state.json'))).value;
  assert.equal(state.status,'ready');assert.ok(state.active.owned.some(o=>o.backup!==null));
  f.registry.sharedAdapter.plan=()=>[{path:'AGENTS.md',owner:'shared',kind:'file',bytes:Buffer.alloc(2*1024*1024,65)}];
  await assert.rejects(()=>preparePlan({wrapper:f.a,tempRoot:f.root,...f.registry}),e=>e.code==='plan.recovery-budget');
  assert.deepEqual(await workspaceHashes(f.a),before);
});
test('real child process exit leaves lock and recovery evidence at transaction boundaries',async()=>{
  const phases=['recovery','pending','intent','write','outcome','before-active','active'];
  for(const phase of phases) {
    const f=await approvedFixture(),input=path.join(f.root,'child-input.json');
    await writeFile(input,JSON.stringify({workspace:f.a,prepared:f.prepared,approval:f.approval,phase}));
    const script=`import {readFile} from 'node:fs/promises';
      import {applyPrepared} from ${JSON.stringify(new URL('../src/operations/apply.js',import.meta.url).href)};
      import {acquireWorkspaceLock} from ${JSON.stringify(new URL('../src/operations/lock.js',import.meta.url).href)};
      import {providerDouble} from ${JSON.stringify(new URL('./fixtures/provider-double.js',import.meta.url).href)};
      const input=JSON.parse(await readFile(process.argv[1],'utf8'));
      const lock=await acquireWorkspaceLock(input.workspace);
      await applyPrepared(lock,input.prepared,input.approval,{adapters:{codex:providerDouble('codex')},
        sharedAdapter:{plan:()=>[{path:'AGENTS.md',owner:'shared',kind:'file',bytes:Buffer.from('entry')}]}},null,
        {boundary:async phase=>{if(phase===input.phase)process.exit(73);}});process.exit(99);`;
    const child=spawnSync(process.execPath,['--input-type=module','-e',script,input],{windowsHide:true,encoding:'utf8',timeout:30000});
    assert.equal(child.status,73,'expected child exit at '+phase);
    const before=await workspaceHashes(f.a),report=await inspectRecovery(f.a,await recoveryFile(f.a));
    assert.equal(report.status,phase==='active'?'applied':phase==='recovery'?'before-state':'needs-reconciliation',phase);
    if(phase==='intent'||phase==='write')assert.equal(report.receipt.status,'uncertain');
    assert.deepEqual(await workspaceHashes(f.a),before);await assert.rejects(()=>acquireWorkspaceLock(f.a),e=>e.code==='lock.busy');
  }
});

test('TX-02 separate Node process cannot acquire held workspace but can acquire another',async()=>{
  const {a,b}=await fixture(),lock=await acquireWorkspaceLock(a);
  const script=`import {acquireWorkspaceLock} from ${JSON.stringify(new URL('../src/operations/lock.js',import.meta.url).href)};
    try {const lock=await acquireWorkspaceLock(process.argv[1]);await lock.release();process.stdout.write('acquired');}
    catch(error){process.stdout.write(error.code??'unknown');process.exitCode=2;}`;
  const child=workspace=>spawnSync(process.execPath,['--input-type=module','-e',script,workspace],{windowsHide:true,encoding:'utf8',timeout:15000});
  const blocked=child(a);assert.equal(blocked.status,2);assert.equal(blocked.stdout,'lock.busy');
  const independent=child(b);assert.equal(independent.status,0);assert.equal(independent.stdout,'acquired');
  await lock.release();const released=child(a);assert.equal(released.status,0);assert.equal(released.stdout,'acquired');
});

async function approvedFixture(options={}) {
  const providers=options.providers??['codex'];
  const f=await fixture(),source=await preparedFixture(f.root,providers,options.pipelineId),repo=source.snapshotPath;
  const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>!/^GIT_/i.test(name)));
  Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'});
  for(const args of [['init','--initial-branch=main','--template='],['add','--all'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture']]) {
    const result=spawnSync('git',['-C',repo,'-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],{env,windowsHide:true,encoding:'utf8'});
    assert.equal(result.status,0,'synthetic Git initialization');
  }
  const manifest={schemaVersion:1,pipeline:{type:'git',transport:'local',path:path.relative(f.a,repo).split(path.sep).join('/'),ref:'main',subdirectory:'.'},providers,
    layout:{kind:'single-repo',repositories:{game:{path:'project',role:'code'}},documentation:{repository:'game',path:'docs'}}};
  const manifestPath=path.join(f.a,'workspace.json');await writeFile(manifestPath,JSON.stringify(manifest));
  for(const [name,bytes] of Object.entries(options.seed??{})) {
    await mkdir(path.dirname(path.join(f.a,name)),{recursive:true});await writeFile(path.join(f.a,name),bytes);
  }
  const registry={adapters:Object.fromEntries(providers.map(id=>[id,{...providerDouble(id),...(options[id]??{})}])),
    sharedAdapter:{plan:options.sharedPlan??(()=>[{path:'AGENTS.md',owner:'shared',kind:'file',bytes:Buffer.from('entry')}])}};
  const prepared=await preparePlan({wrapper:f.a,manifestPath,tempRoot:f.root,...registry});
  return {...f,manifestPath,prepared,registry,approval:{decision:'approve',preparedDigest:prepared.digest}};
}
test('integrated A update and snapshot drift leave B, original Git source and other preparations unchanged',async()=>{
  const f=await approvedFixture(),sourceRoot=path.resolve(f.a,JSON.parse(await readFile(f.manifestPath,'utf8')).pipeline.path);
  await writeFile(path.join(f.b,'workspace.json'),await readFile(f.manifestPath));
  const preparedB=await preparePlan({wrapper:f.b,manifestPath:path.join(f.b,'workspace.json'),tempRoot:f.root,...f.registry});
  const lockA=await acquireWorkspaceLock(f.a),lockB=await acquireWorkspaceLock(f.b);
  const sourceBefore=await workspaceHashes(sourceRoot),preparationBefore=await workspaceHashes(preparedB.preparation.snapshot);
  const [,installedB]=await Promise.all([applyPrepared(lockA,f.prepared,f.approval,f.registry),
    applyPrepared(lockB,preparedB,{decision:'approve',preparedDigest:preparedB.digest},f.registry)]);
  const beforeB=await workspaceHashes(f.b);
  const previous=(await readState(path.join(f.a,'.pipeline/state.json'))).value;
  f.registry.sharedAdapter.plan=()=>[{path:'AGENTS.md',owner:'shared',kind:'file',bytes:Buffer.from('A updated')}];
  const update=await preparePlan({wrapper:f.a,tempRoot:f.root,...f.registry});
  const installedA=await applyPrepared(lockA,update,{decision:'approve',preparedDigest:update.digest},f.registry,previous);
  await writeFile(path.join(f.a,installedA.state.active.snapshot.path,'resources/process.md'),'A damaged snapshot');
  assert.equal((await inspectRecovery(f.b,installedB.recoveryPath)).status,'applied');
  assert.deepEqual(await workspaceHashes(f.b),beforeB);assert.deepEqual(await workspaceHashes(sourceRoot),sourceBefore);
  assert.deepEqual(await workspaceHashes(preparedB.preparation.snapshot),preparationBefore);
  await lockA.release();await lockB.release();
});
test('explicit source rebind survives complete update and recovery without silent origin replacement',async()=>{
  const f=await approvedFixture(),lock=await acquireWorkspaceLock(f.a);
  await applyPrepared(lock,f.prepared,f.approval,f.registry);
  const previous=(await readState(path.join(f.a,'.pipeline/state.json'))).value,manifestPath=path.join(f.a,'new-origin.json');
  await writeFile(manifestPath,await readFile(f.manifestPath));
  await assert.rejects(()=>preparePlan({wrapper:f.a,manifestPath,tempRoot:f.root,...f.registry}),e=>e.code==='source-rebind-required');
  const proposal=await previewRebind({wrapper:f.a,previous,manifestPath});
  const rebind={proposal,approval:{decision:'approve',proposalDigest:contractDigest(proposal)}};
  const update=await preparePlan({wrapper:f.a,manifestPath,tempRoot:f.root,...f.registry,rebind});
  const result=await applyPrepared(lock,update,{decision:'approve',preparedDigest:update.digest},f.registry,previous);
  assert.equal(result.state.active.snapshot.origin.path,manifestPath);
  assert.equal(previous.active.snapshot.origin.path,f.manifestPath);assert.equal((await inspectRecovery(f.a,result.recoveryPath)).status,'applied');
  await lock.release();
});
test('installed snapshot or recovery record drift before pending refuses all provider writes',async()=>{
  for(const subject of ['snapshot','recovery']) {
    const f=await approvedFixture(),lock=await acquireWorkspaceLock(f.a);
    await assert.rejects(()=>applyPrepared(lock,f.prepared,f.approval,f.registry,null,{boundary:async phase=>{
      if(phase==='recovery') {
        const target=subject==='snapshot'?path.join(f.prepared.preview.plan.source.path,'resources/process.md'):await recoveryFile(f.a);
        await writeFile(path.join(f.a,target),'drift');
      }
    }}),e=>e.code===(subject==='snapshot'?'inventory.hash':'apply.recovery-drift'));
    assert.equal((await readdir(f.a)).includes('AGENTS.md'),false);
    await assert.rejects(()=>readState(path.join(f.a,'.pipeline/state.json')),e=>e.code==='record.missing');await lock.release();
  }
});
test('final recovery record drift blocks activation after otherwise completed target writes',async()=>{
  const f=await approvedFixture(),lock=await acquireWorkspaceLock(f.a);
  await assert.rejects(()=>applyPrepared(lock,f.prepared,f.approval,f.registry,null,{boundary:async phase=>{
    if(phase==='before-active')await writeFile(path.join(f.a,await recoveryFile(f.a)),'drift');
  }}),e=>e.code==='apply.recovery-drift');
  assert.equal((await readState(path.join(f.a,'.pipeline/state.json'))).value.status,'needs-reconciliation');await lock.release();
});
test('replacement rechecks target and staging bytes before rename; no rollback or overwrite of concurrent edits',async()=>{
  for(const subject of ['target','staging']) {
    const old=Buffer.from('old'),desired=Buffer.from('entry'),f=await approvedFixture({seed:{'AGENTS.md':old},sharedPlan:()=>[
      {path:'AGENTS.md',owner:'shared',kind:'file',bytes:desired,takeover:{beforeHash:sha256(old),desiredHash:sha256(desired)}}
    ]}),lock=await acquireWorkspaceLock(f.a);
    const result=await applyPrepared(lock,f.prepared,f.approval,f.registry,null,{ioBoundary:async detail=>{
      if(detail.purpose==='target' && detail.phase==='before-rename')await writeFile(path.join(f.a,subject==='target'?detail.path:detail.stagedPath),'concurrent edit');
    }});
    assert.equal(result.status,'needs-reconciliation');assert.equal(result.receipt.status,subject==='target'?'uncertain':'failed');
    assert.equal(await readFile(path.join(f.a,'AGENTS.md'),'utf8'),subject==='target'?'concurrent edit':'old');await lock.release();
  }
});
test('write/sync exception after bytes land is uncertain even when readback matches desired',async()=>{
  const f=await approvedFixture(),lock=await acquireWorkspaceLock(f.a);
  const result=await applyPrepared(lock,f.prepared,f.approval,f.registry,null,{ioBoundary:async detail=>{
    if(detail.purpose==='target' && detail.phase==='written')throw Object.assign(Error('synthetic sync failure'),{code:'EIO'});
  }});
  assert.equal(result.status,'needs-reconciliation');assert.equal(result.receipt.status,'uncertain');
  assert.equal(result.receipt.operations[0].observedHash,result.receipt.operations[0].desiredHash);
  assert.equal((await readState(path.join(f.a,'.pipeline/state.json'))).value.active,null);await lock.release();
});
test('redirected provider parent after preflight does not write outside workspace',async()=>{
  const f=await approvedFixture({codex:{plan:()=>[{path:'.codex/test.json',owner:'codex',kind:'file',bytes:Buffer.from('{}')}]}}),outside=path.join(f.root,'outside');
  await mkdir(outside);const lock=await acquireWorkspaceLock(f.a);
  const result=await applyPrepared(lock,f.prepared,f.approval,f.registry,null,{boundary:async phase=>{
    if(phase==='pending')await symlink(outside,path.join(f.a,'.codex'),process.platform==='win32'?'junction':'dir');
  }});
  assert.equal(result.status,'needs-reconciliation');assert.deepEqual(await readdir(outside),[]);
  assert.equal((await readdir(f.a)).includes('AGENTS.md'),false);await lock.release();
});
test('setup coordinator writes verified targets, recovery and independent snapshot before ready activation',async()=>{
  const f=await approvedFixture(),lock=await acquireWorkspaceLock(f.a);
  const result=await applyPrepared(lock,f.prepared,f.approval,f.registry);
  assert.equal(result.status,'ready');assert.equal(result.receipt.status,'completed');
  assert.equal(await readFile(path.join(f.a,'AGENTS.md'),'utf8'),'entry');
  assert.deepEqual(structuredClone((await readState(path.join(f.a,'.pipeline/state.json'))).value),result.state);
  const recovery=(await readRecord(path.join(f.a,result.recoveryPath))).value;
  assert.deepEqual(structuredClone(recovery.prepared),f.prepared);assert.deepEqual(structuredClone(recovery.approval),f.approval);
  assert.equal((await readJournal(f.a,result.journal,f.prepared.preview.plan,null)).receipt.status,'completed');
  await verifyPreparedSnapshot({snapshotPath:path.join(f.a,result.state.active.snapshot.path),manifest:{id:'fixture',version:'1.0.0'},
    digest:result.state.active.snapshot.digest,inventoryDigest:result.state.active.snapshot.inventoryDigest});
  await lock.release();
});
test('TX-01 setup with third target conflict aborts before target writes or pending state',async()=>{
  const f=await approvedFixture({codex:{plan:()=>Array.from({length:9},(_,i)=>({path:'.codex/file-'+i,owner:'codex',kind:'file',bytes:Buffer.from('new')}))}});
  const lock=await acquireWorkspaceLock(f.a),target=f.prepared.preview.plan.targets[2];
  assert.equal(f.prepared.preview.plan.targets.length,10);
  await mkdir(path.dirname(path.join(f.a,target.path)),{recursive:true});await writeFile(path.join(f.a,target.path),'foreign');
  await assert.rejects(()=>applyPrepared(lock,f.prepared,f.approval,f.registry),e=>e.code==='preview.before');
  assert.deepEqual(await readdir(path.join(f.a,'.pipeline')),['lock']);
  assert.deepEqual(await readdir(path.join(f.a,'.codex')),[path.basename(target.path)]);await lock.release();
});
test('TX-01 mid-apply drift stops remainder, keeps earlier writes and pending state without rollback',async()=>{
  const f=await approvedFixture({codex:{plan:()=>Array.from({length:9},(_,i)=>({path:'.codex/file-'+i,owner:'codex',kind:'file',bytes:Buffer.from('new')}))}});
  const lock=await acquireWorkspaceLock(f.a),plan=f.prepared.preview.plan;
  assert.equal(plan.targets.length,10);
  const result=await applyPrepared(lock,f.prepared,f.approval,f.registry,null,{boundary:async(phase,index)=>{
    if(phase==='intent' && index===2)await writeFile(path.join(f.a,plan.targets[index].path),'editor change');
  }});
  assert.equal(result.status,'needs-reconciliation');assert.deepEqual(result.receipt.operations.map(o=>o.status),['completed','completed','uncertain',...Array(7).fill('skipped')]);
  assert.equal(await readFile(path.join(f.a,plan.targets[0].path),'utf8'),'new');
  assert.equal(await readFile(path.join(f.a,plan.targets[2].path),'utf8'),'editor change');
  assert.deepEqual((await readdir(path.join(f.a,'.codex'))).sort(),['file-0','file-1','file-2']);
  const state=(await readState(path.join(f.a,'.pipeline/state.json'))).value;
  assert.equal(state.active,null);assert.equal(state.pending,contractDigest(plan));assert.equal(state.status,'needs-reconciliation');
  await lock.release();
});
test('interruption after target write retains journal uncertainty and does not activate ready state',async()=>{
  const f=await approvedFixture(),lock=await acquireWorkspaceLock(f.a);
  await assert.rejects(()=>applyPrepared(lock,f.prepared,f.approval,f.registry,null,{boundary:async phase=>{if(phase==='write')throw Error('synthetic interruption');}}),/synthetic interruption/);
  assert.equal(await readFile(path.join(f.a,'AGENTS.md'),'utf8'),'entry');
  const state=(await readState(path.join(f.a,'.pipeline/state.json'))).value;assert.equal(state.status,'needs-reconciliation');assert.equal(state.active,null);
  const [id]=await readdir(path.join(f.a,'.pipeline/journals'));
  const journal=await readJournal(f.a,'.pipeline/journals/'+id,f.prepared.preview.plan,null);
  assert.equal(journal.phase,'interrupted');assert.equal(journal.receipt.status,'uncertain');
  await lock.release();
});
test('field update setup saves exact original backup and preserves unrelated config values',async()=>{
  const original=Buffer.from('{"managed":false,"foreign":"keep"}');
  const f=await approvedFixture({seed:{'.codex/test.json':original},codex:{plan:()=>[{path:'.codex/test.json',owner:'codex',kind:'json-fields',
    fields:[{pointer:'/managed',present:true,value:true,takeover:{beforeHash:contractDigest(false),desiredHash:contractDigest(true)}}]}]}});
  const lock=await acquireWorkspaceLock(f.a),result=await applyPrepared(lock,f.prepared,f.approval,f.registry);
  assert.equal(result.status,'ready');assert.deepEqual(JSON.parse(await readFile(path.join(f.a,'.codex/test.json'),'utf8')),{managed:true,foreign:'keep'});
  const owned=result.state.active.owned.find(o=>o.kind==='field');assert.deepEqual(await readFile(path.join(f.a,owned.backup)),original);
  await lock.release();
});
test('update uses existing state, preserves original field backup and commits new identity only after readback',async()=>{
  const original=Buffer.from('{"managed":false,"foreign":"keep"}');
  const f=await approvedFixture({seed:{'.codex/test.json':original},codex:{plan:()=>[{path:'.codex/test.json',owner:'codex',kind:'json-fields',
    fields:[{pointer:'/managed',present:true,value:true,takeover:{beforeHash:contractDigest(false),desiredHash:contractDigest(true)}}]}]}});
  const lock=await acquireWorkspaceLock(f.a),first=await applyPrepared(lock,f.prepared,f.approval,f.registry);
  const previous=(await readState(path.join(f.a,'.pipeline/state.json'))).value;
  f.registry.adapters.codex.plan=()=>[{path:'.codex/test.json',owner:'codex',kind:'json-fields',fields:[{pointer:'/managed',present:true,value:'updated'}]}];
  const update=await preparePlan({wrapper:f.a,tempRoot:f.root,...f.registry});
  const result=await applyPrepared(lock,update,{decision:'approve',preparedDigest:update.digest},f.registry,previous);
  assert.equal(result.status,'ready');assert.notEqual(result.state.active.id,first.state.active.id);
  const owned=result.state.active.owned.find(o=>o.kind==='field');assert.equal(owned.backup,first.state.active.owned.find(o=>o.kind==='field').backup);
  assert.deepEqual(await readFile(path.join(f.a,owned.backup)),original);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.a,'.codex/test.json'),'utf8')),{managed:'updated',foreign:'keep'});
  await lock.release();
});
test('final recheck rejects changed completed output and retains old active installation during update',async()=>{
  const f=await approvedFixture(),lock=await acquireWorkspaceLock(f.a),first=await applyPrepared(lock,f.prepared,f.approval,f.registry);
  const previous=(await readState(path.join(f.a,'.pipeline/state.json'))).value;
  f.registry.sharedAdapter.plan=()=>[{path:'AGENTS.md',owner:'shared',kind:'file',bytes:Buffer.from('new entry')}];
  const update=await preparePlan({wrapper:f.a,tempRoot:f.root,...f.registry});
  await assert.rejects(()=>applyPrepared(lock,update,{decision:'approve',preparedDigest:update.digest},f.registry,previous,{boundary:async phase=>{
    if(phase==='before-active')await writeFile(path.join(f.a,'AGENTS.md'),'concurrent edit');
  }}),e=>e.code==='apply.final-drift');
  const state=(await readState(path.join(f.a,'.pipeline/state.json'))).value;
  assert.equal(state.status,'needs-reconciliation');assert.equal(state.active.id,first.state.active.id);assert.equal(state.pending,contractDigest(update.preview.plan));
  assert.equal(await readFile(path.join(f.a,'AGENTS.md'),'utf8'),'concurrent edit');await lock.release();
});
test('apply preflight reproduces trusted adapters and rejects changed output before any target writes',async()=>{
  const f=await approvedFixture(),lock=await acquireWorkspaceLock(f.a);
  const checked=await preflightApply(lock,f.prepared,f.approval,f.registry);
  assert.deepEqual(checked.backups,[]);assert.deepEqual(checked.prepared,f.prepared);
  f.registry.sharedAdapter.plan=()=>[{path:'AGENTS.md',owner:'shared',kind:'file',bytes:Buffer.from('different')}];
  await assert.rejects(()=>preflightApply(lock,f.prepared,f.approval,f.registry),e=>e.code==='apply.adapter-drift');
  assert.deepEqual((await readdir(f.a)).sort(),['.pipeline','workspace.json']);await lock.release();
});
test('self-consistent forged target cannot turn approval digest into a repository path grant',async()=>{
  const f=await approvedFixture(),lock=await acquireWorkspaceLock(f.a),forged=structuredClone(f.prepared),plan=forged.preview.plan;
  plan.targets[0].path='project/docs/foreign.md';plan.desired.owned[0].path=plan.targets[0].path;
  forged.preview=bindPreview(plan,null,{observations:[{path:plan.targets[0].path,bytes:null}],outputs:[{path:plan.targets[0].path,bytes:Buffer.from('entry')}]});
  const {digest,...body}=forged;forged.digest=contractDigest(body);
  await assert.rejects(()=>preflightApply(lock,forged,{decision:'approve',preparedDigest:forged.digest},f.registry));
  assert.deepEqual((await readdir(f.a)).sort(),['.pipeline','workspace.json']);await lock.release();
});
test('apply rejects provider owner impersonation and preparation inside workspace',async()=>{
  const f=await approvedFixture(),lock=await acquireWorkspaceLock(f.a);
  f.registry.adapters.codex.plan=()=>[{path:'.claude/x',owner:'claude',kind:'file',bytes:Buffer.from('x')}];
  await assert.rejects(()=>preflightApply(lock,f.prepared,f.approval,f.registry),e=>e.code==='plan.adapter-owner');
  const forged=structuredClone(f.prepared);forged.preparation.objects=f.a;
  const {digest,...body}=forged;forged.digest=contractDigest(body);
  await assert.rejects(()=>preflightApply(lock,forged,{decision:'approve',preparedDigest:forged.digest},f.registry),e=>e.code==='apply.preparation-location');
  await lock.release();
});
test('apply rechecks targets after asynchronous adapter execution',async()=>{
  const f=await approvedFixture(),lock=await acquireWorkspaceLock(f.a),original=f.registry.sharedAdapter.plan;
  f.registry.sharedAdapter.plan=async context=>{await writeFile(path.join(f.a,'AGENTS.md'),'editor change');return original(context);};
  await assert.rejects(()=>preflightApply(lock,f.prepared,f.approval,f.registry),e=>e.code==='preview.before');
  assert.equal(await readFile(path.join(f.a,'AGENTS.md'),'utf8'),'editor change');await lock.release();
});
test('field takeover backup binds whole-file bytes separately from owned value hash; collisions fail closed',async()=>{
  const bytes=Buffer.from('{"managed":false,"foreign":"keep"}');
  const f=await approvedFixture({seed:{'.codex/test.json':bytes},codex:{plan:()=>[{path:'.codex/test.json',owner:'codex',kind:'json-fields',
    fields:[{pointer:'/managed',present:true,value:true,takeover:{beforeHash:contractDigest(false),desiredHash:contractDigest(true)}}]}]}});
  const lock=await acquireWorkspaceLock(f.a),checked=await preflightApply(lock,f.prepared,f.approval,f.registry);
  assert.equal(checked.backups.length,1);const backup=checked.backups[0];assert.equal(backup.hash,sha256(bytes));assert.deepEqual(backup.bytes,bytes);
  assert.notEqual(backup.hash,checked.prepared.preview.plan.desired.owned.find(o=>o.kind==='field').beforeHash);
  await mkdir(path.dirname(path.join(f.a,backup.path)),{recursive:true});await writeFile(path.join(f.a,backup.path),'foreign backup');
  await assert.rejects(()=>preflightApply(lock,f.prepared,f.approval,f.registry),e=>e.code==='apply.backup-conflict');
  assert.deepEqual(await readFile(path.join(f.a,'.codex/test.json')),bytes);await lock.release();
});
test('prepared approval binds native prepared source; stale decision and envelope mutation are refused',async()=>{
  const f=await approvedFixture(),lock=await acquireWorkspaceLock(f.a);
  const checked=await verifyPreparedApproval(lock,f.prepared,f.approval);
  assert.deepEqual(checked.prepared,f.prepared);assert.notEqual(checked.prepared,f.prepared);
  await assert.rejects(()=>verifyPreparedApproval(lock,f.prepared,{...f.approval,preparedDigest:contentHash}),e=>e.code==='apply.approval');
  const changed=structuredClone(f.prepared);changed.runtime='pass';
  await assert.rejects(()=>verifyPreparedApproval(lock,changed,f.approval),e=>e.code==='apply.prepared');
  assert.deepEqual((await readdir(f.a)).sort(),['.pipeline','workspace.json']);await lock.release();
});
test('prepared approval refuses manifest drift and corrupted preparation without creating target files',async()=>{
  const f=await approvedFixture(),lock=await acquireWorkspaceLock(f.a),original=await readFile(f.manifestPath);
  await writeFile(f.manifestPath,Buffer.concat([original,Buffer.from('\n')]));
  await assert.rejects(()=>verifyPreparedApproval(lock,f.prepared,f.approval),e=>e.code==='apply.origin-drift');
  await writeFile(f.manifestPath,original);
  await writeFile(path.join(f.prepared.preparation.snapshot,'resources/process.md'),'corrupt');
  await assert.rejects(()=>verifyPreparedApproval(lock,f.prepared,f.approval),e=>e.code==='inventory.hash');
  assert.deepEqual((await readdir(f.a)).sort(),['.pipeline','workspace.json']);await lock.release();
});
test('prepared approval rejects unknown or accessor approval properties before invoking getters',async()=>{
  const f=await approvedFixture(),lock=await acquireWorkspaceLock(f.a);
  for(const approval of [{...f.approval,extra:true},{get decision(){throw Error('getter');},preparedDigest:f.prepared.digest}])
    await assert.rejects(()=>verifyPreparedApproval(lock,f.prepared,approval),e=>e.code==='apply.approval');
  const changed=structuredClone(f.prepared);changed.preview.plan.source.path='.pipeline/snapshots/other';
  const {digest,...body}=changed;changed.digest=contractDigest(body);
  await assert.rejects(()=>verifyPreparedApproval(lock,changed,{decision:'approve',preparedDigest:changed.digest}));
  await lock.release();
});

function preflightFixture(workspace) {
  const plan=journalPlan(workspace,10);
  return bindPreview(plan,null,{observations:[...plan.targets.map(t=>({path:t.path,bytes:null})),{path:'unchanged',bytes:Buffer.from('keep')}],
    outputs:plan.targets.map(t=>({path:t.path,bytes:Buffer.from('fixture')}))});
}
test('preflight checks every target and unchanged dependency without writing targets',async()=>{
  const {a}=await fixture(),lock=await acquireWorkspaceLock(a),preview=preflightFixture(a);
  await writeFile(path.join(a,'unchanged'),'keep');
  assert.deepEqual(await preflightPreview(lock,preview,null,null),preview);
  await writeFile(path.join(a,'file-2'),'foreign');
  await assert.rejects(()=>preflightPreview(lock,preview,null,null),e=>e.code==='preview.before');
  assert.deepEqual((await readdir(a)).sort(),['.pipeline','file-2','unchanged']);
  assert.equal(await readFile(path.join(a,'file-2'),'utf8'),'foreign');await lock.release();
});
test('preflight refuses unchanged dependency drift, raw state mismatch, wrong workspace and released lock',async()=>{
  const {a,b}=await fixture(),lock=await acquireWorkspaceLock(a),preview=preflightFixture(a);
  await writeFile(path.join(a,'unchanged'),'changed');
  await assert.rejects(()=>preflightPreview(lock,preview,null,null),e=>e.code==='preview.drift');
  await assert.rejects(()=>preflightPreview(lock,preview,null,contentHash),e=>e.code==='apply.state-drift');
  const other=preflightFixture(b);
  await assert.rejects(()=>preflightPreview(lock,other,null,null),e=>e.code==='apply.workspace');
  await lock.release();
  await assert.rejects(()=>preflightPreview(lock,preview,null,null),e=>e.code==='lock.released');
});

async function preparedFixture(root,providers=['codex'],id='fixture') {
  const manifest={schemaVersion:1,id,version:'1.0.0',resources:'resources',inventory:'inventory.json',agentsDocument:{mode:'default'},
    providers:Object.fromEntries(providers.map(id=>[id,{skills:'skills',agents:null,mcp:null,entryInstructions:null,requires:[]}]))};
  const files=new Map(Object.entries({'pipeline.json':JSON.stringify(manifest),'resources/process.md':'rules','skills/test/SKILL.md':'skill'})
    .map(([name,value])=>[name,Buffer.from(value)]));
  files.set('inventory.json',Buffer.from(JSON.stringify(Object.fromEntries([...files].map(([name,bytes])=>[name,sha256(bytes)])))));
  const verified=await verifyPackage([...files].map(([name,bytes])=>({path:name,size:bytes.length,mode:'100644',type:'blob'})),async entry=>files.get(entry.path));
  return {...verified,snapshotPath:await materialize(verified,root)};
}

test('ISO-01 installed snapshot A/B/source copies are independent and matching copy is reusable',async()=>{
  const {root,a,b}=await fixture(),prepared=await preparedFixture(root),first=await acquireWorkspaceLock(a),second=await acquireWorkspaceLock(b);
  const installedA=await copySnapshot(first,prepared),installedB=await copySnapshot(second,prepared);
  assert.equal(installedA.created,true);assert.equal(installedB.created,true);
  assert.equal((await copySnapshot(first,prepared)).created,false);
  await writeFile(path.join(a,installedA.path,'resources/process.md'),'changed A');
  await assert.rejects(()=>copySnapshot(first,prepared),e=>e.code==='inventory.hash');
  await verifyPreparedSnapshot({...prepared,snapshotPath:path.join(b,installedB.path)});
  await verifyPreparedSnapshot(prepared);
  await writeFile(path.join(prepared.snapshotPath,'resources/process.md'),'changed source');
  await verifyPreparedSnapshot({...prepared,snapshotPath:path.join(b,installedB.path)});
  assert.equal(await readFile(path.join(a,installedA.path,'resources/process.md'),'utf8'),'changed A');
  await first.release();await second.release();
});
test('snapshot refuses corrupt source before destination creation and preserves partial destination',async()=>{
  const {root,a,b}=await fixture(),prepared=await preparedFixture(root),first=await acquireWorkspaceLock(a),second=await acquireWorkspaceLock(b);
  const relative='.pipeline/snapshots/'+prepared.digest.slice(7);
  await mkdir(path.join(a,relative),{recursive:true});
  await writeFile(path.join(a,relative,'unfinished'),'partial');
  await assert.rejects(()=>copySnapshot(first,prepared));
  assert.equal(await readFile(path.join(a,relative,'unfinished'),'utf8'),'partial');
  await writeFile(path.join(prepared.snapshotPath,'resources/process.md'),'bad');
  const before=await readdir(path.join(b,'.pipeline'));
  await assert.rejects(()=>copySnapshot(second,prepared),e=>e.code==='inventory.hash');
  assert.deepEqual(await readdir(path.join(b,'.pipeline')),before);await first.release();await second.release();
});
test('snapshot installation refuses redirected parent without writing outside workspace',async()=>{
  const {root,a}=await fixture(),prepared=await preparedFixture(root),lock=await acquireWorkspaceLock(a),outside=path.join(root,'outside');
  await mkdir(outside);await symlink(outside,path.join(a,'.pipeline/snapshots'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(()=>copySnapshot(lock,prepared),e=>e.code==='layout.link');
  assert.deepEqual(await readdir(outside),[]);await lock.release();
});

test('backup saves exact binary bytes, reuses matching copy and never overwrites mismatch',async()=>{
  const {a}=await fixture(),lock=await acquireWorkspaceLock(a),relative='.pipeline/backups/nested/original.bin';
  const bytes=Buffer.from([0,255,10,13,194,128]),hash=sha256(bytes);
  const first=await saveBackup(lock,relative,bytes,hash);assert.equal(first.created,true);
  assert.deepEqual(await readFile(path.join(a,relative)),bytes);
  assert.equal((await saveBackup(lock,relative,bytes,hash)).created,false);
  const changed=Buffer.from('other');await assert.rejects(()=>saveBackup(lock,relative,changed,sha256(changed)),e=>e.code==='backup.mismatch');
  assert.deepEqual(await readFile(path.join(a,relative)),bytes);await lock.release();
});
test('backup rejects wrong hash/path and released lock before new directories or files',async()=>{
  const {a}=await fixture(),lock=await acquireWorkspaceLock(a),before=await readdir(path.join(a,'.pipeline'));
  await assert.rejects(()=>saveBackup(lock,'.pipeline/backups/x',Buffer.from('x'),contentHash),e=>e.code==='backup.hash');
  await assert.rejects(()=>saveBackup(lock,'project/x',Buffer.from('fixture'),contentHash),e=>e.code==='backup.path');
  assert.deepEqual(await readdir(path.join(a,'.pipeline')),before);await lock.release();
  await assert.rejects(()=>saveBackup(lock,'.pipeline/backups/x',Buffer.from('fixture'),contentHash),e=>e.code==='lock.released');
});
test('ISO-01 backup copies remain independent across source buffer and workspaces',async()=>{
  const {a,b}=await fixture(),first=await acquireWorkspaceLock(a),second=await acquireWorkspaceLock(b);
  const bytes=Buffer.from('fixture'),relative='.pipeline/backups/original.bin';
  await saveBackup(first,relative,bytes,contentHash);await saveBackup(second,relative,bytes,contentHash);
  bytes[0]=0;await writeFile(path.join(a,relative),'modified A');
  await assert.rejects(()=>verifyBackup(a,relative,contentHash),e=>e.code==='backup.mismatch');
  assert.equal((await verifyBackup(b,relative,contentHash)).hash,contentHash);
  assert.equal(await readFile(path.join(b,relative),'utf8'),'fixture');await first.release();await second.release();
});
test('backup refuses redirected parent and leaves destination untouched',async()=>{
  const {root,a}=await fixture(),lock=await acquireWorkspaceLock(a),outside=path.join(root,'outside');await mkdir(outside);
  await symlink(outside,path.join(a,'.pipeline/backups'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(()=>saveBackup(lock,'.pipeline/backups/x',Buffer.from('fixture'),contentHash),e=>e.code==='layout.link');
  assert.deepEqual(await readdir(outside),[]);await lock.release();
});
test('backup verification distinguishes missing copy from empty file and corrupted bytes',async()=>{
  const {a}=await fixture(),lock=await acquireWorkspaceLock(a),relative='.pipeline/backups/empty.bin',bytes=Buffer.alloc(0);
  await assert.rejects(()=>verifyBackup(a,relative,sha256(bytes)),e=>e.code==='backup.missing');
  assert.equal((await saveBackup(lock,relative,bytes,sha256(bytes))).size,0);
  await writeFile(path.join(a,relative),'{torn');
  await assert.rejects(()=>saveBackup(lock,relative,bytes,sha256(bytes)),e=>e.code==='backup.mismatch');
  assert.equal(await readFile(path.join(a,relative),'utf8'),'{torn');await lock.release();
});

const contentHash=sha256(Buffer.from('fixture'));
function journalPlan(workspace,count=3) {
  // Structural plan fixture, not an implemented init lifecycle.
  return {schemaVersion:1,kind:'plan',workspace,command:'init',beforeStateHash:null,source:null,desired:null,
    targets:Array.from({length:count},(_,i)=>({id:'op-'+i,path:'file-'+i,owner:'shared',action:'create',beforeHash:null,desiredHash:contentHash,fields:[]}))};
}

test('journal records ordered intent/outcome and returns validated terminal receipt',async()=>{
  const {a}=await fixture(),lock=await acquireWorkspaceLock(a),plan=journalPlan(a,2);
  const journal=await createJournal(lock,plan);
  assert.equal((await readJournal(a,journal.relative,plan,null)).phase,'open');
  for(const target of plan.targets){await journal.intent(target.id);await journal.outcome('completed',contentHash);}
  const result=await readJournal(a,journal.relative,plan,null);
  assert.equal(result.phase,'terminal');assert.equal(result.receipt.status,'completed');
  assert.deepEqual(result.receipt.operations.map(o=>o.status),['completed','completed']);
  assert.equal((await readdir(a)).includes('file-0'),false);
  await lock.release();
});
test('journal append verification grows linearly, with complete audits at creation and terminal result',async()=>{
  for(const count of [4,40]) {
    const {a}=await fixture(),lock=await acquireWorkspaceLock(a),plan=journalPlan(a,count),journal=await createJournal(lock,plan);
    for(const target of plan.targets) {
      const intent=await journal.intent(target.id);assert.equal(intent.receipt,null);
      await journal.outcome('completed',contentHash);
    }
    assert.deepEqual(journal.metrics(),{headReads:2*count,recordReadbacks:2*count+1,fullAudits:2});
    assert.equal((await readJournal(a,journal.relative,plan,null)).receipt.status,'completed');await lock.release();
  }
});
test('changed older journal history cannot produce a terminal PASS despite a valid current head',async()=>{
  const {a}=await fixture(),lock=await acquireWorkspaceLock(a),plan=journalPlan(a,2),journal=await createJournal(lock,plan);
  await journal.intent('op-0');await journal.outcome('completed',contentHash);
  const filename=path.join(journal.directory,'000000.json'),event=JSON.parse(await readFile(filename,'utf8'));
  event.previous=contentHash;await writeFile(filename,JSON.stringify(event));
  await journal.intent('op-1');
  await assert.rejects(()=>journal.outcome('completed',contentHash),e=>e.code==='journal.binding');
  await assert.rejects(()=>readJournal(a,journal.relative,plan,null),e=>e.code==='journal.binding');
  await lock.release();
});
test('apply never activates when old journal history is corrupted during target processing',async()=>{
  const f=await approvedFixture(),lock=await acquireWorkspaceLock(f.a);
  await assert.rejects(()=>applyPrepared(lock,f.prepared,f.approval,f.registry,null,{boundary:async phase=>{
    if(phase==='write') {
      const [id]=await readdir(path.join(f.a,'.pipeline/journals'));
      await writeFile(path.join(f.a,'.pipeline/journals',id,'000000.json'),'corrupted history');
    }
  }}),e=>e.code==='parse.syntax');
  const state=(await readState(path.join(f.a,'.pipeline/state.json'))).value;
  assert.equal(state.status,'needs-reconciliation');assert.equal(state.active,null);
  assert.equal(await readFile(path.join(f.a,'AGENTS.md'),'utf8'),'entry');await lock.release();
});
test('persisted intent without outcome is uncertain with remainder skipped after reopening',async()=>{
  const {a}=await fixture(),lock=await acquireWorkspaceLock(a),plan=journalPlan(a);
  const journal=await createJournal(lock,plan);await journal.intent('op-0');await journal.outcome('completed',contentHash);await journal.intent('op-1');
  const result=await readJournal(a,journal.relative,plan,null);
  assert.equal(result.phase,'interrupted');assert.equal(result.receipt.status,'uncertain');
  assert.deepEqual(result.receipt.operations.map(o=>o.status),['completed','uncertain','skipped']);
  await lock.release();
});
test('failed outcome stops journal, preserves earlier completion and skips remaining',async()=>{
  const {a}=await fixture(),lock=await acquireWorkspaceLock(a),plan=journalPlan(a),journal=await createJournal(lock,plan);
  await journal.intent('op-0');await journal.outcome('completed',contentHash);
  await journal.intent('op-1');await journal.outcome('failed',null);
  await assert.rejects(()=>journal.intent('op-2'),e=>e.code==='journal.sequence');
  const result=await readJournal(a,journal.relative,plan,null);
  assert.deepEqual(result.receipt.operations.map(o=>o.status),['completed','failed','skipped']);
  await lock.release();
});
test('invalid result cannot turn intent into success; handle stops after error',async()=>{
  const {a}=await fixture(),lock=await acquireWorkspaceLock(a),plan=journalPlan(a),journal=await createJournal(lock,plan);
  await journal.intent('op-0');
  await assert.rejects(()=>journal.outcome('completed',null),e=>e.code==='journal.outcome');
  await assert.rejects(()=>journal.outcome('completed',contentHash),e=>e.code==='journal.unavailable');
  assert.equal((await readJournal(a,journal.relative,plan,null)).receipt.status,'uncertain');
  await lock.release();
});
test('journal requires real live lock capability, not copied token or released handle',async()=>{
  const {a}=await fixture(),lock=await acquireWorkspaceLock(a),plan=journalPlan(a);
  await assert.rejects(()=>createJournal({...lock},plan),e=>e.code==='lock.capability');
  const journal=await createJournal(lock,plan);await lock.release();
  await assert.rejects(()=>journal.intent('op-0'),e=>e.code==='lock.released');
  assert.equal((await readJournal(a,journal.relative,plan,null)).sequence,1);
});
test('journal detects changed records and torn next record without deleting evidence',async()=>{
  const {a,b}=await fixture();
  for(const [workspace,mode]of [[a,'binding'],[b,'torn']]) {
    const lock=await acquireWorkspaceLock(workspace),plan=journalPlan(workspace),journal=await createJournal(lock,plan);
    await journal.intent('op-0');
    const filename=path.join(journal.directory,'000001.json');
    if(mode==='binding') {const event=JSON.parse(await readFile(filename,'utf8'));event.previous=contentHash;await writeFile(filename,JSON.stringify(event));}
    else await writeFile(filename,'{"incomplete":');
    const bytes=await readFile(filename);
    await assert.rejects(()=>readJournal(workspace,journal.relative,plan,null));
    await assert.rejects(()=>journal.outcome('completed',contentHash));
    assert.deepEqual(await readFile(filename),bytes);await lock.release();
  }
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'wpc-s5-'));
  const a = path.join(root, 'a'), b = path.join(root, 'b');
  await mkdir(a); await mkdir(b);
  return {root,a,b};
}

test('TX-02 lock excludes same workspace but not another; release permits next owner', async () => {
  const {a,b} = await fixture(), first = await acquireWorkspaceLock(a);
  await assert.rejects(() => acquireWorkspaceLock(a), e => e.code === 'lock.busy');
  const second = await acquireWorkspaceLock(b);
  assert.notEqual(first.token, second.token);
  await second.release(); await first.release();
  const next = await acquireWorkspaceLock(a);
  assert.notEqual(first.token, next.token); await next.release();
  await assert.rejects(() => first.release(), e => e.code === 'lock.released');
});
test('TX-02 simultaneous acquisition produces exactly one owner', async () => {
  const {a} = await fixture();
  const results = await Promise.allSettled([acquireWorkspaceLock(a), acquireWorkspaceLock(a)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'lock.busy');
  await results.find(r => r.status === 'fulfilled').value.release();
});
test('TX-02 abandoned lock is preserved regardless of stale pid metadata', async () => {
  const {a} = await fixture(), directory = path.join(a, '.pipeline/lock');
  await mkdir(directory, {recursive:true});
  const file = path.join(directory, 'owner.json'), bytes = '{"pid":0,"createdAt":"1900-01-01"}\n';
  await writeFile(file, bytes);
  await assert.rejects(() => acquireWorkspaceLock(a), e => e.code === 'lock.busy');
  assert.equal(await readFile(file, 'utf8'), bytes);
});
test('owner tampering and unexpected lock files prevent release without deletion', async () => {
  const {a,b} = await fixture(), first = await acquireWorkspaceLock(a), second = await acquireWorkspaceLock(b);
  const file = path.join(first.directory, 'owner.json');
  await writeFile(file, '{"foreign":true}');
  await assert.rejects(() => first.release(), e => e.code === 'lock.owner-changed');
  assert.equal(await readFile(file,'utf8'), '{"foreign":true}');
  await writeFile(path.join(second.directory, 'foreign.txt'), 'preserve');
  await assert.rejects(() => second.release(), e => e.code === 'lock.foreign-entry');
  assert.deepEqual((await readdir(second.directory)).sort(), ['foreign.txt','owner.json']);
});
test('lock refuses missing workspace, metadata file and redirected metadata directory', async () => {
  const {root,a,b} = await fixture();
  await assert.rejects(() => acquireWorkspaceLock(path.join(root,'missing')), e => e.code === 'lock.workspace-missing');
  await writeFile(path.join(a,'.pipeline'), 'not a directory');
  await assert.rejects(() => acquireWorkspaceLock(a), e => e.code === 'layout.not-directory');
  const outside = path.join(root,'outside'); await mkdir(outside);
  await symlink(outside,path.join(b,'.pipeline'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => acquireWorkspaceLock(b), e => e.code === 'layout.link');
  assert.deepEqual(await readdir(outside), []);
});
