import test from 'node:test';
import {runCli} from '../src/commands/dispatch.js';
import {acquireRecoveryLease} from '../src/operations/recovery-lease.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp,mkdir,writeFile,readFile,readdir,rename } from 'node:fs/promises';
import { runGit } from '../src/source/git.js';
import { prepareRepositoryPreview } from '../src/workspace/repository-preview.js';
import { applyRepositoryOperations } from '../src/operations/repository-apply.js';
import { readRepositoryJournal } from '../src/operations/repository-journal.js';
import { inspectRepositoryReconciliation,finalizeRepositoryOperations,resumeRepositoryFinalization,verifyRepositoryCompletion } from '../src/operations/repository-reconcile.js';
import { createRepositoryWrapper } from '../src/operations/repository-bootstrap.js';
import { inspectRepositoryBootstrap } from '../src/operations/repository-bootstrap-reconcile.js';
import { recoverRepositoryBootstrap } from '../src/operations/repository-bootstrap-recover.js';
import {inspectBootstrapRecovery,finishBootstrapRecovery} from '../src/operations/repository-bootstrap-continuation.js';
import {listRepositoryHistory} from '../src/operations/repository-history.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { acquireBootstrapLock,bootstrapLockDirectory } from '../src/operations/bootstrap-lock.js';
import { acquireWorkspaceLock } from '../src/operations/lock.js';
import { inspectRepositoryLocks,recoverRepositoryLocks,inspectRepositoryLockRecovery,finishRepositoryLockRecovery,inspectRepositoryLockResumption } from '../src/operations/repository-lock-reconcile.js';
import { applyRepositoryWorkspace } from '../src/operations/repository-workspace.js';

async function fixture(move=false,action='directory',newWrapper=false) {
  const base=await mkdtemp(path.join(tmpdir(),'wpc-s7-apply-')),wrapper=path.join(base,'wrapper');
  if(!newWrapper)await mkdir(wrapper);
  const source={type:'git',transport:'local',path:'pipeline',ref:'HEAD',subdirectory:'.'};
  const pipeline={schemaVersion:1,id:'example',version:'1.0.0',resources:'resources',inventory:'inventory.json',
    providers:{codex:{skills:'skills',agents:null,mcp:null,entryInstructions:null,requires:[]}},agentsDocument:{mode:'default'}};
  const workspace={schemaVersion:1,pipeline:source,providers:['codex'],layout:{kind:'single-repo',
    repositories:{game:{path:'project',role:'code'}},documentation:{repository:'game',path:'docs'}}};
  if(action==='clone') {
    const original=path.join(base,'clone-source');await mkdir(original);await runGit(original,['init','--template=']);
    await writeFile(path.join(original,'game.txt'),'committed game');await runGit(original,['add','game.txt']);
    await runGit(original,['-c','user.name=S7','-c','user.email=s7@example.invalid','commit','-m','fixture']);
    await writeFile(path.join(original,'game.txt'),'dirty source must not be cloned');
    workspace.layout.repositories.game.source={...source,path:'clone-source'};
  }
  const manifestPath=path.join(base,'workspace.json');await writeFile(manifestPath,JSON.stringify(workspace));
  let choices={game:{action}};
  if(move){const from=path.join(base,'original');await mkdir(from);await runGit(from,['init','--template=']);
    await writeFile(path.join(from,'untracked.txt'),'preserve');choices={game:{action:'move',from}};}
  const options={command:'adopt',manifestPath};const preview=await prepareRepositoryPreview(pipeline,workspace,wrapper,choices,options);
  return {pipeline,workspace,wrapper,choices,options,preview,previewText:JSON.stringify(preview),approval:{decision:'approve',previewDigest:preview.digest}};
}

test('S7 finalization stops marker handoff after recovery lease loss',async()=>{
  const f=await fixture();await applyRepositoryOperations(f);
  const observed=await inspectRepositoryReconciliation(f.wrapper,f.previewText,f.preview.digest);
  const lease=await acquireRecoveryLease(f.wrapper);let released=false;
  try {
    await assert.rejects(finalizeRepositoryOperations({wrapper:f.wrapper,previewText:f.previewText,
      previewDigest:f.preview.digest,approval:{decision:'approve',reconciliationDigest:observed.digest},lease,
      ioBoundary:async phase=>{if(phase==='finalization-receipt-verified'){await lease.release();released=true;}}}),
      e=>e.code==='recovery-lease.not-held');
    assert.ok(await readFile(path.join(f.wrapper,'.pipeline/repository-operation.json')));
    const entries=await readdir(path.join(f.wrapper,'.pipeline/repository-completions'));
    assert.equal(entries.length,1);assert.ok(!entries[0].endsWith('.pending.json'));
    const fresh=await inspectRepositoryReconciliation(f.wrapper,f.previewText,f.preview.digest);
    await resumeRepositoryFinalization({wrapper:f.wrapper,previewText:f.previewText,previewDigest:f.preview.digest,
      approval:{decision:'approve',reconciliationDigest:fresh.digest}});
  }finally{if(!released)await lease.release();}
});

test('S7 bootstrap creates only approved wrapper and preserves intent before repository effects',async()=>{
  const f=await fixture(false,'directory',true);
  assert.equal(f.preview.wrapperObservation.action,'create');
  const result=await createRepositoryWrapper(f);
  assert.equal(result.pipelineActivated,false);assert.equal(result.repositoryEffectsPerformed,false);
  assert.deepEqual(await readdir(f.wrapper),['.pipeline']);
  const receipt=JSON.parse(await readFile(result.receipt,'utf8'));
  assert.equal(receipt.previewDigest,f.preview.digest);
  assert.ok(await readFile(path.join(f.wrapper,'.pipeline/repository-bootstrap-intent.json')));
  await assert.rejects(applyRepositoryOperations(f),e=>e.code==='repositories.preview-drift');
  const fresh=await prepareRepositoryPreview(f.pipeline,f.workspace,f.wrapper,f.choices,f.options);
  const applied=await applyRepositoryOperations({...f,previewText:JSON.stringify(fresh),approval:{decision:'approve',previewDigest:fresh.digest}});
  assert.equal(applied.status,'effects-completed');
});

test('S7 bootstrap interruption after mkdir keeps external intent and blocks a fresh executor',async()=>{
  const f=await fixture(false,'directory',true);let directory;
  await assert.rejects(createRepositoryWrapper({...f,ioBoundary:async phase=>{
    if(phase==='wrapper-created')throw Error('interrupted');
  }}),e=>{directory=e.bootstrapDirectory;return e.code==='repository-bootstrap.io';});
  assert.deepEqual(await readdir(f.wrapper),[]);
  assert.ok(await readFile(path.join(directory,'intent.json')));
  const fresh=await prepareRepositoryPreview(f.pipeline,f.workspace,f.wrapper,f.choices,f.options);
  await assert.rejects(applyRepositoryOperations({...f,previewText:JSON.stringify(fresh),approval:{decision:'approve',previewDigest:fresh.digest}}),
    e=>e.code==='bootstrap-lock.busy');
});

test('S7 bootstrap failure before mkdir retains intent without creating wrapper',async()=>{
  const f=await fixture(false,'directory',true);let directory;
  await assert.rejects(createRepositoryWrapper({...f,ioBoundary:async phase=>{
    if(phase==='wrapper-intent-persisted')throw Error('interrupted');
  }}),e=>{directory=e.bootstrapDirectory;return e.code==='repository-bootstrap.io';});
  await assert.rejects(readdir(f.wrapper),e=>e.code==='ENOENT');
  assert.ok(await readFile(path.join(directory,'intent.json')));
  await assert.rejects(createRepositoryWrapper(f),e=>e.code==='bootstrap-lock.busy');
});

test('S7 bootstrap preserves concurrent foreign files and refuses handoff',async()=>{
  const f=await fixture(false,'directory',true);
  await assert.rejects(createRepositoryWrapper({...f,ioBoundary:async phase=>{
    if(phase==='wrapper-created')await writeFile(path.join(f.wrapper,'foreign.txt'),'keep');
  }}),e=>e.code==='repository-bootstrap.wrapper-drift');
  assert.equal(await readFile(path.join(f.wrapper,'foreign.txt'),'utf8'),'keep');
});

test('S7 bootstrap detects receipt drift and retains external recovery lock',async()=>{
  const f=await fixture(false,'directory',true);let directory;
  await assert.rejects(createRepositoryWrapper({...f,ioBoundary:async(phase,detail)=>{
    if(phase==='wrapper-receipt-persisted') {
      const value=JSON.parse(await readFile(detail.receipt,'utf8'));value.pipelineActivated=true;
      await writeFile(detail.receipt,JSON.stringify(value));
    }
  }}),e=>{directory=e.bootstrapDirectory;return e.code==='repository-bootstrap.readback';});
  assert.ok(await readFile(path.join(directory,'intent.json')));
  assert.deepEqual((await readdir(f.wrapper)),['.pipeline']);
});

test('S7 bootstrap inspection distinguishes before mkdir and unattributed partial effect',async()=>{
  for(const phase of ['wrapper-intent-persisted','wrapper-created']) {
    const f=await fixture(false,'directory',true);
    await assert.rejects(createRepositoryWrapper({...f,ioBoundary:async current=>{if(current===phase)throw Error('stop');}}));
    const result=await inspectRepositoryBootstrap(f.wrapper,f.previewText,f.preview.digest);
    assert.equal(result.status,phase==='wrapper-created'?'effect-compatible-unconfirmed':'before-state-observed');
    assert.equal(result.canReleaseLock,false);assert.equal(result.canResume,false);
    assert.equal(result.ownerLiveness,'not-verified');
    assert.equal((await inspectRepositoryBootstrap(f.wrapper,f.previewText,f.preview.digest)).digest,result.digest);
  }
});

test('S7 bootstrap inspection binds receipt and distinguishes retained lock from completed handoff',async()=>{
  for(const interrupted of [true,false]) {
    const f=await fixture(false,'directory',true);
    if(interrupted)await assert.rejects(createRepositoryWrapper({...f,ioBoundary:async phase=>{
      if(phase==='wrapper-receipt-persisted')throw Error('stop');
    }}));else await createRepositoryWrapper(f);
    const result=await inspectRepositoryBootstrap(f.wrapper,f.previewText,f.preview.digest);
    assert.equal(result.status,interrupted?'receipt-consistent-lock-retained':'handoff-recorded');
    assert.equal(result.receiptConsistent,true);assert.equal(result.canReleaseLock,false);
    assert.equal(result.executionAuthorized,false);
  }
});

