import {readSwitchContinuationRecovery} from './switch-continuation-recovery.js';
import {openSwitchContinuationJournal} from './switch-continuation-store.js';
import {assertLockHeld} from './lock.js';
import {writeCheckedFile,deleteCheckedFile} from './apply.js';
import {readState,readRecord,observeTargets} from './state.js';
import {resolveChild} from '../workspace/paths.js';
import {contractDigest,validateState} from '../contracts/semantic.js';
import {fail} from '../contracts/parse.js';
import {sha256} from '../source/inventory.js';

const hashes=observations=>observations.map(o=>({path:o.path,hash:o.bytes===null?null:sha256(o.bytes)}));
async function context(workspace,recoveryPath) {
  const evidence=await readSwitchContinuationRecovery(workspace,recoveryPath);
  const parent=evidence.root;
  return {evidence,parent};
}
function pendingState(evidence,parent) {
  return {...parent.record.previous,status:'needs-reconciliation',pending:evidence.record.digest,runtime:'not-run'};
}
function readyState(evidence,parent,recoveryPath) {
  if(evidence.journal.status!=='completed' || evidence.journal.verifiedPhases!==evidence.record.preview.remaining.length)
    fail('switch-continuation-runtime.incomplete');
  const state={...parent.record.previous,status:'ready',pending:null,runtime:'not-run',
    active:parent.record.prepared.preview.phases[1].preview.plan.desired,
    activation:{recovery:recoveryPath,recoveryHash:evidence.fileHash,
      journalHead:{sequence:evidence.journal.sequence,hash:evidence.journal.lastFileHash}}};
  validateState(state);return state;
}
function projection(evidence) {
  const p=evidence.record.preview,j=evidence.journal,map=new Map(p.observations.map(o=>[o.path,o.hash]));
  const stopped=!j.pending && ['failed','uncertain'].includes(j.status);
  let uncertain=null;
  for(let i=0;i<p.remaining.length;i++) {
    const phase=p.remaining[i],count=i<j.verifiedPhases?phase.operations.length:
      i===j.verifiedPhases?j.nextIndex-(stopped?1:0):0;
    for(let n=0;n<count;n++)map.set(phase.operations[n].path,phase.operations[n].desiredHash);
    if(i===j.verifiedPhases && j.status==='uncertain')uncertain={...phase.operations[j.pending?j.nextIndex:j.nextIndex-1],phase:phase.phase};
  }
  return {map,uncertain};
}

export async function inspectSwitchContinuation(workspace,recoveryPath,{active=false}={}) {
  const filename=resolveChild(workspace,'.pipeline/state.json'),before=await readState(filename);
  const {evidence,parent}=await context(workspace,recoveryPath);
  const expected=active?readyState(evidence,parent,recoveryPath):pendingState(evidence,parent);
  if(contractDigest(before.value)!==contractDigest(expected))fail('switch-continuation-runtime.selection');
  const {map,uncertain}=projection(evidence);
  const observations=hashes(await observeTargets(workspace,[...map.keys()]));
  const conflicts=observations.filter(o=>uncertain?.path===o.path?
    o.hash!==uncertain.beforeHash && o.hash!==uncertain.desiredHash:o.hash!==map.get(o.path)).map(o=>o.path);
  const after=await readSwitchContinuationRecovery(workspace,recoveryPath);
  if(after.fileHash!==evidence.fileHash || contractDigest(after.journal)!==contractDigest(evidence.journal) ||
      (await readState(filename)).digest!==before.digest ||
      contractDigest(hashes(await observeTargets(workspace,[...map.keys()])))!==contractDigest(observations))
    fail('switch-continuation-runtime.drift');
  if(active && conflicts.length)fail('switch-continuation-runtime.target-drift');
  return {status:active?'applied':'needs-reconciliation',recoveryHash:evidence.fileHash,recoveryPath,
    stateFileHash:before.digest,observations,conflicts,uncertain,phase:evidence.journal.phase,
    journalStatus:evidence.journal.status,journalCompleted:evidence.journal.status==='completed',runtime:'not-run'};
}

