import path from 'node:path';
import {lstat} from 'node:fs/promises';
import {absoluteRoot,resolveChild} from '../workspace/paths.js';
import {fail} from '../contracts/parse.js';
import {contractDigest} from '../contracts/semantic.js';
import {readRecord} from '../operations/state.js';
import {readRepositoryInputs} from '../operations/repository-inputs.js';
import {bootstrapLockDirectory} from '../operations/bootstrap-lock.js';
import {inspectRepositoryReconciliation,verifyRepositoryCompletion} from '../operations/repository-reconcile.js';
import {inspectRepositoryLocks,inspectRepositoryLockRecovery,inspectRepositoryLockResumption,
  recoverRepositoryLocks,finishRepositoryLockRecovery} from '../operations/repository-lock-reconcile.js';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
async function exists(filename){try{await lstat(filename);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}

// Explicit journal selection: never guess the newest operation from timestamps,
// UUID ordering or equal desired-state hashes. All recovery uses retained inputs.
async function prepare(wrapper,journalId) {
  wrapper=absoluteRoot(wrapper);if(!uuid.test(journalId??''))fail('repositories.journal-required');
  const journal='.pipeline/repository-journals/'+journalId;
  const raw=await readRecord(resolveChild(wrapper,'.pipeline/repository-inputs/'+journalId+'.json'));
  const input=await readRepositoryInputs(wrapper,journal,raw.value?.preview?.digest);
  const args={wrapper,journal,previewText:input.previewText,previewDigest:input.previewDigest};
  if(await exists(resolveChild(wrapper,'.pipeline/repository-operation.json'))) {
    const subject=await inspectRepositoryReconciliation(wrapper,input.previewText,input.previewDigest);
    if(subject.journal!==journal || !subject.canFinalize)fail('repositories.effects-unresolved');
    args.reconciliationDigest=subject.digest;
  } else {
    const receipt=await readRecord(resolveChild(wrapper,'.pipeline/repository-completions/'+journalId+'.json'));
    args.reconciliationDigest=receipt.value?.reconciliation?.digest;
    await verifyRepositoryCompletion(args);
  }
  const base=bootstrapLockDirectory(wrapper);let action,observation;
  if(await exists(base+'.recovery-resume')) {
    const approval=await readRecord(path.join(base+'.recovery-resume','approval.json'));
    args.lockDigest=approval.value?.observation?.lockDigest;
    args.recoveryDigest=approval.value?.observation?.digest;
    action='continue';observation=await inspectRepositoryLockResumption(args);
  } else if(await exists(base+'.recovery')) {
    const owner=await readRecord(path.join(base+'.recovery','owner.json'));
    args.lockDigest=owner.value?.lockDigest;
    action='resume';observation=await inspectRepositoryLockRecovery(args);
  } else {
    action='retire';observation=await inspectRepositoryLocks(args);
  }
  const stopped=action==='retire'?observation.ownerLiveness==='local-pid-absent':
    action==='resume'?observation.recoveryOwnerLiveness==='local-pid-absent' &&
      observation.locations.every(l=>l.ownerLiveness==='local-pid-absent'):
      observation.resumptionOwnerLiveness==='local-pid-absent' &&
      observation.current.recoveryOwnerLiveness==='local-pid-absent' &&
      observation.current.locations.every(l=>l.ownerLiveness==='local-pid-absent');
  if((await readRecord(input.path)).digest!==input.recordDigest)fail('repositories.recovery-drift');
  const body={schemaVersion:1,kind:'repository-lock-recovery-preview',wrapper,journalId,action,
    inputDigest:input.recordDigest,observation,status:stopped?'review-only':'blocked',
    blockers:stopped?[]:[{code:'repositories.recovery-owner-unconfirmed'}],executionAuthorized:false,pipelineActivated:false};
  return {preview:{...body,digest:contractDigest(body)},args};
}
export async function prepareRepositoryLockRecovery(wrapper,journalId){return (await prepare(wrapper,journalId)).preview;}

export async function applyRepositoryLockRecovery(wrapper,journalId,preview) {
  wrapper=absoluteRoot(wrapper);const {digest,...body}=preview??{};
  if(body.kind!=='repository-lock-recovery-preview' || body.wrapper!==wrapper || body.journalId!==journalId ||
    body.status!=='review-only' || contractDigest(body)!==digest)fail('repositories.recovery-approval');
  const fresh=await prepare(wrapper,journalId);
  if(contractDigest(fresh.preview)!==contractDigest(preview))fail('repositories.recovery-stale');
  // Native writers acquire the kernel lease and independently recompute the exact
  // approved observation before mutation. Do not acquire a competing nested lease.
  const key={retire:'lockDigest',resume:'recoveryDigest',continue:'resumptionDigest'}[body.action];
  const run=body.action==='retire'?recoverRepositoryLocks:finishRepositoryLockRecovery;
  return run({...fresh.args,approval:{decision:'approve',[key]:fresh.preview.observation.digest}});
}

export async function runRepositoryLockRecovery(command,stdout) {
  const result=command.apply?await applyRepositoryLockRecovery(command.workspace,command.journalId,
    (await readRecord(command.previewFile)).value):await prepareRepositoryLockRecovery(command.workspace,command.journalId);
  await stdout(JSON.stringify(result)+'\n');return result.status==='blocked'?1:0;
}
