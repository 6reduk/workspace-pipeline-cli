import path from 'node:path';
import { lstat,mkdir,open,rename } from 'node:fs/promises';
import { parse,fail,MAX_INPUT_BYTES } from '../contracts/parse.js';
import { contractDigest } from '../contracts/semantic.js';
import { absoluteRoot,inspectDirectory,resolveChild } from '../workspace/paths.js';
import { inventoryRepository } from '../workspace/repository-inventory.js';
import { readRecord } from './state.js';
import { readRepositoryJournal } from './repository-journal.js';
import { repositoryContentDigest,matchesInitializedRepository } from './repository-apply.js';
import { inspectRepositoryGit } from '../workspace/repository-preflight.js';
import { acquireBootstrapLock,assertBootstrapLockHeld } from './bootstrap-lock.js';
import { acquireWorkspaceLock,assertLockHeld } from './lock.js';
import { sha256 } from '../source/inventory.js';
import { verifyClonedRepository } from './repository-clone.js';
import { verifyRepositoryAuthorization } from './repository-authorization.js';
import { assertRecoveryLeaseHeld } from './recovery-lease.js';
import {summarizeInventory} from '../workspace/repository-observation.js';

const exact=(value,keys)=>value!==null && typeof value==='object' && !Array.isArray(value) && Object.keys(value).sort().join(',')===[...keys].sort().join(',');
async function observe(directory) {
  await inspectDirectory(path.dirname(directory));
  try {await lstat(directory);}catch(e){if(e.code==='ENOENT')return null;throw e;}
  return inventoryRepository(directory);
}