test('S7 bootstrap inspection refuses wrong approved digest and identifies changed receipt',async()=>{
  const f=await fixture(false,'directory',true),done=await createRepositoryWrapper(f);
  await assert.rejects(inspectRepositoryBootstrap(f.wrapper,f.previewText,'sha256:'+'0'.repeat(64)),
    e=>e.code==='repository-bootstrap.preview');
  const receipt=JSON.parse(await readFile(done.receipt,'utf8'));receipt.previewDigest='sha256:'+'1'.repeat(64);
  await writeFile(done.receipt,JSON.stringify(receipt));
  const result=await inspectRepositoryBootstrap(f.wrapper,f.previewText,f.preview.digest);
  assert.equal(result.status,'conflict');assert.ok(result.conflicts.includes('receipt-binding'));
});

test('S7 bootstrap inspection reports foreign files without deleting or authorizing them',async()=>{
  const f=await fixture(false,'directory',true);await createRepositoryWrapper(f);
  await writeFile(path.join(f.wrapper,'user.txt'),'preserve');
  const result=await inspectRepositoryBootstrap(f.wrapper,f.previewText,f.preview.digest);
  assert.equal(result.status,'conflict');assert.ok(result.conflicts.includes('wrapper-foreign-entry'));
  assert.equal(await readFile(path.join(f.wrapper,'user.txt'),'utf8'),'preserve');
});

test('S7 bootstrap inspection is zero-write when no attempt exists',async()=>{
  const f=await fixture(false,'directory',true),parent=path.dirname(f.wrapper),before=await readdir(parent);
  const result=await inspectRepositoryBootstrap(f.wrapper,f.previewText,f.preview.digest);
  assert.equal(result.status,'missing-records');assert.equal(result.canResume,false);
  assert.deepEqual(await readdir(parent),before);
  await assert.rejects(readdir(f.wrapper),e=>e.code==='ENOENT');
});

test('S7 bootstrap inspection rejects duplicate intent and foreign lock entries',async()=>{
  const f=await fixture(false,'directory',true);let directory;
  await assert.rejects(createRepositoryWrapper({...f,ioBoundary:async phase=>{
    if(phase==='wrapper-receipt-persisted')throw Error('stop');
  }}),e=>{directory=e.bootstrapDirectory;return e.code==='repository-bootstrap.io';});
  await writeFile(path.join(f.wrapper,'.pipeline/repository-bootstrap-intent.json'),await readFile(path.join(directory,'intent.json')));
  await writeFile(path.join(directory,'foreign.txt'),'keep');
  const result=await inspectRepositoryBootstrap(f.wrapper,f.previewText,f.preview.digest);
  assert.equal(result.status,'conflict');assert.ok(result.conflicts.includes('duplicate-intent'));
  assert.ok(result.conflicts.includes('lock-foreign-entry'));assert.equal(result.canReleaseLock,false);
  assert.equal(await readFile(path.join(directory,'foreign.txt'),'utf8'),'keep');
});

async function stoppedBootstrap(f,stopPhase='wrapper-receipt-persisted') {
  const moduleUrl=new URL('../src/operations/repository-bootstrap.js',import.meta.url).href;
  const code=`import {createRepositoryWrapper} from ${JSON.stringify(moduleUrl)};
    const input=JSON.parse(process.argv[1]);
    await createRepositoryWrapper({...input,ioBoundary:async phase=>{
      if(phase===${JSON.stringify(stopPhase)})process.exit(0);
    }});process.exit(9);`;
  await promisify(execFile)(process.execPath,['--input-type=module','--eval',code,JSON.stringify(f)],
    {windowsHide:true,timeout:30000});
  const inspected=await inspectRepositoryBootstrap(f.wrapper,f.previewText,f.preview.digest);
  return {wrapper:f.wrapper,previewText:f.previewText,previewDigest:f.preview.digest,
    approval:{decision:'approve',reconciliationDigest:inspected.digest}};
}

async function stoppedBootstrapRecovery(f,bootstrapPhase,recoveryPhase) {
  const request=await stoppedBootstrap(f,bootstrapPhase);
  const url=new URL('../src/operations/repository-bootstrap-recover.js',import.meta.url).href;
  const code=`import {recoverRepositoryBootstrap} from ${JSON.stringify(url)};
    await recoverRepositoryBootstrap({...JSON.parse(process.argv[1]),ioBoundary:async phase=>{
      if(phase===${JSON.stringify(recoveryPhase)})process.exit(0);
    }});process.exit(9);`;
  await promisify(execFile)(process.execPath,['--input-type=module','--eval',code,JSON.stringify(request)],{windowsHide:true,timeout:60000});
  return {wrapper:f.wrapper,initialDigest:request.approval.reconciliationDigest};
}

for(const [bootstrapPhase,recoveryPhase] of [
  ['wrapper-intent-persisted','recovery-gate-created'],
  ['wrapper-intent-persisted','recovery-lock-archived'],
    ['wrapper-receipt-persisted','recovery-gate-created'],
    ['wrapper-receipt-persisted','recovery-intent-archived'],
    ['wrapper-receipt-persisted','recovery-lock-archived'],
    ['wrapper-receipt-persisted','recovery-receipt-persisted'],
  ['wrapper-receipt-persisted','recovery-gate-archived']]) {
test('S7 interrupted bootstrap recovery continues '+bootstrapPhase+'/'+recoveryPhase,async()=>{
  const f=await fixture(false,'directory',true),args=await stoppedBootstrapRecovery(f,bootstrapPhase,recoveryPhase);
  const before=await inspectBootstrapRecovery(args);
  const requestBytes=await readFile(path.join(before.directory,'request.json'));
  await assert.rejects(finishBootstrapRecovery({...args,approval:{decision:'approve',recoveryDigest:'sha256:'+'0'.repeat(64)}}),
    e=>e.code==='bootstrap-continue.stale-approval');
  const command=['repositories','continue-bootstrap','--workspace',f.wrapper,'--initial',args.initialDigest];
  let out='',err='';
  assert.equal(await runCli(command,{stdout:s=>{out+=s;},stderr:s=>{err+=s;}}),0,err);
  const previewFile=path.join(path.dirname(f.wrapper),'bootstrap-continuation-preview.json');await writeFile(previewFile,out);
  out='';err='';
  assert.equal(await runCli([...command,'--apply','--preview',previewFile],{stdout:s=>{out+=s;},stderr:s=>{err+=s;}}),0,err);
  const result=JSON.parse(out);
  assert.equal(result.repositoryEffectsPerformed,false);
  const after=await inspectBootstrapRecovery(args);assert.equal(after.status,'complete');
  const listed=await listRepositoryHistory(f.wrapper);
  assert.ok(listed.entries.some(e=>e.path===after.directory && e.kind==='repository-bootstrap-recovery-history' && e.deletionEligible===false));
  assert.deepEqual(await readFile(path.join(after.directory,'request.json')),requestBytes);
  const names=await readdir(after.directory);
  await finishBootstrapRecovery({...args,approval:{decision:'approve',recoveryDigest:after.digest}});
  assert.deepEqual(await readdir(after.directory),names);
  const lock=await acquireBootstrapLock(f.wrapper);await lock.release();
  if(bootstrapPhase==='wrapper-intent-persisted')await assert.rejects(readdir(f.wrapper),e=>e.code==='ENOENT');
  else assert.equal((await inspectRepositoryBootstrap(f.wrapper,f.previewText,f.preview.digest)).status,'recovery-handoff-recorded');
});
}

test('S7 bootstrap continuation survives repeated deaths and retains approvals',async()=>{
  const f=await fixture(false,'directory',true),args=await stoppedBootstrapRecovery(f,'wrapper-receipt-persisted','recovery-gate-created');
  const url=new URL('../src/operations/repository-bootstrap-continuation.js',import.meta.url).href;
  for(const phase of ['bootstrap-continuation-authorized','bootstrap-continuation-receipt-persisted']) {
    const state=await inspectBootstrapRecovery(args);
    const code=`import {finishBootstrapRecovery} from ${JSON.stringify(url)};
      await finishBootstrapRecovery({...JSON.parse(process.argv[1]),ioBoundary:async phase=>{
        if(phase===${JSON.stringify(phase)})process.exit(0);
      }});process.exit(9);`;
    await promisify(execFile)(process.execPath,['--input-type=module','--eval',code,JSON.stringify({...args,
      approval:{decision:'approve',recoveryDigest:state.digest}})],{windowsHide:true,timeout:60000});
    await assert.rejects(acquireBootstrapLock(f.wrapper),e=>e.code==='bootstrap-lock.recovery-pending');
  }
  const state=await inspectBootstrapRecovery(args);assert.equal(state.authorizations.length,2);
  const original=await readFile(path.join(state.directory,state.authorizations[0].name));
  await finishBootstrapRecovery({...args,approval:{decision:'approve',recoveryDigest:state.digest}});
  const done=await inspectBootstrapRecovery(args);assert.equal(done.authorizations.length,3);
  assert.deepEqual(await readFile(path.join(done.directory,done.authorizations[0].name)),original);
});

test('S7 bootstrap continuation rejects live recovery owner without appending approval',async()=>{
  const f=await fixture(false,'directory',true),request=await stoppedBootstrap(f);
  await assert.rejects(recoverRepositoryBootstrap({...request,ioBoundary:async phase=>{
    if(phase==='recovery-gate-created')throw Error('stop');
  }}));
  const args={wrapper:f.wrapper,initialDigest:request.approval.reconciliationDigest};
  const current=await inspectBootstrapRecovery(args);assert.equal(current.ownerStopped,false);
  const before=await readdir(current.directory);
  await assert.rejects(finishBootstrapRecovery({...args,approval:{decision:'approve',recoveryDigest:current.digest}}),
    e=>e.code==='bootstrap-continue.owner-unconfirmed');
  assert.deepEqual(await readdir(current.directory),before);
});

