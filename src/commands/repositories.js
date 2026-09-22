import path from 'node:path';
import {lstat} from 'node:fs/promises';
import {absoluteRoot,resolveChild} from '../workspace/paths.js';
import {readRecord} from '../operations/state.js';
import {readRepositoryInputs} from '../operations/repository-inputs.js';
import {contractDigest} from '../contracts/semantic.js';
import {fail} from '../contracts/parse.js';
import {bootstrapLockDirectory} from '../operations/bootstrap-lock.js';
import {withRecoveryLease,assertRecoveryLeaseHeld} from '../operations/recovery-lease.js';
import {inspectRepositoryReconciliation,finalizeRepositoryOperations,resumeRepositoryFinalization} from '../operations/repository-reconcile.js';

async function exists(p){try{await lstat(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
export async function prepareRepositoryFinalization(wrapper) {
  wrapper=absoluteRoot(wrapper);
  const markerPath=resolveChild(wrapper,'.pipeline/repository-operation.json');
  const bootstrap=bootstrapLockDirectory(wrapper),blockers=[];
  for(const p of [bootstrap,bootstrap+'.recovery',bootstrap+'.recovery-resume',resolveChild(wrapper,'.pipeline/lock')])
    if(await exists(p))blockers.push({code:'repositories.recovery-lock-present',path:p});
  if(!await exists(markerPath))return {status:'no-pending-marker',wrapper,blockers,executionAuthorized:false,
    completionVerified:false,pipelineActivated:false};
  const marker=await readRecord(markerPath);
  const input=await readRepositoryInputs(wrapper,marker.value.journal,marker.value.previewDigest);
  const checked=await inspectRepositoryReconciliation(wrapper,input.previewText,input.previewDigest);
  if(!checked.canFinalize)blockers.push({code:'repositories.effects-unresolved'});
  const receiptPath=resolveChild(wrapper,'.pipeline/repository-completions/'+path.basename(checked.journal)+'.json');
  const receipt=await exists(receiptPath)?await readRecord(receiptPath):null;
  if(receipt && contractDigest(receipt.value)!==contractDigest({schemaVersion:1,status:'repository-effects-verified',
    reconciliation:checked,pipelineActivated:false}))fail('repositories.recovery-receipt');
  if((await readRecord(markerPath)).digest!==marker.digest ||
    (await readRecord(input.path)).digest!==input.recordDigest)fail('repositories.recovery-drift');
  const body={schemaVersion:1,kind:'repository-finalization-preview',wrapper,
    status:blockers.length?'blocked':'review-only',blockers,action:receipt?'resume-finalization':'finalize',
    inputDigest:input.recordDigest,markerDigest:marker.digest,reconciliation:checked,
    receiptDigest:receipt?.digest??null,executionAuthorized:false,pipelineActivated:false};
  return {...body,digest:contractDigest(body)};
}
export async function applyRepositoryFinalization(wrapper,preview) {
  wrapper=absoluteRoot(wrapper);
  const {digest,...body}=preview??{};
  if(body.kind!=='repository-finalization-preview' || body.wrapper!==wrapper ||
    body.status!=='review-only' || contractDigest(body)!==digest)fail('repositories.recovery-approval');
  return withRecoveryLease(wrapper,async lease=>{
    assertRecoveryLeaseHeld(lease);
    const fresh=await prepareRepositoryFinalization(wrapper);
    if(contractDigest(fresh)!==contractDigest(preview))fail('repositories.recovery-stale');
    const input=await readRepositoryInputs(wrapper,fresh.reconciliation.journal,fresh.reconciliation.previewDigest);
    const run=fresh.action==='resume-finalization'?resumeRepositoryFinalization:finalizeRepositoryOperations;
    return run({wrapper,lease,previewText:input.previewText,previewDigest:input.previewDigest,
      approval:{decision:'approve',reconciliationDigest:fresh.reconciliation.digest}});
  });
}
export async function runRepositoryRecovery(command,stdout) {
  if(command.apply) {
    const preview=(await readRecord(command.previewFile)).value;
    const result=await applyRepositoryFinalization(command.workspace,preview);
    await stdout(JSON.stringify(result)+'\n');return 0;
  }
  const result=await prepareRepositoryFinalization(command.workspace);
  await stdout(JSON.stringify(result)+'\n');
  return result.status==='review-only' || (result.status==='no-pending-marker' && !result.blockers.length)?0:1;
}