// Read-only recovery observation; never replay, clear pending or promote outcomes.
// Independent expected preview digest is required, not extracted from the file.
export async function inspectRepositoryReconciliation(wrapper,previewText,expectedDigest) {
  return inspectReconciliation(wrapper,previewText,expectedDigest,'.pipeline/repository-operation.json');
}
async function inspectReconciliation(wrapper,previewText,expectedDigest,markerPath) {
  wrapper=absoluteRoot(wrapper);
  const preview=parse(previewText,'json');
  if(!preview || typeof preview!=='object' || Array.isArray(preview))fail('repository-reconcile.preview');
  const {digest,...body}=preview;
  if(!/^sha256:[a-f0-9]{64}$/.test(expectedDigest ?? '') || digest!==expectedDigest || contractDigest(body)!==expectedDigest || preview.wrapper!==wrapper)
    fail('repository-reconcile.preview');
  const markerFile=resolveChild(wrapper,markerPath),marker=await readRecord(markerFile);
  if(!exact(marker.value,['schemaVersion','previewDigest','journal','status']) || marker.value.schemaVersion!==1 ||
    marker.value.previewDigest!==expectedDigest || marker.value.status!=='requires-reconciliation')fail('repository-reconcile.marker');
  const journal=await readRepositoryJournal(wrapper,marker.value.journal,preview);
  const observations=[],evidenceBindings=await verifyRepositoryAuthorization(wrapper,marker.value.journal,preview,journal.authorization);
  for(let i=0;i<preview.operations.length;i++) {
    const op=preview.operations[i],claimed=journal.operations[i];
    if(!['keep','directory','init','clone','move'].includes(op.action))fail('repository-reconcile.unsupported-action');
    if(!preview.layout?.repositories?.[op.repository] || op.target!==preview.layout.repositories[op.repository].path)
      fail('repository-reconcile.target');
    const target=await observe(op.target),source=op.action==='move'?await observe(op.from):null;
    let initialized=false;
    let cloned=false;
    if(op.action==='clone' && target && target.entries.some(e=>e.path==='.git/HEAD'))cloned=await verifyClonedRepository(op,target);
    if(op.action==='init' && target && matchesInitializedRepository(op,target)) {
      const git=await inspectRepositoryGit(op.target);
      initialized=git.head===null && !git.dirty && !git.blockers.length && git.inventory.digest===target.digest;
    }
    let state='conflict';
    if(claimed.status==='completed') {
      const relative='.pipeline/repository-evidence/'+path.basename(marker.value.journal)+'/'+String(i).padStart(6,'0')+'.json';
      const record=await readRecord(resolveChild(wrapper,relative)),e=record.value;
      if(record.digest!==claimed.evidenceDigest || !exact(e,['schemaVersion','previewDigest','repository','action','target','sourceAbsent','contentDigest','inventory']) ||
        e.schemaVersion!==1 || e.previewDigest!==expectedDigest || e.repository!==op.repository || e.action!==op.action || e.target!==op.target ||
        e.inventory?.root!==op.target || e.sourceAbsent!==(op.action==='move'?true:null) ||
        e.contentDigest!==repositoryContentDigest(e.inventory))fail('repository-reconcile.evidence');
      evidenceBindings.push({path:relative,digest:record.digest});
      const postcondition=target && (op.action==='directory'?target.entries.length===1:
        op.action==='clone'?cloned:
        op.action==='init'?initialized:
        op.action==='move'?source===null && repositoryContentDigest(target)===repositoryContentDigest(op.existing.inventory):
          target.digest===op.existing.inventory.digest);
      if(postcondition && contractDigest(e.inventory.kind==='repository-inventory-summary'?summarizeInventory(target):target)===contractDigest(e.inventory))state='completed-verified';
    } else {
      // Shape compatibility is NOT provenance or permission to repeat an effect.
      const unchanged=op.action==='keep'?target?.digest===op.existing.inventory.digest:
        op.action==='move'?target===null && source?.digest===op.existing.inventory.digest:target===null;
      const compatible=op.action==='directory'?target?.entries.length===1:
        op.action==='clone'?cloned:
        op.action==='init'?initialized:
        op.action==='move'?source===null && target && repositoryContentDigest(target)===repositoryContentDigest(op.existing.inventory):false;
      if(unchanged)state='before-state-observed';
      else if(compatible)state='effect-compatible-unconfirmed';
    }
    observations.push({repository:op.repository,claimedStatus:claimed.status,state,
      targetDigest:target?.digest ?? null,sourceDigest:source?.digest ?? null});
  }
  // Recheck anchors and observed trees before returning an approval candidate.
  if((await readRecord(markerFile)).digest!==marker.digest)fail('repository-reconcile.drift');
  const again=await readRepositoryJournal(wrapper,marker.value.journal,preview);
  if(contractDigest(again)!==contractDigest(journal))fail('repository-reconcile.drift');
  for(const binding of evidenceBindings)
    if((await readRecord(resolveChild(wrapper,binding.path))).digest!==binding.digest)fail('repository-reconcile.drift');
  for(let i=0;i<observations.length;i++) {
    const op=preview.operations[i],o=observations[i];
    if(((await observe(op.target))?.digest ?? null)!==o.targetDigest ||
      (op.action==='move' && ((await observe(op.from))?.digest ?? null)!==o.sourceDigest))fail('repository-reconcile.drift');
  }
  const result={kind:'repository-reconciliation',wrapper,previewDigest:expectedDigest,markerDigest:marker.digest,
    journal:marker.value.journal,journalHead:journal.lastHash,evidenceBindings,observations,
    canFinalize:journal.phase==='terminal' && observations.every(o=>o.state==='completed-verified'),
    executionAuthorized:false};
  return {...result,digest:contractDigest(result)};
}

// Explicit exact reconciliation approval. Never resolves uncertain effects or
// retries an operation. Old pending marker is moved into retained history.
// Read-only confirmation after the pending marker was already handed off. This
// does not release stale locks or authorize another operation. Require the exact
// previously approved reconciliation, not an approval inferred from the receipt.
export async function verifyRepositoryCompletion({wrapper,previewText,previewDigest,journal,reconciliationDigest}) {
  wrapper=absoluteRoot(wrapper);
  if(typeof journal!=='string' || !/^\.pipeline\/repository-journals\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(journal))
    fail('repository-reconcile.completion-journal');
  const id=path.basename(journal),base='.pipeline/repository-completions/'+id;
  const receiptFile=resolveChild(wrapper,base+'.json'),historyFile=resolveChild(wrapper,base+'.pending.json');
  const absent=async()=>{
    try{await lstat(resolveChild(wrapper,'.pipeline/repository-operation.json'));fail('repository-reconcile.completion-pending');}
    catch(e){if(e.code!=='ENOENT')throw e;}
  };
  await absent();
  const receipt=await readRecord(receiptFile),value=receipt.value;
  if(!exact(value,['schemaVersion','status','reconciliation','pipelineActivated']) || value.schemaVersion!==1 ||
    value.status!=='repository-effects-verified' || value.pipelineActivated!==false)fail('repository-reconcile.completion-receipt');
  const checked=await inspectReconciliation(wrapper,previewText,previewDigest,base+'.pending.json');
  if(!checked.canFinalize || checked.journal!==journal || checked.digest!==reconciliationDigest ||
    contractDigest(value.reconciliation)!==contractDigest(checked))fail('repository-reconcile.completion-drift');
  if((await readRecord(receiptFile)).digest!==receipt.digest)fail('repository-reconcile.receipt-drift');
  await absent();
  return {status:'repository-effects-verified',receiptFile,historyFile,receiptDigest:receipt.digest,
    reconciliationDigest:checked.digest,pipelineActivated:false,executionAuthorized:false};
}