test('S7 bootstrap continuation preserves unexpected wrapper data and incomplete request',async()=>{
  const f=await fixture(false,'directory',true),args=await stoppedBootstrapRecovery(f,'wrapper-receipt-persisted','recovery-lock-archived');
  const before=await inspectBootstrapRecovery(args),requestFile=path.join(before.directory,'request.json');
  await writeFile(path.join(f.wrapper,'foreign.txt'),'preserve');
  await assert.rejects(inspectBootstrapRecovery(args),e=>e.code==='bootstrap-continue.foreign-wrapper-entry');
  assert.equal(await readFile(path.join(f.wrapper,'foreign.txt'),'utf8'),'preserve');
  assert.deepEqual((await readdir(before.directory)).sort(),['owner.json','request.json']);
  await writeFile(requestFile,'{}');
  await assert.rejects(inspectBootstrapRecovery(args),e=>e.code==='bootstrap-continue.request');
  assert.equal(await readFile(requestFile,'utf8'),'{}');
});

test('S7 bootstrap recovery preserves stopped child history and permits fresh repository execution',async()=>{
  const f=await fixture(false,'directory',true),request=await stoppedBootstrap(f);
  const result=await recoverRepositoryBootstrap(request);
  assert.equal(result.status,'bootstrap-recovered');assert.equal(result.pipelineActivated,false);
  assert.ok(await readFile(path.join(result.archive,'owner.json')));
  assert.ok(await readFile(path.join(f.wrapper,'.pipeline/repository-bootstrap-intent.json')));
  assert.equal((await inspectRepositoryBootstrap(f.wrapper,f.previewText,f.preview.digest)).status,'recovery-handoff-recorded');
  const fresh=await prepareRepositoryPreview(f.pipeline,f.workspace,f.wrapper,f.choices,f.options);
  assert.equal((await applyRepositoryOperations({...f,previewText:JSON.stringify(fresh),
    approval:{decision:'approve',previewDigest:fresh.digest}})).status,'effects-completed');
});

test('S7 bootstrap recovery refuses live owner before writing recovery gate',async()=>{
  const f=await fixture(false,'directory',true);
  await assert.rejects(createRepositoryWrapper({...f,ioBoundary:async phase=>{
    if(phase==='wrapper-receipt-persisted')throw Error('stop');
  }}));
  const state=await inspectRepositoryBootstrap(f.wrapper,f.previewText,f.preview.digest);
  await assert.rejects(recoverRepositoryBootstrap({wrapper:f.wrapper,previewText:f.previewText,previewDigest:f.preview.digest,
    approval:{decision:'approve',reconciliationDigest:state.digest}}),e=>e.code==='bootstrap-recover.owner-live');
  await assert.rejects(readdir(state.directory+'.recovery'),e=>e.code==='ENOENT');
});

test('S7 bootstrap recovery gate blocks competitors and survives interrupted archival',async()=>{
  const f=await fixture(false,'directory',true),request=await stoppedBootstrap(f);let gate;
  await assert.rejects(recoverRepositoryBootstrap({...request,ioBoundary:async(phase,detail)=>{
    if(phase==='recovery-gate-created') {
      gate=detail.directory;
      await assert.rejects(acquireBootstrapLock(f.wrapper),e=>e.code==='bootstrap-lock.recovery-pending');
    }
    if(phase==='recovery-lock-archived')throw Error('stop');
  }}),e=>e.code==='bootstrap-recover.io');
  assert.ok(await readFile(path.join(gate,'owner.json')));
  await assert.rejects(acquireBootstrapLock(f.wrapper),e=>e.code==='bootstrap-lock.recovery-pending');
});

test('S7 bootstrap recovery rejects stale reconciliation approval',async()=>{
  const f=await fixture(false,'directory',true),request=await stoppedBootstrap(f);
  request.approval.reconciliationDigest='sha256:'+'0'.repeat(64);
  await assert.rejects(recoverRepositoryBootstrap(request),e=>e.code==='bootstrap-recover.stale-approval');
});

test('S7 bootstrap recovery refuses owner from another host',async()=>{
  const f=await fixture(false,'directory',true),request=await stoppedBootstrap(f);
  const state=await inspectRepositoryBootstrap(f.wrapper,f.previewText,f.preview.digest);
  const ownerFile=path.join(state.directory,'owner.json'),owner=JSON.parse(await readFile(ownerFile,'utf8'));
  owner.host='different-test-host.invalid';await writeFile(ownerFile,JSON.stringify(owner));
  request.approval.reconciliationDigest=(await inspectRepositoryBootstrap(f.wrapper,f.previewText,f.preview.digest)).digest;
  await assert.rejects(recoverRepositoryBootstrap(request),e=>e.code==='bootstrap-recover.owner-unknown');
  await assert.rejects(readdir(state.directory+'.recovery'),e=>e.code==='ENOENT');
});

test('S7 bootstrap recovery detects drift after gate acquisition without archiving lock',async()=>{
  const f=await fixture(false,'directory',true),request=await stoppedBootstrap(f);let gate;
  await assert.rejects(recoverRepositoryBootstrap({...request,ioBoundary:async(phase,detail)=>{
    if(phase==='recovery-gate-created') {
      gate=detail.directory;
      await writeFile(path.join(f.wrapper,'foreign.txt'),'keep');
    }
  }}),e=>e.code==='bootstrap-recover.drift');
  assert.ok(await readFile(path.join(gate.slice(0,-'.recovery'.length),'owner.json')));
  assert.equal(await readFile(path.join(f.wrapper,'foreign.txt'),'utf8'),'keep');
});

test('S7 bootstrap recovery archives absent-wrapper attempt and allows a fresh creation',async()=>{
  const f=await fixture(false,'directory',true),request=await stoppedBootstrap(f,'wrapper-intent-persisted');
  const before=await inspectRepositoryBootstrap(f.wrapper,f.previewText,f.preview.digest);
  const result=await recoverRepositoryBootstrap(request);
  assert.equal(result.status,'bootstrap-attempt-archived');
  const receipt=JSON.parse(await readFile(result.receipt,'utf8'));
  assert.equal(receipt.attemptCompleted,false);assert.equal(receipt.wrapperAbsentAtCheck,true);
  assert.equal(receipt.intentDigest,before.recordDigests.externalIntent);
  assert.ok(await readFile(path.join(result.archive,'intent.json')));
  assert.ok(await readFile(path.join(result.archive,'owner.json')));
  await assert.rejects(readdir(f.wrapper),e=>e.code==='ENOENT');
  const fresh=await prepareRepositoryPreview(f.pipeline,f.workspace,f.wrapper,f.choices,f.options);
  assert.equal((await createRepositoryWrapper({...f,previewText:JSON.stringify(fresh),
    approval:{decision:'approve',previewDigest:fresh.digest}})).status,'wrapper-created');
});

test('S7 bootstrap recovery never accepts existing empty wrapper without a receipt',async()=>{
  const f=await fixture(false,'directory',true),request=await stoppedBootstrap(f,'wrapper-created');
  await assert.rejects(recoverRepositoryBootstrap(request),e=>e.code==='bootstrap-recover.unconfirmed');
  assert.deepEqual(await readdir(f.wrapper),[]);
});

test('S7 bootstrap recovery interrupted absent-wrapper archival retains gate and history',async()=>{
  const f=await fixture(false,'directory',true),request=await stoppedBootstrap(f,'wrapper-intent-persisted');let archive,gate;
  await assert.rejects(recoverRepositoryBootstrap({...request,ioBoundary:async(phase,detail)=>{
    if(phase==='recovery-gate-created')gate=detail.directory;
    if(phase==='recovery-lock-archived'){archive=detail.archive;throw Error('stop');}
  }}),e=>e.code==='bootstrap-recover.io');
  assert.ok(await readFile(path.join(archive,'intent.json')));
  assert.ok(await readFile(path.join(gate,'owner.json')));
  await assert.rejects(acquireBootstrapLock(f.wrapper),e=>e.code==='bootstrap-lock.recovery-pending');
  await assert.rejects(readdir(f.wrapper),e=>e.code==='ENOENT');
});

test('S7 bootstrap recovery preserves a wrapper appearing before absent-attempt archival',async()=>{
  const f=await fixture(false,'directory',true),request=await stoppedBootstrap(f,'wrapper-intent-persisted');
  const before=await inspectRepositoryBootstrap(f.wrapper,f.previewText,f.preview.digest);let archive;
  await assert.rejects(recoverRepositoryBootstrap({...request,onLocation:async detail=>{
    if(detail.status==='history-planned') {
      archive=detail.directory;await mkdir(f.wrapper);await writeFile(path.join(f.wrapper,'foreign.txt'),'preserve');
    }
  }}),e=>e.code==='bootstrap-recover.drift');
  assert.equal(await readFile(path.join(f.wrapper,'foreign.txt'),'utf8'),'preserve');
  assert.ok(await readFile(path.join(before.directory,'intent.json')));
  await assert.rejects(readdir(archive),e=>e.code==='ENOENT');
  await assert.rejects(acquireBootstrapLock(f.wrapper),e=>e.code==='bootstrap-lock.recovery-pending');
});
test('S7 executor creates exact directory and leaves reconciliation marker with evidence',async()=>{
  const f=await fixture(),result=await applyRepositoryOperations(f);
  assert.equal(result.status,'effects-completed');assert.equal(result.requiresReconciliation,true);
  assert.deepEqual(await readdir(path.join(f.wrapper,'project')),[]);
  const marker=JSON.parse(await readFile(path.join(f.wrapper,'.pipeline/repository-operation.json'),'utf8'));
  assert.equal(marker.journal,result.journal);assert.equal(result.result.operations[0].status,'completed');
});

test('S7 workspace orchestration creates wrapper and executes original approved intents with traceable projection',async()=>{
  const f=await fixture(false,'init',true),result=await applyRepositoryWorkspace(f);
  assert.equal(result.status,'effects-completed');assert.equal(result.pipelineActivated,false);
  assert.equal(result.originalPreviewDigest,f.preview.digest);
  const chain=JSON.parse(await readFile(result.authorizationFile,'utf8'));
  assert.deepEqual(chain.originalApproval,f.approval);assert.equal(chain.newHumanApproval,false);
  assert.deepEqual(chain.originalPreview,f.preview);
  assert.equal(chain.derivedPreview.digest,result.executionPreview.digest);
  assert.equal(result.result.authorization.digest,result.authorizationDigest);
  const originalOp={...chain.originalPreview.operations[0]},derivedOp={...chain.derivedPreview.operations[0]};
  delete originalOp.destination;delete derivedOp.destination;assert.deepEqual(derivedOp,originalOp);
  assert.equal((await inspectRepositoryReconciliation(f.wrapper,JSON.stringify(result.executionPreview),result.executionPreview.digest)).canFinalize,true);
});

