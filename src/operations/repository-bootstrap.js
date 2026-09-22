import path from 'node:path';
import { mkdir,open,lstat,rename,readdir } from 'node:fs/promises';
import { ContractError,fail } from '../contracts/parse.js';
import { sha256 } from '../source/inventory.js';
import { contractDigest } from '../contracts/semantic.js';
import { inspectDirectory } from '../workspace/paths.js';
import { inspectRepositoryDestination } from '../workspace/repository-preflight.js';
import { revalidateRepositoryPreview } from '../workspace/repository-preview.js';
import { acquireBootstrapLock,assertBootstrapLockHeld } from './bootstrap-lock.js';
import { readRecord } from './state.js';

const identity=s=>({dev:String(s.dev),ino:String(s.ino)});
async function persist(file,value) {
  const bytes=Buffer.from(JSON.stringify(value)+'\n'),handle=await open(file,'wx',0o600);
  try {await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
  if((await readRecord(file)).digest!==sha256(bytes))fail('repository-bootstrap.readback');
  return sha256(bytes);
}

// Internal bootstrap phase only. Repository effects and pipeline activation are
// separate: its original preview cannot be reused after the approved mkdir.
// A durable external intent precedes mkdir. Any interrupted handoff retains the
// sibling lock and records for explicit recovery, never recursive rollback.
export async function createRepositoryWrapper({pipeline,workspace,wrapper,choices,options={},previewText,approval,
  onLocation=async()=>{},ioBoundary=async()=>{}}) {
  if(!approval || Object.keys(approval).sort().join(',')!=='decision,previewDigest' || approval.decision!=='approve')
    fail('repository-bootstrap.approval');
  const validate=()=>revalidateRepositoryPreview(previewText,approval.previewDigest,pipeline,workspace,wrapper,choices,options);
  const preview=await validate();
  if(!preview.manifest)fail('repository-bootstrap.manifest-required');
  if(preview.wrapperObservation.action!=='create')fail('repository-bootstrap.wrapper-exists');
  if(!(await inspectDirectory(path.dirname(preview.wrapper))).exists)fail('repository-bootstrap.parent-required');
  let lock,intentStarted=false,completed=false;
  try {
    lock=await acquireBootstrapLock(preview.wrapper,{onLocation});
    await validate();await assertBootstrapLockHeld(lock);
    const intentFile=path.join(lock.directory,'intent.json');
    intentStarted=true;
    const intentDigest=await persist(intentFile,{schemaVersion:1,kind:'wrapper-create-intent',previewDigest:preview.digest,
      wrapper:preview.wrapper,before:preview.wrapperObservation,compensation:'no-automatic-rollback'});
    await ioBoundary('wrapper-intent-persisted',{directory:lock.directory});
    await assertBootstrapLockHeld(lock);
    if((await readRecord(intentFile)).digest!==intentDigest)fail('repository-bootstrap.intent-drift');
    const before={action:'create',...(await inspectRepositoryDestination(preview.wrapper))};
    if(contractDigest(before)!==contractDigest(preview.wrapperObservation))fail('repository-bootstrap.destination-drift');
    await mkdir(preview.wrapper);
    const created=identity(await lstat(preview.wrapper,{bigint:true}));
    await ioBoundary('wrapper-created',{wrapper:preview.wrapper});
    await assertBootstrapLockHeld(lock);await inspectDirectory(preview.wrapper);
    if(contractDigest(identity(await lstat(preview.wrapper,{bigint:true})))!==contractDigest(created) ||
      (await readdir(preview.wrapper)).length)fail('repository-bootstrap.wrapper-drift');
    const metadata=path.join(preview.wrapper,'.pipeline');await mkdir(metadata);
    const metadataIdentity=identity(await lstat(metadata,{bigint:true}));
    const receipt=path.join(metadata,'repository-bootstrap.json');
    const receiptDigest=await persist(receipt,{schemaVersion:1,kind:'wrapper-created',previewDigest:preview.digest,
      wrapper:preview.wrapper,identity:created,metadataIdentity,intentDigest,
      pipelineActivated:false,repositoryEffectsPerformed:false});
    await ioBoundary('wrapper-receipt-persisted',{receipt});
    await assertBootstrapLockHeld(lock);await inspectDirectory(metadata);
    if(contractDigest(identity(await lstat(preview.wrapper,{bigint:true})))!==contractDigest(created) ||
      contractDigest(identity(await lstat(metadata,{bigint:true})))!==contractDigest(metadataIdentity))
      fail('repository-bootstrap.wrapper-drift');
    const history=path.join(metadata,'repository-bootstrap-intent.json');
    // Never replace even an untrusted receipt. Rename remains a cooperative,
    // not hostile-concurrent-writer, guarantee like the surrounding lifecycle.
    if((await readdir(metadata)).includes(path.basename(history)))fail('repository-bootstrap.history-exists');
    if((await readRecord(intentFile)).digest!==intentDigest || (await readRecord(receipt)).digest!==receiptDigest)
      fail('repository-bootstrap.readback');
    await rename(intentFile,history);
    const record=await readRecord(receipt);
    if(record.digest!==receiptDigest || (await readRecord(history)).digest!==intentDigest)fail('repository-bootstrap.readback');
    completed=true;
    return {status:'wrapper-created',wrapper:preview.wrapper,receipt,requiresRepositoryPreview:true,
      pipelineActivated:false,repositoryEffectsPerformed:false};
  }catch(cause){
    const error=cause instanceof ContractError?cause:new ContractError('repository-bootstrap.io');
    if(lock)error.bootstrapDirectory=lock.directory;
    throw error;
  }finally{
    if(lock && (!intentStarted || completed))await lock.release();
  }
}