export async function finalizeRepositoryOperations(args) {return finalize(args,false);}
export async function resumeRepositoryFinalization(args) {return finalize(args,true);}
async function finalize({wrapper,previewText,previewDigest,approval,lease,ioBoundary=async()=>{}},resume) {
  // Ordinary first-attempt callers hold persistent locks; recovery callers also
  // supply the ephemeral capability. A supplied invalid capability never falls back.
  const checkLease=()=>{if(lease!==undefined)assertRecoveryLeaseHeld(lease);};
  checkLease();
  if(!exact(approval,['decision','reconciliationDigest']) || approval.decision!=='approve')fail('repository-reconcile.approval');
  const inspect=()=>inspectRepositoryReconciliation(wrapper,previewText,previewDigest);
  const check=result=>{
    checkLease();
    if(result.digest!==approval.reconciliationDigest)fail('repository-reconcile.approval-drift');
    if(!result.canFinalize)fail('repository-reconcile.unresolved');
  };
  check(await inspect());let bootstrap,lock;
  try {
    checkLease();bootstrap=await acquireBootstrapLock(wrapper);checkLease();
    lock=await acquireWorkspaceLock(wrapper,{repositoryOperation:bootstrap});
    const verified=await inspect();check(verified);
    await assertBootstrapLockHeld(bootstrap);await assertLockHeld(lock);
    const directory=resolveChild(wrapper,'.pipeline/repository-completions');
    checkLease();
    try{await mkdir(directory);}catch(e){if(e.code!=='EEXIST')throw e;}
    await inspectDirectory(directory);
    const id=path.basename(verified.journal),receiptFile=path.join(directory,id+'.json'),historyFile=path.join(directory,id+'.pending.json');
    // A partial previous finalization must be investigated, never overwritten.
    for(const filename of resume?[historyFile]:[receiptFile,historyFile]) {
      try {await lstat(filename);fail('repository-reconcile.finalization-exists');}
      catch(e){if(e.code!=='ENOENT')throw e;}
    }
    const receipt={schemaVersion:1,status:'repository-effects-verified',reconciliation:verified,pipelineActivated:false};
    const bytes=Buffer.from(JSON.stringify(receipt)+'\n');if(bytes.length>MAX_INPUT_BYTES)fail('repository-reconcile.receipt-size');
    if(!resume) {
      checkLease();
      const handle=await open(receiptFile,'wx',0o600);
      try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
    }
    // Resumption requires the exact receipt this finalized subject would have
    // produced; missing, partial, stale or changed bytes are never overwritten.
    if((await readRecord(receiptFile)).digest!==sha256(bytes))fail('repository-reconcile.receipt-drift');
    await ioBoundary('finalization-receipt-verified',{receiptFile,historyFile,resume});
    // Reinspect effects/evidence, not just the marker, after receipt IO.
    check(await inspect());await assertBootstrapLockHeld(bootstrap);await assertLockHeld(lock);
    if((await readRecord(receiptFile)).digest!==sha256(bytes))fail('repository-reconcile.receipt-drift');
    try{await lstat(historyFile);fail('repository-reconcile.finalization-exists');}catch(e){if(e.code!=='ENOENT')throw e;}
    checkLease();await rename(resolveChild(wrapper,'.pipeline/repository-operation.json'),historyFile);
    await ioBoundary('finalization-marker-moved',{receiptFile,historyFile,resume});
    if((await readRecord(historyFile)).digest!==verified.markerDigest)fail('repository-reconcile.marker-drift');
    checkLease();
    return {status:'repository-effects-verified',receiptFile,historyFile,receiptDigest:sha256(bytes),pipelineActivated:false};
  }finally{try{if(lock)await lock.release();}finally{if(bootstrap)await bootstrap.release();}}
}
