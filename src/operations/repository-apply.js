import path from 'node:path';
import { mkdir,open,rename,lstat } from 'node:fs/promises';
import { fail,ContractError,MAX_INPUT_BYTES } from '../contracts/parse.js';
import { contractDigest } from '../contracts/semantic.js';
import { sha256 } from '../source/inventory.js';
import { inspectDirectory,resolveChild } from '../workspace/paths.js';
import { inventoryRepository } from '../workspace/repository-inventory.js';
import { inspectRepositoryDestination } from '../workspace/repository-preflight.js';
import { revalidateRepositoryPreview } from '../workspace/repository-preview.js';
import { acquireBootstrapLock,assertBootstrapLockHeld } from './bootstrap-lock.js';
import { acquireWorkspaceLock,assertLockHeld } from './lock.js';
import { createRepositoryJournal,readRepositoryJournal } from './repository-journal.js';
import { readRecord } from './state.js';
import { runGit } from '../source/git.js';
import { inspectRepositoryGit } from '../workspace/repository-preflight.js';
import { materializeRepositoryClone,verifyClonedRepository } from './repository-clone.js';
import { persistRepositoryInputs } from './repository-inputs.js';
import {summarizeInventory,repositoryContentDigest} from '../workspace/repository-observation.js';
export {repositoryContentDigest} from '../workspace/repository-observation.js';

const absent=async filename=>{try{await lstat(filename);return false;}catch(e){if(e.code==='ENOENT')return true;throw e;}};
// Rename changes root timestamps. Content/mode projection is deliberately separate
// from exact prewrite identity inventory; every file and empty directory remains.
const content=repositoryContentDigest;
export function matchesInitializedRepository(operation,inventory) {
  return operation.initialization?.initialBranch==='main' && operation.initialization?.templates==='disabled' &&
    inventory.entries.some(e=>e.path==='.git' && e.type==='directory') &&
    inventory.entries.some(e=>e.path==='.git/HEAD' && e.sha256===sha256(Buffer.from('ref: refs/heads/main\n')).slice(7)) &&
    inventory.entries.every(e=>e.path==='.' || e.path==='.git' || e.path.startsWith('.git/')) &&
    !inventory.entries.some(e=>e.type==='file' && (e.path.startsWith('.git/refs/') || e.path==='.git/index' || e.path==='.git/packed-refs'));
}
async function persist(filename,value) {
  const bytes=Buffer.from(JSON.stringify(value)+'\n');if(bytes.length>MAX_INPUT_BYTES)fail('repository-apply.evidence-size');
  const handle=await open(filename,'wx',0o600);
  try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
  const record=await readRecord(filename);if(record.digest!==sha256(bytes))fail('repository-apply.readback');return record.digest;
}