test('S7 workspace orchestration passes an existing wrapper through without synthetic approval',async()=>{
  const f=await fixture(),result=await applyRepositoryWorkspace(f);
  assert.equal(result.status,'effects-completed');assert.equal(result.authorizationFile,undefined);
  assert.equal((await inspectRepositoryReconciliation(f.wrapper,f.previewText,f.preview.digest)).canFinalize,true);
});

test('S7 workspace orchestration detects source drift after bootstrap and does not move it',async()=>{
  const f=await fixture(true,'directory',true);
  await assert.rejects(applyRepositoryWorkspace({...f,ioBoundary:async phase=>{
    if(phase==='workspace-bootstrap-completed')await writeFile(path.join(f.choices.game.from,'later.txt'),'keep');
  }}),e=>e.code==='repositories.preview-drift');
  assert.equal(await readFile(path.join(f.choices.game.from,'later.txt'),'utf8'),'keep');
  await assert.rejects(readdir(path.join(f.wrapper,'project')),e=>e.code==='ENOENT');
});

test('S7 workspace orchestration rejects changed bootstrap receipt before repository effects',async()=>{
  const f=await fixture(false,'directory',true);
  await assert.rejects(applyRepositoryWorkspace({...f,ioBoundary:async(phase,detail)=>{
    if(phase==='workspace-bootstrap-completed')await writeFile(detail.receipt,'{}');
  }}),e=>e.code==='repository-workspace.bootstrap-drift');
  await assert.rejects(readdir(path.join(f.wrapper,'project')),e=>e.code==='ENOENT');
  assert.ok(await readFile(path.join(f.wrapper,'.pipeline/repository-operation.json')));
});

test('S7 workspace orchestration executes multi-repository directory intents',async()=>{
  const f=await fixture(false,'directory',true);
  f.workspace.layout.kind='multi-repo';f.workspace.layout.repositories.library={path:'library',role:'library'};
  f.choices.library={action:'directory'};
  await writeFile(f.options.manifestPath,JSON.stringify(f.workspace));
  const preview=await prepareRepositoryPreview(f.pipeline,f.workspace,f.wrapper,f.choices,f.options);
  const result=await applyRepositoryWorkspace({...f,previewText:JSON.stringify(preview),approval:{decision:'approve',previewDigest:preview.digest}});
  assert.deepEqual(result.result.operations.map(o=>o.status),['completed','completed']);
  assert.deepEqual(await readdir(path.join(f.wrapper,'project')),[]);
  assert.deepEqual(await readdir(path.join(f.wrapper,'library')),[]);
});

test('S7 workspace orchestration refuses missing inner ancestors before creating wrapper',async()=>{
  const f=await fixture(false,'directory',true);
  f.workspace.layout.repositories.game.path='repositories/project';
  await writeFile(f.options.manifestPath,JSON.stringify(f.workspace));
  const preview=await prepareRepositoryPreview(f.pipeline,f.workspace,f.wrapper,f.choices,f.options);
  await assert.rejects(applyRepositoryWorkspace({...f,previewText:JSON.stringify(preview),approval:{decision:'approve',previewDigest:preview.digest}}),
    e=>e.code==='repositories.preview-blocked');
  await assert.rejects(readdir(f.wrapper),e=>e.code==='ENOENT');
});

test('S7 authorization mutation prevents reconciliation despite unchanged repository result',async()=>{
  const f=await fixture(false,'directory',true),result=await applyRepositoryWorkspace(f);
  const chain=JSON.parse(await readFile(result.authorizationFile,'utf8'));chain.newHumanApproval=true;
  await writeFile(result.authorizationFile,JSON.stringify(chain));
  await assert.rejects(inspectRepositoryReconciliation(f.wrapper,JSON.stringify(result.executionPreview),result.executionPreview.digest),
    e=>e.code==='repository-authorization.chain');
  assert.deepEqual(await readdir(path.join(f.wrapper,'project')),[]);
});

test('S7 authorization missing file is not treated as a direct approval',async()=>{
  const f=await fixture(false,'directory',true),result=await applyRepositoryWorkspace(f);
  await rename(result.authorizationFile,result.authorizationFile+'.preserved');
  await assert.rejects(inspectRepositoryReconciliation(f.wrapper,JSON.stringify(result.executionPreview),result.executionPreview.digest),
    e=>e.code==='record.missing');
  assert.ok(await readFile(path.join(f.wrapper,'.pipeline/repository-operation.json')));
});

test('S7 authorization rechecks historical bootstrap bytes during reconciliation',async()=>{
  const f=await fixture(false,'directory',true),result=await applyRepositoryWorkspace(f);
  await writeFile(path.join(f.wrapper,'.pipeline/repository-bootstrap-intent.json'),'{}');
  await assert.rejects(inspectRepositoryReconciliation(f.wrapper,JSON.stringify(result.executionPreview),result.executionPreview.digest),
    e=>e.code==='repository-authorization.bootstrap');
});
test('S7 executor moves actual Git repository preserving untracked bytes without origin edit',async()=>{
  const f=await fixture(true),before=await readFile(path.join(f.choices.game.from,'.git/config'));
  const result=await applyRepositoryOperations(f);
  assert.equal(await readFile(path.join(f.wrapper,'project/untracked.txt'),'utf8'),'preserve');
  assert.deepEqual(await readFile(path.join(f.wrapper,'project/.git/config')),before);
  await assert.rejects(readFile(path.join(f.choices.game.from,'untracked.txt')),e=>e.code==='ENOENT');
  assert.equal(result.result.operations[0].status,'completed');
});
test('S7 executor rejects bad approval before metadata writes',async()=>{
  const f=await fixture();await assert.rejects(applyRepositoryOperations({...f,approval:{decision:'no'}}),e=>e.code==='repository-apply.approval');
  assert.deepEqual(await readdir(f.wrapper),[]);
});
test('S7 post-effect crash preserves effect, uncertain journal and marker',async()=>{
  const f=await fixture();let journal;
  await assert.rejects(applyRepositoryOperations({...f,ioBoundary:async phase=>{if(phase==='after-effect')throw Error('synthetic crash');}}),e=>{
    journal=e.repositoryJournal;return e.code==='repository-apply.io';});
  assert.deepEqual(await readdir(path.join(f.wrapper,'project')),[]);
  const state=await readRepositoryJournal(f.wrapper,journal,f.preview);
  assert.equal(state.phase,'interrupted');assert.equal(state.operations[0].status,'uncertain');
  assert.ok(await readFile(path.join(f.wrapper,'.pipeline/repository-operation.json')));
});
test('S7 pre-effect source drift stops move and retry is blocked by persistent operation',async()=>{
  const f=await fixture(true);
  await assert.rejects(applyRepositoryOperations({...f,ioBoundary:async phase=>{
    if(phase==='before-effect')await writeFile(path.join(f.choices.game.from,'later.txt'),'external edit');
  }}),e=>e.code==='repository-apply.source-drift');
  assert.equal(await readFile(path.join(f.choices.game.from,'later.txt'),'utf8'),'external edit');
  assert.ok(!(await readdir(f.wrapper)).includes('project'));
  const fresh=await prepareRepositoryPreview(f.pipeline,f.workspace,f.wrapper,f.choices,f.options);
  await assert.rejects(applyRepositoryOperations({...f,previewText:JSON.stringify(fresh),approval:{decision:'approve',previewDigest:fresh.digest}}),
    e=>e.code==='repository-apply.pending');
});
test('S7 multi-operation failure preserves earlier effect and stops remaining operations',async()=>{
  const f=await fixture();f.workspace.layout.kind='multi-repo';
  f.workspace.layout.repositories.zdocs={path:'knowledge',role:'documentation'};
  f.choices.zdocs={action:'directory'};
  await writeFile(f.options.manifestPath,JSON.stringify(f.workspace));
  const preview=await prepareRepositoryPreview(f.pipeline,f.workspace,f.wrapper,f.choices,f.options);
  let journal;
  await assert.rejects(applyRepositoryOperations({...f,previewText:JSON.stringify(preview),approval:{decision:'approve',previewDigest:preview.digest},
    ioBoundary:async(phase,detail)=>{if(phase==='before-effect' && detail.repository==='zdocs')throw Error('synthetic interruption');}}),
    e=>{journal=e.repositoryJournal;return e.code==='repository-apply.io';});
  assert.deepEqual(await readdir(path.join(f.wrapper,'project')),[]);
  assert.ok(!(await readdir(f.wrapper)).includes('knowledge'));
  const state=await readRepositoryJournal(f.wrapper,journal,preview);
  assert.deepEqual(state.operations.map(o=>o.status),['completed','uncertain']);
});
test('S7 reconciliation verifies completed directory evidence and detects later changes',async()=>{
  const f=await fixture(),applied=await applyRepositoryOperations(f);
  const before=await readFile(path.join(f.wrapper,'.pipeline/repository-operation.json'));
  const result=await inspectRepositoryReconciliation(f.wrapper,f.previewText,f.preview.digest);
  assert.equal(result.canFinalize,true);assert.equal(result.observations[0].state,'completed-verified');
  assert.deepEqual(await readFile(path.join(f.wrapper,'.pipeline/repository-operation.json')),before);
  await writeFile(path.join(f.wrapper,'project/foreign.txt'),'do not overwrite');
  const drift=await inspectRepositoryReconciliation(f.wrapper,f.previewText,f.preview.digest);
  assert.equal(drift.canFinalize,false);assert.equal(drift.observations[0].state,'conflict');
  await writeFile(path.join(applied.evidenceDirectory,'000000.json'),'{}');
  await assert.rejects(inspectRepositoryReconciliation(f.wrapper,f.previewText,f.preview.digest),e=>e.code==='repository-reconcile.evidence');
});
test('S7 reconciliation never accepts uncertain effect based on directory shape alone',async()=>{
  const f=await fixture();
  await assert.rejects(applyRepositoryOperations({...f,ioBoundary:async phase=>{if(phase==='after-effect')throw Error('crash');}}));
  const result=await inspectRepositoryReconciliation(f.wrapper,f.previewText,f.preview.digest);
  assert.equal(result.canFinalize,false);assert.equal(result.observations[0].state,'effect-compatible-unconfirmed');
  assert.equal(result.executionAuthorized,false);
});
test('S7 reconciliation validates moved content and source absence',async()=>{
  const f=await fixture(true);await applyRepositoryOperations(f);
  const result=await inspectRepositoryReconciliation(f.wrapper,f.previewText,f.preview.digest);
  assert.equal(result.canFinalize,true);assert.equal(result.observations[0].sourceDigest,null);
  await mkdir(f.choices.game.from);
  assert.equal((await inspectRepositoryReconciliation(f.wrapper,f.previewText,f.preview.digest)).canFinalize,false);
});
test('S7 explicit finalization preserves pending history and does not activate a pipeline',async()=>{
  const f=await fixture();await applyRepositoryOperations(f);
  const marker=await readFile(path.join(f.wrapper,'.pipeline/repository-operation.json'));
  const checked=await inspectRepositoryReconciliation(f.wrapper,f.previewText,f.preview.digest);
  const result=await finalizeRepositoryOperations({wrapper:f.wrapper,previewText:f.previewText,previewDigest:f.preview.digest,
    approval:{decision:'approve',reconciliationDigest:checked.digest}});
  assert.equal(result.pipelineActivated,false);assert.deepEqual(await readFile(result.historyFile),marker);
  await assert.rejects(readFile(path.join(f.wrapper,'.pipeline/repository-operation.json')),e=>e.code==='ENOENT');
  assert.equal(JSON.parse(await readFile(result.receiptFile,'utf8')).reconciliation.digest,checked.digest);
});
test('S7 unresolved effects cannot be finalized even with exact reconciliation approval',async()=>{
  const f=await fixture();
  await assert.rejects(applyRepositoryOperations({...f,ioBoundary:async phase=>{if(phase==='after-effect')throw Error('crash');}}));
  const checked=await inspectRepositoryReconciliation(f.wrapper,f.previewText,f.preview.digest);
  await assert.rejects(finalizeRepositoryOperations({wrapper:f.wrapper,previewText:f.previewText,previewDigest:f.preview.digest,
    approval:{decision:'approve',reconciliationDigest:checked.digest}}),e=>e.code==='repository-reconcile.unresolved');
  assert.ok(await readFile(path.join(f.wrapper,'.pipeline/repository-operation.json')));
});

