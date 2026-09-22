import {absoluteRoot} from '../workspace/paths.js';
import {contractDigest} from '../contracts/semantic.js';
import {fail} from '../contracts/parse.js';
import path from 'node:path';
import {hostname} from 'node:os';
import {requestShape} from '../operations/ownership.js';
import {readRecord} from '../operations/state.js';
import {inspectRepositoryBootstrap} from '../operations/repository-bootstrap-reconcile.js';
import {recoverRepositoryBootstrap} from '../operations/repository-bootstrap-recover.js';
import {inspectBootstrapRecovery,finishBootstrapRecovery} from '../operations/repository-bootstrap-continuation.js';
import {prepareBootstrapOwnerRetirement,applyBootstrapOwnerRetirement} from '../operations/bootstrap-owner-retirement.js';

function originalPreview(wrapper,original){
  const {digest,...body}=original??{};
  if(contractDigest(body)!==digest || original.wrapper!==wrapper)fail('bootstrap-recover.original-binding');
  let preview=original;
  if(original.kind==='prepared-repository-command'){
    requestShape(original,['schemaVersion','kind','command','wrapper','origin','acquired','choices','options','preview','finalization','pipelineActivated','digest'],[],'bootstrap-recover.original');
    if(original.schemaVersion!==1 || !['init','adopt'].includes(original.command) ||
      original.finalization!=='verify-and-retain-history' || original.pipelineActivated!==false ||
      original.options?.command!==original.command || original.options?.manifestPath!==original.origin?.origin?.path)
      fail('bootstrap-recover.original-binding');
    preview=original.preview;
  }
  const {digest:inner,...rest}=preview??{};
  if(preview?.kind!=='repository-preview-candidate' || preview.wrapper!==wrapper ||
    preview.executionAuthorized!==false || contractDigest(rest)!==inner)fail('bootstrap-recover.original-binding');
  return preview;
}
export async function prepareBootstrapRecovery(wrapper,original){
  wrapper=absoluteRoot(wrapper);const native=originalPreview(wrapper,original);
  const reconciliation=await inspectRepositoryBootstrap(wrapper,JSON.stringify(native),native.digest);
  let ownerStopped=false;
  if(reconciliation.recordDigests.owner){
    const owner=await readRecord(path.join(reconciliation.directory,'owner.json'));
    if(owner.digest!==reconciliation.recordDigests.owner)fail('bootstrap-recover.original-drift');
    if(owner.value?.host===hostname() && Number.isSafeInteger(owner.value.pid) && owner.value.pid>0){
      try{process.kill(owner.value.pid,0);}catch(e){ownerStopped=e.code==='ESRCH';}
    }
  }
  const ready=ownerStopped && ['before-state-observed','receipt-consistent-lock-retained'].includes(reconciliation.status);
  const body={schemaVersion:1,kind:'bootstrap-recovery-preview',wrapper,original:structuredClone(original),
    reconciliation,ownerStopped,status:ready?'review-only':'blocked',executionAuthorized:false,pipelineActivated:false};
  return {...body,digest:contractDigest(body)};
}
export async function applyBootstrapRecovery(wrapper,preview){
  wrapper=absoluteRoot(wrapper);const {digest,...body}=preview??{};
  if(body.kind!=='bootstrap-recovery-preview' || body.wrapper!==wrapper || body.status!=='review-only' ||
    contractDigest(body)!==digest)fail('bootstrap-recover.preview-approval');
  const current=await prepareBootstrapRecovery(wrapper,body.original);
  if(contractDigest(current)!==contractDigest(preview))fail('bootstrap-recover.preview-stale');
  const native=originalPreview(wrapper,current.original);
  return recoverRepositoryBootstrap({wrapper,previewText:JSON.stringify(native),previewDigest:native.digest,
    approval:{decision:'approve',reconciliationDigest:current.reconciliation.digest}});
}

export async function prepareBootstrapContinuation(wrapper,initialDigest) {
  wrapper=absoluteRoot(wrapper);
  const observation=await inspectBootstrapRecovery({wrapper,initialDigest});
  const ready=observation.status==='complete' || (observation.ownerStopped && observation.originalOwnerStopped);
  const body={schemaVersion:1,kind:'bootstrap-continuation-preview',wrapper,initialDigest:observation.initialDigest,
    observation,status:ready?'review-only':'blocked',executionAuthorized:false,pipelineActivated:false};
  return {...body,digest:contractDigest(body)};
}
export async function applyBootstrapContinuation(wrapper,initialDigest,preview) {
  wrapper=absoluteRoot(wrapper);const {digest,...body}=preview??{};
  if(body.kind!=='bootstrap-continuation-preview' || body.wrapper!==wrapper || body.status!=='review-only' ||
    (initialDigest!==undefined && initialDigest!==body.initialDigest) || contractDigest(body)!==digest)
    fail('bootstrap-continue.preview-approval');
  const current=await prepareBootstrapContinuation(wrapper,body.initialDigest);
  if(contractDigest(current)!==contractDigest(preview))fail('bootstrap-continue.preview-stale');
  // The native writer takes exclusive ownership and checks this exact fresh digest.
  return finishBootstrapRecovery({wrapper,initialDigest:body.initialDigest,
    approval:{decision:'approve',recoveryDigest:current.observation.digest}});
}
export async function runBootstrapContinuation(command,stdout) {
  if(command.action==='recover-bootstrap'){
    const result=command.apply?await applyBootstrapRecovery(command.workspace,(await readRecord(command.previewFile)).value):
      await prepareBootstrapRecovery(command.workspace,(await readRecord(command.bootstrapPreview)).value);
    await stdout(JSON.stringify(result)+'\n');return result.status==='blocked'?1:0;
  }
  if(command.action==='retire-bootstrap') {
    const result=command.apply?await applyBootstrapOwnerRetirement(command.workspace,(await readRecord(command.previewFile)).value):
      await prepareBootstrapOwnerRetirement(command.workspace);
    await stdout(JSON.stringify(result)+'\n');return result.status==='blocked'?1:0;
  }
  const result=command.apply?await applyBootstrapContinuation(command.workspace,command.initialDigest,
    (await readRecord(command.previewFile)).value):await prepareBootstrapContinuation(command.workspace,command.initialDigest);
  await stdout(JSON.stringify(result)+'\n');return result.status==='blocked'?1:0;
}
