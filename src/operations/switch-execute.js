import {readSwitchRecovery} from './switch-recovery-store.js';
import {validateSwitchRecord} from './switch-records.js';
import {inspectPendingSwitch} from './switch-inspect.js';
import {openSwitchJournal} from './switch-journal-store.js';
import {assertLockHeld} from './lock.js';
import {writeCheckedFile,deleteCheckedFile} from './apply.js';
import {observeTargets,readState,readRecord} from './state.js';
import {resolveChild} from '../workspace/paths.js';
import {sha256} from '../source/inventory.js';
import {fail} from '../contracts/parse.js';
import {contractDigest} from '../contracts/semantic.js';

// Execute exactly the explicitly selected current phase. No activation, automatic
// phase chaining or uncertain-operation continuation. Public routing is absent.
export async function executeSwitchPhase(lock,recoveryPath,recoveryHash,approval,phaseName,{boundary=async()=>{}}={}) {
  approval=structuredClone(approval);
  await assertLockHeld(lock);
  const evidence=await readSwitchRecovery(lock.workspace,recoveryPath),record=evidence.record;
  if(evidence.fileHash!==recoveryHash)fail('switch-execute.recovery');
  validateSwitchRecord(record.prepared,approval,record.previous);
  const phase=record.prepared.preview.phases.find(p=>p.name===phaseName);
  if(!phase)fail('switch-execute.phase');
  if(phase.preview.plan.targets.some(t=>!['delete','create','replace','edit-fields'].includes(t.action)))fail('switch-execute.action');
  async function inspect(allowIntent=false) {
    await assertLockHeld(lock);
    const current=await inspectPendingSwitch(lock.workspace,recoveryPath);
    if(current.recoveryHash!==recoveryHash || current.conflicts.length || current.phase!==phaseName ||
        (!allowIntent && current.journalStatus!=='open'))fail('switch-execute.state');
    return current;
  }
  const initial=await inspect();
  const currentState=await readState(resolveChild(lock.workspace,'.pipeline/state.json'));
  if(contractDigest(currentState.value)!==contractDigest({...record.previous,status:'needs-reconciliation',pending:record.digest,runtime:'not-run'}))fail('switch-execute.state');
  const stateHash=currentState.digest;
  const expected=new Map(initial.targets.map(t=>[t.path,t.hash]));
  async function guard() {
    await assertLockHeld(lock);
    if((await readState(resolveChild(lock.workspace,'.pipeline/state.json'))).digest!==stateHash ||
        (await readRecord(resolveChild(lock.workspace,recoveryPath))).digest!==recoveryHash)fail('switch-execute.state');
    const observations=await observeTargets(lock.workspace,[...expected.keys()]);
    if(observations.some(o=>(o.bytes===null?null:sha256(o.bytes))!==expected.get(o.path)))fail('switch-execute.before');
  }
  const journal=await openSwitchJournal(lock,record.prepared.preview,record.previous,record.journal,evidence.journal.lastFileHash);
  const outputs=new Map(phase.preview.outputs.map(o=>[o.path,Buffer.from(o.bytes,'base64')]));
  for(const target of phase.preview.plan.targets.slice(evidence.journal.nextIndex)) {
    await guard();
    await journal.intent(phaseName,target.id);
    await boundary('intent',{phase:phaseName,path:target.path});
    await guard();
    if(expected.get(target.path)!==target.beforeHash)fail('switch-execute.before');
    if(target.action==='delete')await deleteCheckedFile(lock,target.path,target.beforeHash,async()=>{});
    else if(['create','replace','edit-fields'].includes(target.action))await writeCheckedFile(lock,target.path,target.beforeHash,outputs.get(target.path));
    else fail('switch-execute.action');
    await boundary('target-written',{phase:phaseName,path:target.path});
    expected.set(target.path,target.desiredHash);
    await guard();
    const [observed]=await observeTargets(lock.workspace,[target.path]);
    if((observed.bytes===null?null:sha256(observed.bytes))!==target.desiredHash)fail('switch-execute.readback');
    await journal.outcome(phaseName,target.id,'completed',target.desiredHash);
  }
  await inspect();
  const fresh=await readSwitchRecovery(lock.workspace,recoveryPath);
  await journal.phaseChecked(phaseName,fresh.journal.expectedProjectionDigest);
  const result=await inspectPendingSwitch(lock.workspace,recoveryPath);
  if(result.conflicts.length)fail('switch-execute.final-drift');
  return {status:'needs-reconciliation',completedPhase:phaseName,nextPhase:result.phase,
    journalCompleted:result.journalCompleted,recoveryPath,activationSupported:false,runtime:'not-run'};
}