async function interruptedFinalization() {
  const f=await fixture();await applyRepositoryOperations(f);
  const checked=await inspectRepositoryReconciliation(f.wrapper,f.previewText,f.preview.digest);
  const request={wrapper:f.wrapper,previewText:f.previewText,previewDigest:f.preview.digest,
    approval:{decision:'approve',reconciliationDigest:checked.digest}};
  let files;
  await assert.rejects(finalizeRepositoryOperations({...request,ioBoundary:async(phase,detail)=>{
    if(phase==='finalization-receipt-verified'){files=detail;throw Error('interrupted-finalization');}
  }}),/interrupted-finalization/);
  return {f,request,files};
}

async function completedHandoff() {
  const f=await fixture();await applyRepositoryOperations(f);
  const checked=await inspectRepositoryReconciliation(f.wrapper,f.previewText,f.preview.digest);
  const request={wrapper:f.wrapper,previewText:f.previewText,previewDigest:f.preview.digest,
    journal:checked.journal,reconciliationDigest:checked.digest};
  let files;
  await assert.rejects(finalizeRepositoryOperations({...request,
    approval:{decision:'approve',reconciliationDigest:checked.digest},ioBoundary:async(phase,detail)=>{
      if(phase==='finalization-marker-moved'){files=detail;throw Error('handoff-interrupted');}
    }}),/handoff-interrupted/);
  return {f,request,files};
}

test('S7 completion confirmation after marker handoff is read-only and repeatable',async()=>{
  const {f,request,files}=await completedHandoff();
  const names=await readdir(path.join(f.wrapper,'.pipeline'),{recursive:true});
  const receipt=await readFile(files.receiptFile),history=await readFile(files.historyFile);
  const first=await verifyRepositoryCompletion(request);
  assert.deepEqual(await verifyRepositoryCompletion(request),first);
  assert.equal(first.executionAuthorized,false);assert.equal(first.pipelineActivated,false);
  assert.deepEqual(await readdir(path.join(f.wrapper,'.pipeline'),{recursive:true}),names);
  assert.deepEqual(await readFile(files.receiptFile),receipt);assert.deepEqual(await readFile(files.historyFile),history);
});

test('S7 completion confirmation rejects changed receipt without repairing it',async()=>{
  const {request,files}=await completedHandoff();
  await writeFile(files.receiptFile,'{}');
  await assert.rejects(verifyRepositoryCompletion(request),e=>e.code==='repository-reconcile.completion-receipt');
  assert.equal(await readFile(files.receiptFile,'utf8'),'{}');
});

test('S7 completion confirmation rejects changed target and unrelated approval',async()=>{
  const {f,request}=await completedHandoff();
  await assert.rejects(verifyRepositoryCompletion({...request,reconciliationDigest:'sha256:'+'0'.repeat(64)}),e=>e.code==='repository-reconcile.completion-drift');
  await assert.rejects(verifyRepositoryCompletion({...request,journal:'../outside'}),e=>e.code==='repository-reconcile.completion-journal');
  await writeFile(path.join(f.wrapper,'project','foreign.txt'),'preserve');
  await assert.rejects(verifyRepositoryCompletion(request),e=>e.code==='repository-reconcile.completion-drift');
});

test('S7 completion confirmation refuses any new pending marker',async()=>{
  const {f,request}=await completedHandoff();
  const filename=path.join(f.wrapper,'.pipeline/repository-operation.json');
  await writeFile(filename,'{}');
  await assert.rejects(verifyRepositoryCompletion(request),e=>e.code==='repository-reconcile.completion-pending');
  assert.equal(await readFile(filename,'utf8'),'{}');
});

for(const stopPhase of ['finalization-receipt-verified','finalization-marker-moved']) {
  test('S7 process exit at '+stopPhase+' preserves dead-owner locks and durable records',async()=>{
    const f=await fixture();await applyRepositoryOperations(f);
    const checked=await inspectRepositoryReconciliation(f.wrapper,f.previewText,f.preview.digest);
    const request={wrapper:f.wrapper,previewText:f.previewText,previewDigest:f.preview.digest,
      approval:{decision:'approve',reconciliationDigest:checked.digest}};
    const moduleUrl=new URL('../src/operations/repository-reconcile.js',import.meta.url).href;
    const code=`import {finalizeRepositoryOperations} from ${JSON.stringify(moduleUrl)};
      await finalizeRepositoryOperations({...JSON.parse(process.argv[1]),ioBoundary:async phase=>{
        if(phase===${JSON.stringify(stopPhase)})process.exit(0);
      }});process.exit(9);`;
    await promisify(execFile)(process.execPath,['--input-type=module','--eval',code,JSON.stringify(request)],
      {windowsHide:true,timeout:30000});
    const bootstrap=bootstrapLockDirectory(f.wrapper),workspaceLock=path.join(f.wrapper,'.pipeline/lock');
    const owners=await Promise.all([bootstrap,workspaceLock].map(p=>readFile(path.join(p,'owner.json'))));
    const firstOwner=JSON.parse(owners[0]),secondOwner=JSON.parse(owners[1]);
    assert.equal(firstOwner.pid,secondOwner.pid);assert.notEqual(firstOwner.pid,process.pid);
    assert.throws(()=>process.kill(firstOwner.pid,0),e=>e.code==='ESRCH');
    const base=path.join(f.wrapper,'.pipeline/repository-completions',path.basename(checked.journal));
    const receipt=await readFile(base+'.json');
    const before=await readdir(path.join(f.wrapper,'.pipeline'),{recursive:true});
    const lockRequest={...request,journal:checked.journal,reconciliationDigest:checked.digest};
    const lockState=await inspectRepositoryLocks(lockRequest);
    assert.equal(lockState.status,'stopped-owner-observed');assert.equal(lockState.canReleaseLock,false);
    assert.equal(lockState.phase,stopPhase==='finalization-marker-moved'?'completion-recorded':'finalization-pending');
    assert.deepEqual(await inspectRepositoryLocks(lockRequest),lockState);
    if(stopPhase==='finalization-marker-moved') {
      const result=await verifyRepositoryCompletion({...request,journal:checked.journal,reconciliationDigest:checked.digest});
      assert.equal(result.status,'repository-effects-verified');assert.equal(result.executionAuthorized,false);
      await assert.rejects(readFile(path.join(f.wrapper,'.pipeline/repository-operation.json')),e=>e.code==='ENOENT');
      assert.ok(await readFile(base+'.pending.json'));
    } else {
      assert.equal((await inspectRepositoryReconciliation(f.wrapper,f.previewText,f.preview.digest)).digest,checked.digest);
      await assert.rejects(resumeRepositoryFinalization(request),e=>e.code==='bootstrap-lock.busy');
      await assert.rejects(readFile(base+'.pending.json'),e=>e.code==='ENOENT');
    }
    // Read-only confirmation is not stale-lock recovery or permission to proceed.
    await assert.rejects(acquireBootstrapLock(f.wrapper),e=>e.code==='bootstrap-lock.busy');
    await assert.rejects(acquireWorkspaceLock(f.wrapper),e=>e.code==='lock.repository-pending');
    assert.deepEqual(await Promise.all([bootstrap,workspaceLock].map(p=>readFile(path.join(p,'owner.json')))),owners);
    assert.deepEqual(await readFile(base+'.json'),receipt);
    assert.deepEqual(await readdir(path.join(f.wrapper,'.pipeline'),{recursive:true}),before);
    assert.deepEqual(await readdir(path.join(f.wrapper,'project')),[]);
    await writeFile(path.join(bootstrap,'owner.json'),JSON.stringify({...firstOwner,host:'foreign.invalid'}));
    await assert.rejects(inspectRepositoryLocks(lockRequest),e=>e.code==='repository-lock.owner-mismatch');
    await writeFile(path.join(workspaceLock,'owner.json'),JSON.stringify({...secondOwner,host:'foreign.invalid'}));
    const foreign=await inspectRepositoryLocks(lockRequest);
    assert.equal(foreign.ownerLiveness,'unknown-host');assert.equal(foreign.status,'owner-unconfirmed');
    assert.equal(foreign.canReleaseLock,false);
    await writeFile(path.join(bootstrap,'owner.json'),owners[0]);
    await writeFile(path.join(workspaceLock,'owner.json'),owners[1]);
    await writeFile(path.join(workspaceLock,'foreign.txt'),'preserve');
    await assert.rejects(inspectRepositoryLocks(lockRequest),e=>e.code==='repository-lock.foreign-entry');
    assert.equal(await readFile(path.join(workspaceLock,'foreign.txt'),'utf8'),'preserve');
  });
}

