import {readSwitchRecovery} from './switch-recovery-store.js';
import {inspectPendingSwitch} from './switch-inspect.js';
import {validateSwitchRecord} from './switch-records.js';
import {assertLockHeld} from './lock.js';
import {readState,observeTargets} from './state.js';
import {writeCheckedFile} from './apply.js';
import {resolveChild,absoluteRoot} from '../workspace/paths.js';
import {contractDigest,validateState} from '../contracts/semantic.js';
import {parse,fail} from '../contracts/parse.js';
import {sha256} from '../source/inventory.js';

function readyState(evidence,recoveryPath) {
  if(evidence.journal.status!=='completed' || evidence.journal.verifiedPhases!==2)fail('switch-activation.incomplete');
  const state={...evidence.record.previous,status:'ready',pending:null,runtime:'not-run',
    active:evidence.record.prepared.preview.phases[1].preview.plan.desired,
    activation:{recovery:recoveryPath,recoveryHash:evidence.fileHash,
      journalHead:{sequence:evidence.journal.sequence,hash:evidence.journal.lastFileHash}}};
  validateState(state);return state;
}

// Read-only confirmation of this exact completed activation. No repair/retry.
export async function inspectActivatedSwitch(workspace,recoveryPath) {
  workspace=absoluteRoot(workspace);
  const before=await readState(resolveChild(workspace,'.pipeline/state.json'));
  const evidence=await readSwitchRecovery(workspace,recoveryPath),expected=readyState(evidence,recoveryPath);
  if(contractDigest(before.value)!==contractDigest(expected))fail('switch-activation.binding');
  const results=evidence.record.prepared.preview.results;
  const observations=await observeTargets(workspace,results.map(o=>o.path));
  if(observations.some(o=>(o.bytes===null?null:sha256(o.bytes))!==results.find(r=>r.path===o.path).hash))fail('switch-activation.target-drift');
  const after=await readSwitchRecovery(workspace,recoveryPath);
  const repeated=await observeTargets(workspace,results.map(o=>o.path));
  if(after.fileHash!==evidence.fileHash || contractDigest(after.journal)!==contractDigest(evidence.journal) ||
      repeated.some(o=>(o.bytes===null?null:sha256(o.bytes))!==results.find(r=>r.path===o.path).hash) ||
      (await readState(resolveChild(workspace,'.pipeline/state.json'))).digest!==before.digest)fail('switch-activation.drift');
  return {status:'applied',recoveryPath,recoveryHash:evidence.fileHash,stateFileHash:before.digest,runtime:'not-run'};
}

// Internal final transition. Both checked phases and unchanged final bytes are
// mandatory. State activation is configuration evidence, never runtime readiness.
export async function activateSwitch(lock,recoveryPath,recoveryHash,approval,{boundary=async()=>{}}={}) {
  approval=structuredClone(approval);
  async function check() {
    await assertLockHeld(lock);
    const evidence=await readSwitchRecovery(lock.workspace,recoveryPath);
    if(evidence.fileHash!==recoveryHash)fail('switch-activation.recovery');
    validateSwitchRecord(evidence.record.prepared,approval,evidence.record.previous);
    const ready=readyState(evidence,recoveryPath),inspection=await inspectPendingSwitch(lock.workspace,recoveryPath);
    if(inspection.conflicts.length || inspection.uncertain!==null)fail('switch-activation.target-drift');
    const pending={...evidence.record.previous,status:'needs-reconciliation',pending:evidence.record.digest,runtime:'not-run'};
    const state=await readState(resolveChild(lock.workspace,'.pipeline/state.json'));
    if(contractDigest(state.value)!==contractDigest(pending))fail('switch-activation.binding');
    return {ready,stateHash:state.digest};
  }
  const checked=await check(),bytes=Buffer.from(JSON.stringify(parse(JSON.stringify(checked.ready),'json'))+'\n');
  await writeCheckedFile(lock,'.pipeline/state.json',checked.stateHash,bytes,undefined,async(phase,detail)=>{
    await boundary(phase,detail);
    if(phase==='before-rename') {
      const fresh=await check();
      if(fresh.stateHash!==checked.stateHash || contractDigest(fresh.ready)!==contractDigest(checked.ready))fail('switch-activation.drift');
    }
  });
  const result=await inspectActivatedSwitch(lock.workspace,recoveryPath);
  await assertLockHeld(lock);return result;
}