// Internal first execution slice: existing wrapper, existing direct target parents,
// keep/directory/init/pinned clone/same-device move. Unsupported actions refuse BEFORE lock writes.
// An unresolved operation marker always blocks a new run; recovery owns its removal.
export async function applyRepositoryOperations({pipeline,workspace,wrapper,choices,options={},previewText,approval,
  onLocation=async()=>{},ioBoundary=async()=>{}}) {
  if(!approval || Object.keys(approval).sort().join(',')!=='decision,previewDigest' || approval.decision!=='approve')fail('repository-apply.approval');
  const validate=()=>revalidateRepositoryPreview(previewText,approval.previewDigest,pipeline,workspace,wrapper,choices,options);
  const preview=await validate();
  if(!preview.manifest)fail('repository-apply.manifest-required');
  if(!(await inspectDirectory(preview.wrapper)).exists)fail('repository-apply.bootstrap-required');
  for(const op of preview.operations) {
    if(!['keep','directory','init','clone','move'].includes(op.action))fail('repository-apply.action-not-implemented');
    if(!(await inspectDirectory(path.dirname(op.target))).exists)fail('repository-apply.parent-required');
  }
  const marker=resolveChild(preview.wrapper,'.pipeline/repository-operation.json');
  if(!await absent(marker))fail('repository-apply.pending');
  let bootstrap,lock,journal;
  try {
    bootstrap=await acquireBootstrapLock(preview.wrapper,{onLocation});
    lock=await acquireWorkspaceLock(preview.wrapper,{repositoryOperation:bootstrap});
    await assertBootstrapLockHeld(bootstrap);await validate();
    if(!await absent(marker))fail('repository-apply.pending');
    journal=await createRepositoryJournal(lock,preview,{onLocation});
    await persistRepositoryInputs(preview.wrapper,journal.relative,preview);
    await ioBoundary('repository-inputs-persisted',{journal:journal.relative,previewDigest:preview.digest});
    await persist(marker,{schemaVersion:1,previewDigest:preview.digest,journal:journal.relative,status:'requires-reconciliation'});
    const authorization=await ioBoundary('repository-run-started',{journal:journal.relative,previewDigest:preview.digest});
    if(authorization!==undefined)await journal.authorize(authorization);
    await assertBootstrapLockHeld(bootstrap);await assertLockHeld(lock);
    const evidenceRoot=resolveChild(preview.wrapper,'.pipeline/repository-evidence');
    try{await mkdir(evidenceRoot);}catch(e){if(e.code!=='EEXIST')throw e;}
    await inspectDirectory(evidenceRoot);
    const evidenceDirectory=path.join(evidenceRoot,path.basename(journal.directory));await mkdir(evidenceDirectory);
    await onLocation({directory:evidenceDirectory,status:'evidence-created'});
    for(let index=0;index<preview.operations.length;index++) {
      const op=preview.operations[index];
      await assertBootstrapLockHeld(bootstrap);await assertLockHeld(lock);
      await journal.intent(op.repository);
      // Error here leaves an intent without outcome: uncertain, never auto-retry.
      await ioBoundary('before-effect',{repository:op.repository});
      await assertBootstrapLockHeld(bootstrap);await assertLockHeld(lock);
      if(op.existing && (await inventoryRepository(op.existing.inventory.root)).digest!==op.existing.inventory.digest)fail('repository-apply.source-drift');
      if(op.destination && contractDigest(await inspectRepositoryDestination(op.target))!==contractDigest(op.destination))fail('repository-apply.destination-drift');
      if(op.action==='directory')await mkdir(op.target);
      else if(op.action==='clone')await materializeRepositoryClone(op,lock,bootstrap,ioBoundary);
      else if(op.action==='init') {
        await mkdir(op.target);
        await ioBoundary('init-directory-created',{repository:op.repository});
        await assertBootstrapLockHeld(bootstrap);await assertLockHeld(lock);
        if((await inventoryRepository(op.target)).entries.length!==1)fail('repository-apply.init-target-drift');
        await runGit(op.target,['init','--template=','--initial-branch='+op.initialization.initialBranch]);
      }
      else if(op.action==='move')await rename(op.from,op.target);
      await ioBoundary('after-effect',{repository:op.repository});
      await assertBootstrapLockHeld(bootstrap);await assertLockHeld(lock);
      const observed=await inventoryRepository(op.target);
      if(op.action==='directory' && observed.entries.length!==1)fail('repository-apply.postcondition');
      if(op.action==='clone' && !await verifyClonedRepository(op,observed))fail('repository-apply.postcondition');
      if(op.action==='init') {
        const git=await inspectRepositoryGit(op.target);
        if(!matchesInitializedRepository(op,observed) || git.head!==null || git.dirty || git.blockers.length || git.inventory.digest!==observed.digest)
          fail('repository-apply.postcondition');
      }
      if(op.action==='move' && (!await absent(op.from) || content(observed)!==content(op.existing.inventory)))fail('repository-apply.postcondition');
      if(op.action==='keep' && observed.digest!==op.existing.inventory.digest)fail('repository-apply.postcondition');
      const evidence={schemaVersion:1,previewDigest:preview.digest,repository:op.repository,action:op.action,
        target:op.target,sourceAbsent:op.action==='move'?true:null,contentDigest:content(observed),inventory:summarizeInventory(observed)};
      const evidenceDigest=await persist(path.join(evidenceDirectory,String(index).padStart(6,'0')+'.json'),evidence);
      await ioBoundary('evidence-persisted',{repository:op.repository});
      await journal.outcome('completed',evidenceDigest);
    }
    const result=await readRepositoryJournal(preview.wrapper,journal.relative,preview);
    return {status:'effects-completed',journal:journal.relative,evidenceDirectory,result,
      requiresReconciliation:true,pipelineActivated:false};
  }catch(cause){
    const error=cause instanceof ContractError?cause:new ContractError(cause.code==='EBUSY'?
      'repository-apply.busy':['EACCES','EPERM'].includes(cause.code)?'repository-apply.access-denied':'repository-apply.io');
    if(journal)error.repositoryJournal=journal.relative;
    throw error;
  }finally{
    // Exact lock releases only, never rollback filesystem effects or clear marker.
    try{if(lock)await lock.release();}finally{if(bootstrap)await bootstrap.release();}
  }
}