test('S7 lock reconciliation never authorizes live owners or accepts unrelated approval',async()=>{
  const f=await fixture();await applyRepositoryOperations(f);
  const checked=await inspectRepositoryReconciliation(f.wrapper,f.previewText,f.preview.digest);
  const request={wrapper:f.wrapper,previewText:f.previewText,previewDigest:f.preview.digest,
    journal:checked.journal,reconciliationDigest:checked.digest};
  await finalizeRepositoryOperations({...request,approval:{decision:'approve',reconciliationDigest:checked.digest},
    ioBoundary:async phase=>{
      if(phase!=='finalization-receipt-verified')return;
      const result=await inspectRepositoryLocks(request);
      assert.equal(result.ownerLiveness,'live-or-reused-pid');assert.equal(result.canReleaseLock,false);
      assert.equal(result.executionAuthorized,false);
      await assert.rejects(recoverRepositoryLocks({...request,approval:{decision:'approve',lockDigest:result.digest}}),
        e=>e.code==='repository-lock.owner-unconfirmed');
      await assert.rejects(inspectRepositoryLocks({...request,reconciliationDigest:'sha256:'+'0'.repeat(64)}),
        e=>e.code==='repository-lock.subject');
    }});
});

async function stoppedFinalization(stopPhase) {
  const f=await fixture();await applyRepositoryOperations(f);
  const checked=await inspectRepositoryReconciliation(f.wrapper,f.previewText,f.preview.digest);
  const request={wrapper:f.wrapper,previewText:f.previewText,previewDigest:f.preview.digest,
    journal:checked.journal,reconciliationDigest:checked.digest};
  const url=new URL('../src/operations/repository-reconcile.js',import.meta.url).href;
  const code=`import {finalizeRepositoryOperations} from ${JSON.stringify(url)};
    const input=JSON.parse(process.argv[1]);
    await finalizeRepositoryOperations({...input,approval:{decision:'approve',reconciliationDigest:input.reconciliationDigest},
      ioBoundary:async phase=>{if(phase===${JSON.stringify(stopPhase)})process.exit(0);}});process.exit(9);`;
  await promisify(execFile)(process.execPath,['--input-type=module','--eval',code,JSON.stringify(request)],
    {windowsHide:true,timeout:30000});
  const state=await inspectRepositoryLocks(request);
  return {f,request:{...request,approval:{decision:'approve',lockDigest:state.digest}},state};
}

for(const phase of ['finalization-receipt-verified','finalization-marker-moved']) {
  test('S7 lock retirement preserves owners and permits continuation after '+phase,async()=>{
    const {f,request,state}=await stoppedFinalization(phase);
    const owners=await Promise.all(state.locks.map(lock=>readFile(path.join(lock.directory,'owner.json'))));
    const result=await recoverRepositoryLocks(request);
    assert.equal(result.status,'repository-locks-retired');assert.equal(result.pipelineActivated,false);
    assert.deepEqual(await readFile(path.join(result.archive,'bootstrap-lock/owner.json')),owners[0]);
    assert.deepEqual(await readFile(path.join(result.archive,'workspace-lock/owner.json')),owners[1]);
    const retainedGate=JSON.parse(await readFile(path.join(result.archive,'recovery-gate/owner.json'),'utf8'));
    assert.equal(retainedGate.lockDigest,state.digest);assert.equal(retainedGate.wrapper,f.wrapper);
    await assert.rejects(readdir(bootstrapLockDirectory(f.wrapper)+'.recovery'),e=>e.code==='ENOENT');
    if(phase==='finalization-receipt-verified') {
      assert.equal(result.requiresFinalization,true);
      await assert.rejects(acquireWorkspaceLock(f.wrapper),e=>e.code==='lock.repository-pending');
      await resumeRepositoryFinalization({...request,approval:{decision:'approve',reconciliationDigest:request.reconciliationDigest}});
    } else assert.equal(result.requiresFinalization,false);
    assert.equal((await verifyRepositoryCompletion(request)).status,'repository-effects-verified');
    const lock=await acquireWorkspaceLock(f.wrapper);await lock.release();
    assert.deepEqual(await readdir(path.join(f.wrapper,'project')),[]);
  });
}

test('S7 first lock retirement survives process death after atomic gate archival',async()=>{
  const {f,request}=await stoppedFinalization('finalization-marker-moved');
  const url=new URL('../src/operations/repository-lock-reconcile.js',import.meta.url).href;
  await assert.rejects(promisify(execFile)(process.execPath,['--input-type=module','--eval',
    `import {recoverRepositoryLocks} from ${JSON.stringify(url)};
     await recoverRepositoryLocks({...JSON.parse(process.argv[1]),ioBoundary:async phase=>{if(phase==='lock-recovery-first-gate-archived')process.exit(77)}});process.exit(9);`,JSON.stringify(request)],
    {windowsHide:true,timeout:30000}),e=>e.code===77);
  const archive=path.join(f.wrapper,'.pipeline/repository-lock-recoveries',request.approval.lockDigest.slice(7));
  assert.ok(await readFile(path.join(archive,'recovery-gate/owner.json')));
  assert.ok(await readFile(path.join(archive,'request.json')));assert.ok(await readFile(path.join(archive,'receipt.json')));
  await assert.rejects(readdir(bootstrapLockDirectory(f.wrapper)+'.recovery'),e=>e.code==='ENOENT');
  assert.equal((await verifyRepositoryCompletion(request)).status,'repository-effects-verified');
  const lock=await acquireWorkspaceLock(f.wrapper);await lock.release();
});

test('S7 lock retirement rejects stale approval before creating gate',async()=>{
  const {f,request}=await stoppedFinalization('finalization-marker-moved');
  await assert.rejects(recoverRepositoryLocks({...request,approval:{decision:'approve',lockDigest:'sha256:'+'0'.repeat(64)}}),
    e=>e.code==='repository-lock.stale-approval');
  await assert.rejects(readdir(bootstrapLockDirectory(f.wrapper)+'.recovery'),e=>e.code==='ENOENT');
});

test('S7 lock retirement detects subject drift under its gate without moving owners',async()=>{
  const {f,request,state}=await stoppedFinalization('finalization-marker-moved');
  await assert.rejects(recoverRepositoryLocks({...request,ioBoundary:async phase=>{
    if(phase==='lock-recovery-gate-created')await writeFile(path.join(f.wrapper,'project/foreign.txt'),'preserve');
  }}));
  for(const lock of state.locks)assert.ok(await readFile(path.join(lock.directory,'owner.json')));
  await assert.rejects(acquireBootstrapLock(f.wrapper),e=>e.code==='bootstrap-lock.recovery-pending');
  assert.equal(await readFile(path.join(f.wrapper,'project/foreign.txt'),'utf8'),'preserve');
});

test('S7 first retirement rechecks repository subject before the second lock move',async()=>{
  const {f,request,state}=await stoppedFinalization('finalization-marker-moved');let archive;
  await assert.rejects(recoverRepositoryLocks({...request,ioBoundary:async(phase,detail)=>{
    if(phase==='lock-recovery-lock-archived' && detail.index===1){
      archive=detail.archive;await writeFile(path.join(f.wrapper,'project','foreign.txt'),'preserve');
    }
  }}),e=>e.code==='repository-reconcile.completion-drift');
  assert.ok(await readFile(path.join(state.locks[0].directory,'owner.json')));
  assert.ok(await readFile(path.join(archive,'workspace-lock','owner.json')));
  await assert.rejects(readdir(path.join(archive,'bootstrap-lock')),e=>e.code==='ENOENT');
  await assert.rejects(readFile(path.join(archive,'receipt.json')),e=>e.code==='ENOENT');
  await assert.rejects(acquireWorkspaceLock(f.wrapper),e=>e.code==='lock.repository-pending');
  assert.equal(await readFile(path.join(f.wrapper,'project','foreign.txt'),'utf8'),'preserve');
});

for(const [stopPhase,index,expected] of [
  ['lock-recovery-intent-persisted',null,'intent-recorded'],
  ['lock-recovery-lock-archived',1,'workspace-lock-archived'],
  ['lock-recovery-lock-archived',0,'locks-archived-receipt-missing'],
  ['lock-recovery-receipt-persisted',null,'receipt-recorded-gate-retained']]) {
test('S7 lock retirement interruption at '+expected+' retains history and recovery gate',async()=>{
  const {f,request,state}=await stoppedFinalization('finalization-marker-moved');let archive;
  await assert.rejects(recoverRepositoryLocks({...request,ioBoundary:async(phase,detail)=>{
    if(phase===stopPhase && (index===null || detail.index===index)){archive=detail.archive;throw Error('stop');}
  }}),/stop/);
  const args={...request,lockDigest:state.digest};
  const before=await readdir(archive,{recursive:true});
  const observed=await inspectRepositoryLockRecovery(args);
  assert.equal(observed.status,expected);assert.equal(observed.canResume,false);
  assert.equal(observed.recoveryOwnerLiveness,'live-or-reused-pid');
  assert.deepEqual(await inspectRepositoryLockRecovery(args),observed);
  await assert.rejects(finishRepositoryLockRecovery({...args,approval:{decision:'approve',recoveryDigest:observed.digest}}),
    e=>e.code==='repository-lock.resume-owner');
  assert.deepEqual(await readdir(archive,{recursive:true}),before);
  await assert.rejects(acquireWorkspaceLock(f.wrapper),e=>e.code==='lock.repository-pending');
  await assert.rejects(acquireBootstrapLock(f.wrapper),e=>e.code==='bootstrap-lock.recovery-pending');
  if(expected==='receipt-recorded-gate-retained') {
    await writeFile(path.join(archive,'receipt.json'),'{}');
    await assert.rejects(inspectRepositoryLockRecovery(args),e=>e.code==='repository-lock.recovery-receipt');
  } else if(expected==='workspace-lock-archived') {
    await mkdir(state.locks[1].directory);
    await assert.rejects(inspectRepositoryLockRecovery(args),e=>e.code==='repository-lock.recovery-location');
  } else if(expected==='intent-recorded') {
    await writeFile(path.join(archive,'request.json'),'{}');
    await assert.rejects(inspectRepositoryLockRecovery(args),e=>e.code==='repository-lock.recovery-request');
  } else {
    await writeFile(path.join(f.wrapper,'project/foreign.txt'),'preserve');
    await assert.rejects(inspectRepositoryLockRecovery(args),e=>e.code==='repository-reconcile.completion-drift');
  }
});
}