export async function executeSwitchContinuationPhase(lock,recoveryPath,recoveryHash,approval,phaseName,{boundary=async()=>{}}={}) {
  approval=structuredClone(approval);await assertLockHeld(lock);
  const {evidence,parent}=await context(lock.workspace,recoveryPath),record=evidence.record;
  if(evidence.fileHash!==recoveryHash || contractDigest(record.approval)!==contractDigest(approval))fail('switch-continuation-runtime.approval');
  const phase=record.preview.remaining.find(p=>p.phase===phaseName);
  const original=parent.record.prepared.preview.phases.find(p=>p.name===phaseName);
  if(!phase || !original)fail('switch-continuation-runtime.phase');
  const initial=await inspectSwitchContinuation(lock.workspace,recoveryPath);
  if(initial.conflicts.length || initial.uncertain || initial.journalStatus!=='open' || initial.phase!==phaseName)
    fail('switch-continuation-runtime.state');
  const expected=new Map(initial.observations.map(o=>[o.path,o.hash]));
  async function guard() {
    await assertLockHeld(lock);
    if((await readState(resolveChild(lock.workspace,'.pipeline/state.json'))).digest!==initial.stateFileHash ||
        (await readRecord(resolveChild(lock.workspace,recoveryPath))).digest!==recoveryHash ||
        (await readRecord(resolveChild(lock.workspace,record.preview.recoveryPath))).digest!==record.preview.recoveryHash)
      fail('switch-continuation-runtime.state');
    for(const ancestor of evidence.ancestors) {
      if((await readRecord(resolveChild(lock.workspace,ancestor.relative))).digest!==ancestor.fileHash)
        fail('switch-continuation-runtime.state');
    }
    if(hashes(await observeTargets(lock.workspace,[...expected.keys()])).some(o=>o.hash!==expected.get(o.path)))
      fail('switch-continuation-runtime.target-drift');
  }
  const journal=await openSwitchContinuationJournal(lock,record.preview,record.journal,evidence.journal.lastFileHash);
  for(const op of phase.operations.slice(evidence.journal.nextIndex)) {
    await guard();
    if(op.resolution==='verify-desired') {
      if(expected.get(op.path)!==op.desiredHash)fail('switch-continuation-runtime.target-drift');
      await boundary('readback',{phase:phaseName,path:op.path});await guard();
      await journal.readback(phaseName,op.operationId,'completed',op.desiredHash);
    }else {
      const target=original.preview.plan.targets.find(t=>t.id===op.operationId);
      if(!target || !['delete','create','replace','edit-fields'].includes(target.action))fail('switch-continuation-runtime.action');
      await journal.intent(phaseName,op.operationId);await boundary('intent',{phase:phaseName,path:op.path});await guard();
      if(expected.get(op.path)!==op.beforeHash)fail('switch-continuation-runtime.target-drift');
      if(target.action==='delete')await deleteCheckedFile(lock,op.path,op.beforeHash,async()=>{});
      else {
        const output=original.preview.outputs.find(o=>o.path===op.path);
        if(!output)fail('switch-continuation-runtime.output');
        await writeCheckedFile(lock,op.path,op.beforeHash,Buffer.from(output.bytes,'base64'));
      }
      await boundary('target-written',{phase:phaseName,path:op.path});expected.set(op.path,op.desiredHash);await guard();
      await journal.outcome(phaseName,op.operationId,'completed',op.desiredHash);
    }
  }
  await guard();
  const fresh=await readSwitchContinuationRecovery(lock.workspace,recoveryPath);
  await journal.phaseChecked(phaseName,fresh.journal.expectedProjectionDigest);
  const result=await inspectSwitchContinuation(lock.workspace,recoveryPath);await assertLockHeld(lock);
  if(result.conflicts.length)fail('switch-continuation-runtime.target-drift');
  return result;
}

export async function activateSwitchContinuation(lock,recoveryPath,recoveryHash,approval,{boundary=async()=>{}}={}) {
  approval=structuredClone(approval);
  async function check() {
    await assertLockHeld(lock);
    const {evidence,parent}=await context(lock.workspace,recoveryPath);
    if(evidence.fileHash!==recoveryHash || contractDigest(evidence.record.approval)!==contractDigest(approval))fail('switch-continuation-runtime.approval');
    const ready=readyState(evidence,parent,recoveryPath),inspection=await inspectSwitchContinuation(lock.workspace,recoveryPath);
    if(inspection.conflicts.length || inspection.uncertain)fail('switch-continuation-runtime.target-drift');
    return {ready,stateHash:inspection.stateFileHash};
  }
  const checked=await check(),bytes=Buffer.from(JSON.stringify(checked.ready)+'\n');
  await writeCheckedFile(lock,'.pipeline/state.json',checked.stateHash,bytes,undefined,async(phase,detail)=>{
    await boundary(phase,detail);
    if(phase==='before-rename') {
      const fresh=await check();
      if(fresh.stateHash!==checked.stateHash || contractDigest(fresh.ready)!==contractDigest(checked.ready))fail('switch-continuation-runtime.drift');
    }
  });
  const result=await inspectSwitchContinuation(lock.workspace,recoveryPath,{active:true});await assertLockHeld(lock);return result;
}