async function stoppedLockRecovery(finalizationPhase='finalization-marker-moved',stopPhase='lock-recovery-receipt-persisted',stopIndex=null) {
  const {f,request,state}=await stoppedFinalization(finalizationPhase);
  const url=new URL('../src/operations/repository-lock-reconcile.js',import.meta.url).href;
  const code=`import {recoverRepositoryLocks} from ${JSON.stringify(url)};
    await recoverRepositoryLocks({...JSON.parse(process.argv[1]),ioBoundary:async(phase,detail)=>{
      if(phase===${JSON.stringify(stopPhase)} && (${JSON.stringify(stopIndex)}===null || detail.index===${JSON.stringify(stopIndex)}))process.exit(0);
    }});process.exit(9);`;
  await promisify(execFile)(process.execPath,['--input-type=module','--eval',code,JSON.stringify(request)],
    {windowsHide:true,timeout:30000});
  const args={...request,lockDigest:state.digest};
  const observation=await inspectRepositoryLockRecovery(args);
  assert.equal(observation.recoveryOwnerLiveness,'local-pid-absent');
  return {f,args:{...args,approval:{decision:'approve',recoveryDigest:observation.digest}},observation};
}

test('S7 one recovery writer continues after two successive process deaths without new guards',async()=>{
  const {f,args,observation}=await stoppedLockRecovery();
  const url=new URL('../src/operations/repository-lock-reconcile.js',import.meta.url).href;
  const die=async(request,phase)=>{
    const code=`import {finishRepositoryLockRecovery} from ${JSON.stringify(url)};
      await finishRepositoryLockRecovery({...JSON.parse(process.argv[1]),ioBoundary:async stage=>{
        if(stage===${JSON.stringify(phase)})process.exit(0);
      }});process.exit(9);`;
    await promisify(execFile)(process.execPath,['--input-type=module','--eval',code,JSON.stringify(request)],
      {windowsHide:true,timeout:60000});
  };
  const original=await readFile(path.join(observation.archive,'receipt.json'));
  await die(args,'lock-recovery-resume-guard-created');
  const input={...args,recoveryDigest:args.approval.recoveryDigest};
  const first=await inspectRepositoryLockResumption(input);
  assert.equal(first.resumptionOwnerLiveness,'local-pid-absent');
  assert.deepEqual(first.continuationApprovals,[]);
  await assert.rejects(finishRepositoryLockRecovery({...input,approval:{decision:'approve',resumptionDigest:'sha256:'+'0'.repeat(64)}}),
    e=>e.code==='repository-lock.resume-stale');
  await die({...input,approval:{decision:'approve',resumptionDigest:first.digest}},'lock-recovery-continuation-authorized');
  const authorized=await inspectRepositoryLockResumption(input);
  assert.equal(authorized.status,'resumption-in-progress');
  assert.equal(authorized.continuationApprovals.length,1);
  const retained=await readFile(path.join(authorized.directory,authorized.continuationApprovals[0].name));
  assert.equal(JSON.parse(retained).approval.resumptionDigest,first.digest);
  await die({...input,approval:{decision:'approve',resumptionDigest:authorized.digest}},'lock-recovery-gate-archived');
  const second=await inspectRepositoryLockResumption(input);
  assert.equal(second.status,'gate-archived-resumption-pending');
  assert.equal(second.continuationApprovals.length,2);
  const command=['repositories','recover-locks','--workspace',f.wrapper,'--journal',path.basename(args.journal)];
  let out='',err='';
  assert.equal(await runCli(command,{stdout:s=>{out+=s;},stderr:s=>{err+=s;}}),0,err);
  assert.equal(JSON.parse(out).action,'continue');
  const previewFile=path.join(path.dirname(f.wrapper),'continue-preview.json');await writeFile(previewFile,out);
  out='';err='';
  assert.equal(await runCli([...command,'--apply','--preview',previewFile],{stdout:s=>{out+=s;},stderr:s=>{err+=s;}}),0,err);
  const result=JSON.parse(out);
  assert.equal(result.repositoryEffectsPerformed,false);
  assert.deepEqual(await readFile(path.join(observation.archive,'receipt.json')),original);
  const complete=await inspectRepositoryLockResumption(input);
  assert.equal(complete.status,'resumption-complete');assert.equal(complete.continuationApprovals.length,3);
  assert.deepEqual(await readFile(path.join(complete.directory,complete.continuationApprovals[0].name)),retained);
  const before=await readdir(complete.directory);
  await finishRepositoryLockRecovery({...input,approval:{decision:'approve',resumptionDigest:complete.digest}});
  assert.deepEqual(await readdir(complete.directory),before);
  const lock=await acquireWorkspaceLock(f.wrapper);await lock.release();
  assert.equal((await verifyRepositoryCompletion(args)).status,'repository-effects-verified');
});

test('S7 public lock recovery reconstructs inputs and resumes stopped recovery',async()=>{
  const {f,args}=await stoppedLockRecovery();
  const journal=path.basename(args.journal);
  const invoke=async flags=>{let out='',err='';const code=await runCli(flags,{stdout:s=>{out+=s;},stderr:s=>{err+=s;}});return {code,out,err};};
  const command=['repositories','recover-locks','--workspace',f.wrapper,'--journal',journal];
  const observation=await invoke(command);assert.equal(observation.code,0,observation.err);
  const preview=JSON.parse(observation.out);assert.equal(preview.action,'resume');
  const filename=path.join(path.dirname(f.wrapper),'lock-preview.json');await writeFile(filename,observation.out);
  const bad=await invoke([...command.slice(0,-1),'00000000-0000-0000-0000-000000000000','--apply','--preview',filename]);
  assert.notEqual(bad.code,0);
  const result=await invoke([...command,'--apply','--preview',filename]);assert.equal(result.code,0,result.err);
  assert.equal(JSON.parse(result.out).repositoryEffectsPerformed,false);
  assert.equal((await verifyRepositoryCompletion(args)).status,'repository-effects-verified');
  const lock=await acquireWorkspaceLock(f.wrapper);await lock.release();
});

test('S7 public lock recovery retires stopped owners but rejects stale subject',async()=>{
  const {f,request}=await stoppedFinalization('finalization-marker-moved');
  const command=['repositories','recover-locks','--workspace',f.wrapper,'--journal',path.basename(request.journal)];
  const invoke=async args=>{let out='',err='';const code=await runCli(args,{stdout:s=>{out+=s;},stderr:s=>{err+=s;}});return {code,out,err};};
  const observed=await invoke(command);assert.equal(observed.code,0,observed.err);
  const preview=JSON.parse(observed.out);assert.equal(preview.action,'retire');
  const file=path.join(path.dirname(f.wrapper),'retire-preview.json');await writeFile(file,observed.out);
  const result=await invoke([...command,'--apply','--preview',file]);assert.equal(result.code,0,result.err);
  const repeated=await invoke([...command,'--apply','--preview',file]);assert.notEqual(repeated.code,0);
  assert.equal((await verifyRepositoryCompletion(request)).status,'repository-effects-verified');
});

for(const phase of ['finalization-marker-moved','finalization-receipt-verified']) {
test('S7 recovery completion resumes stopped owner after '+phase,async()=>{
  const {f,args,observation}=await stoppedLockRecovery(phase);
  const oldOwner=await readFile(path.join(observation.gate,'owner.json'));
  const receipt=await readFile(path.join(observation.archive,'receipt.json'));
  const result=await finishRepositoryLockRecovery({...args,ioBoundary:async stage=>{
    if(stage!=='lock-recovery-resume-guard-created')return;
    await assert.rejects(acquireWorkspaceLock(f.wrapper),e=>e.code==='lock.repository-pending');
    await assert.rejects(acquireBootstrapLock(f.wrapper),e=>e.code==='bootstrap-lock.recovery-pending');
    await assert.rejects(finishRepositoryLockRecovery(args),e=>e.code==='recovery-lease.busy');
  }});
  assert.equal(result.pipelineActivated,false);assert.equal(result.repositoryEffectsPerformed,false);
  assert.deepEqual(await readFile(path.join(result.archive,'recovery-gate/owner.json')),oldOwner);
  assert.deepEqual(await readFile(path.join(result.archive,'receipt.json')),receipt);
  assert.ok(await readFile(path.join(result.resumption,'approval.json')));
  const verificationArgs={...args,recoveryDigest:args.approval.recoveryDigest};
  const verified=await inspectRepositoryLockResumption(verificationArgs);
  assert.equal(verified.status,'resumption-complete');assert.equal(verified.executionAuthorized,false);
  assert.deepEqual(await inspectRepositoryLockResumption(verificationArgs),verified);
  await assert.rejects(inspectRepositoryLockResumption({...verificationArgs,recoveryDigest:'sha256:'+'0'.repeat(64)}),
    e=>e.code==='repository-lock.resumption-approval');
  if(phase==='finalization-receipt-verified')
    await resumeRepositoryFinalization({...args,approval:{decision:'approve',reconciliationDigest:args.reconciliationDigest}});
  const lock=await acquireWorkspaceLock(f.wrapper);await lock.release();
  assert.equal((await verifyRepositoryCompletion(args)).status,'repository-effects-verified');
});
}

test('S7 recovery completion rejects stale approval without secondary guard',async()=>{
  const {f,args}=await stoppedLockRecovery();
  await assert.rejects(finishRepositoryLockRecovery({...args,approval:{decision:'approve',recoveryDigest:'sha256:'+'0'.repeat(64)}}),
    e=>e.code==='repository-lock.resume-stale');
  await assert.rejects(readdir(bootstrapLockDirectory(f.wrapper)+'.recovery-resume'),e=>e.code==='ENOENT');
});

for(const [phase,index,expectedMoves] of [
  ['lock-recovery-intent-persisted',null,[1,0]],
  ['lock-recovery-lock-archived',1,[0]],
  ['lock-recovery-lock-archived',0,[]]]) {
test('S7 recovery continuation performs only remaining actions after '+phase+'/'+index,async()=>{
  const {f,args,observation}=await stoppedLockRecovery('finalization-marker-moved',phase,index);
  const owners=await Promise.all(observation.locations.map(l=>readFile(path.join(l.observation.directory,'owner.json'))));
  const request=await readFile(path.join(observation.archive,'request.json'));
  const moves=[];let receipts=0;
  const result=await finishRepositoryLockRecovery({...args,ioBoundary:async(stage,detail)=>{
    if(stage==='lock-recovery-resume-lock-archived')moves.push(detail.index);
    if(stage==='lock-recovery-resume-receipt-persisted')receipts++;
  }});
  assert.deepEqual(moves,expectedMoves);assert.equal(receipts,1);
  assert.deepEqual(await readFile(path.join(result.archive,'request.json')),request);
  assert.deepEqual(await readFile(path.join(result.archive,'bootstrap-lock/owner.json')),owners[0]);
  assert.deepEqual(await readFile(path.join(result.archive,'workspace-lock/owner.json')),owners[1]);
  assert.equal((await verifyRepositoryCompletion(args)).status,'repository-effects-verified');
  const lock=await acquireWorkspaceLock(f.wrapper);await lock.release();
});
}

test('S7 recovery continuation refuses repository drift between remaining moves',async()=>{
  const {f,args,observation}=await stoppedLockRecovery('finalization-marker-moved','lock-recovery-intent-persisted');
  await assert.rejects(finishRepositoryLockRecovery({...args,ioBoundary:async(stage,detail)=>{
    if(stage==='lock-recovery-resume-lock-archived' && detail.index===1)
      await writeFile(path.join(f.wrapper,'project/foreign.txt'),'preserve');
  }}),e=>e.code==='repository-reconcile.completion-drift');
  assert.ok(await readFile(path.join(observation.archive,'workspace-lock/owner.json')));
  assert.ok(await readFile(path.join(bootstrapLockDirectory(f.wrapper),'owner.json')));
  await assert.rejects(readFile(path.join(observation.archive,'receipt.json')),e=>e.code==='ENOENT');
  await assert.rejects(acquireWorkspaceLock(f.wrapper),e=>e.code==='lock.repository-pending');
});

for(const [stopPhase,expected] of [
  ['lock-recovery-resume-guard-created','resumption-in-progress'],
  ['lock-recovery-gate-archived','gate-archived-resumption-pending'],
  ['lock-recovery-resumption-archived','resumption-complete']]) {
test('S7 recovery completion interruption reconstructs '+expected,async()=>{
  const {f,args,observation}=await stoppedLockRecovery();
  await assert.rejects(finishRepositoryLockRecovery({...args,ioBoundary:async stage=>{
    if(stage===stopPhase)throw Error('stop-after-gate');
  }}),/stop-after-gate/);
  const verificationArgs={...args,recoveryDigest:args.approval.recoveryDigest};
  const before=await readdir(observation.archive,{recursive:true});
  const state=await inspectRepositoryLockResumption(verificationArgs);
  assert.equal(state.status,expected);assert.equal(state.canResume,false);
  assert.deepEqual(await inspectRepositoryLockResumption(verificationArgs),state);
  assert.deepEqual(await readdir(observation.archive,{recursive:true}),before);
  if(expected==='resumption-complete') {
    const lock=await acquireWorkspaceLock(f.wrapper);await lock.release();
  } else {
    await assert.rejects(acquireWorkspaceLock(f.wrapper),e=>e.code==='lock.repository-pending');
    await assert.rejects(acquireBootstrapLock(f.wrapper),e=>e.code==='bootstrap-lock.recovery-pending');
  }
  await writeFile(path.join(state.directory,'approval.json'),'{}');
  await assert.rejects(inspectRepositoryLockResumption(verificationArgs),e=>e.code==='repository-lock.resumption-approval');
});
}

test('S7 public finalization uses retained inputs without a source or user preview',async()=>{
  const f=await fixture();await applyRepositoryOperations(f);
  const invoke=async args=>{let out='',err='';const code=await runCli(args,{stdout:s=>{out+=s;},stderr:s=>{err+=s;}});return {code,out,err};};
  const status=await invoke(['repositories','status','--workspace',f.wrapper]);
  assert.equal(status.code,0,status.err);const preview=JSON.parse(status.out);
  assert.equal(preview.action,'finalize');assert.equal(preview.executionAuthorized,false);
  const file=path.join(path.dirname(f.wrapper),'recovery-preview.json');await writeFile(file,status.out);
  const result=await invoke(['repositories','finalize','--workspace',f.wrapper,'--apply','--preview',file]);
  assert.equal(result.code,0,result.err);assert.equal(JSON.parse(result.out).pipelineActivated,false);
  const after=await invoke(['repositories','status','--workspace',f.wrapper]);
  assert.equal(JSON.parse(after.out).status,'no-pending-marker');
});

test('S7 finalization resumes exact durable receipt without repeating repository effects',async()=>{
  const {f,request,files}=await interruptedFinalization();
  const receipt=await readFile(files.receiptFile),marker=await readFile(path.join(f.wrapper,'.pipeline/repository-operation.json'));
  await assert.rejects(finalizeRepositoryOperations(request),e=>e.code==='repository-reconcile.finalization-exists');
  const result=await resumeRepositoryFinalization(request);
  assert.equal(result.status,'repository-effects-verified');assert.equal(result.pipelineActivated,false);
  assert.deepEqual(await readFile(result.receiptFile),receipt);
  assert.deepEqual(await readFile(result.historyFile),marker);
  assert.deepEqual(await readdir(path.join(f.wrapper,'project')),[]);
});

test('S7 finalization resume preserves changed receipt and leaves marker pending',async()=>{
  const {f,request,files}=await interruptedFinalization();
  const value=JSON.parse(await readFile(files.receiptFile,'utf8'));value.pipelineActivated=true;
  const changed=JSON.stringify(value);await writeFile(files.receiptFile,changed);
  await assert.rejects(resumeRepositoryFinalization(request),e=>e.code==='repository-reconcile.receipt-drift');
  assert.equal(await readFile(files.receiptFile,'utf8'),changed);
  assert.ok(await readFile(path.join(f.wrapper,'.pipeline/repository-operation.json')));
  await assert.rejects(readFile(files.historyFile),e=>e.code==='ENOENT');
});

test('S7 finalization resume rejects changed repository even with retained receipt',async()=>{
  const {f,request,files}=await interruptedFinalization();
  await writeFile(path.join(f.wrapper,'project','foreign.txt'),'keep');
  await assert.rejects(resumeRepositoryFinalization(request),e=>e.code==='repository-reconcile.approval-drift');
  assert.equal(await readFile(path.join(f.wrapper,'project','foreign.txt'),'utf8'),'keep');
  await assert.rejects(readFile(files.historyFile),e=>e.code==='ENOENT');
});

test('S7 finalization rechecks receipt bytes immediately before pending-marker handoff',async()=>{
  const {f,request,files}=await interruptedFinalization();
  await assert.rejects(resumeRepositoryFinalization({...request,ioBoundary:async()=>{
    await writeFile(files.receiptFile,'{}');
  }}),e=>e.code==='repository-reconcile.receipt-drift');
  assert.ok(await readFile(path.join(f.wrapper,'.pipeline/repository-operation.json')));
  await assert.rejects(readFile(files.historyFile),e=>e.code==='ENOENT');
});
test('S7 init binds main/no templates and initializes an unborn clean repository',async()=>{
  const f=await fixture(false,'init');
  assert.deepEqual(f.preview.operations[0].initialization,{initialBranch:'main',templates:'disabled'});
  await applyRepositoryOperations(f);
  assert.equal(await readFile(path.join(f.wrapper,'project/.git/HEAD'),'utf8'),'ref: refs/heads/main\n');
  assert.ok(!(await readdir(path.join(f.wrapper,'project/.git'))).includes('hooks'));
  assert.equal((await inspectRepositoryReconciliation(f.wrapper,f.previewText,f.preview.digest)).canFinalize,true);
});
test('S7 interrupted init preserves partial directory and cannot be finalized',async()=>{
  const f=await fixture(false,'init');
  await assert.rejects(applyRepositoryOperations({...f,ioBoundary:async phase=>{if(phase==='init-directory-created')throw Error('crash');}}),e=>e.code==='repository-apply.io');
  assert.deepEqual(await readdir(path.join(f.wrapper,'project')),[]);
  const state=await inspectRepositoryReconciliation(f.wrapper,f.previewText,f.preview.digest);
  assert.equal(state.canFinalize,false);assert.equal(state.observations[0].claimedStatus,'uncertain');
});
test('S7 clone materializes pinned committed bytes without origin or dirty source data',async()=>{
  const f=await fixture(false,'clone');await applyRepositoryOperations(f);
  assert.equal(await readFile(path.join(f.wrapper,'project/game.txt'),'utf8'),'committed game');
  assert.equal((await runGit(path.join(f.wrapper,'project'),['rev-parse','HEAD'])).bytes.toString().trim(),f.preview.operations[0].binding.commit);
  assert.equal((await runGit(path.join(f.wrapper,'project'),['remote'])).bytes.length,0);
  assert.equal(await readFile(path.join(f.preview.operations[0].binding.resolvedSource,'game.txt'),'utf8'),'dirty source must not be cloned');
  assert.equal((await inspectRepositoryReconciliation(f.wrapper,f.previewText,f.preview.digest)).canFinalize,true);
});
test('S7 clone interruption after fetch keeps partial target and blocks completion',async()=>{
  const f=await fixture(false,'clone');
  await assert.rejects(applyRepositoryOperations({...f,ioBoundary:async phase=>{if(phase==='clone-fetched')throw Error('crash');}}),e=>e.code==='repository-apply.io');
  assert.ok(await readFile(path.join(f.wrapper,'project/.git/HEAD')));
  const state=await inspectRepositoryReconciliation(f.wrapper,f.previewText,f.preview.digest);
  assert.equal(state.canFinalize,false);assert.equal(state.observations[0].claimedStatus,'uncertain');
});
