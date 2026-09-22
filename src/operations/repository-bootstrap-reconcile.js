import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { parse,fail } from '../contracts/parse.js';
import { contractDigest } from '../contracts/semantic.js';
import { absoluteRoot,inspectDirectory } from '../workspace/paths.js';
import { inventoryRepository } from '../workspace/repository-inventory.js';
import { bootstrapLockDirectory } from './bootstrap-lock.js';
import { readRecord } from './state.js';

const id=s=>({dev:String(s.dev),ino:String(s.ino)});
const equal=(a,b)=>contractDigest(a)===contractDigest(b);
async function inventory(root) {
  return (await inspectDirectory(root)).exists?await inventoryRepository(root):null;
}
async function optional(file) {
  try{await lstat(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}
  return readRecord(file);
}

// Read-only recovery evidence. A consistent receipt is not a capability, proof
// of process death, or permission to remove/reuse a lock. No PID probing or writes.
export async function inspectRepositoryBootstrap(wrapper,previewText,expectedDigest) {
  wrapper=absoluteRoot(wrapper);
  if(!/^sha256:[a-f0-9]{64}$/.test(expectedDigest??''))fail('repository-bootstrap.expected-digest');
  const preview=parse(previewText,'json');
  if(!preview || typeof preview!=='object' || Array.isArray(preview))fail('repository-bootstrap.preview');
  const {digest,...body}=preview;
  if(digest!==expectedDigest || contractDigest(body)!==expectedDigest || preview.wrapper!==wrapper ||
    preview.kind!=='repository-preview-candidate' || preview.executionAuthorized!==false ||
    preview.wrapperObservation?.action!=='create' || preview.wrapperObservation.target!==wrapper)
    fail('repository-bootstrap.preview');
  const directory=bootstrapLockDirectory(wrapper),metadata=path.join(wrapper,'.pipeline');
  const before={wrapper:await inventory(wrapper),lock:await inventory(directory),recoveryGate:await inventory(directory+'.recovery')};
  const files={owner:path.join(directory,'owner.json'),externalIntent:path.join(directory,'intent.json'),
    history:path.join(metadata,'repository-bootstrap-intent.json'),receipt:path.join(metadata,'repository-bootstrap.json'),
    recovery:path.join(metadata,'repository-bootstrap-recovery.json'),
    archivedOwner:path.join(metadata,'repository-bootstrap-recovered-lock','owner.json')};
  const records={};for(const [key,file] of Object.entries(files))records[key]=await optional(file);
  const conflicts=[];
  const owner=records.owner?.value;
  if(before.lock && (!owner || owner.schemaVersion!==1 || owner.workspace!==wrapper ||
    typeof owner.token!=='string' || !Number.isSafeInteger(owner.pid) || owner.pid<=0 ||
    typeof owner.host!=='string' || typeof owner.createdAt!=='string'))conflicts.push('owner-invalid');
  const expectedIntent={schemaVersion:1,kind:'wrapper-create-intent',previewDigest:expectedDigest,
    wrapper,before:preview.wrapperObservation,compensation:'no-automatic-rollback'};
  for(const key of ['externalIntent','history'])
    if(records[key] && !equal(records[key].value,expectedIntent))conflicts.push(key+'-binding');
  if(records.externalIntent && records.history)conflicts.push('duplicate-intent');
  const intent=records.externalIntent??records.history;
  if(before.lock?.entries.some(e=>!['.','owner.json','intent.json'].includes(e.path)))conflicts.push('lock-foreign-entry');
  const allowed=['.','.pipeline','.pipeline/repository-bootstrap.json','.pipeline/repository-bootstrap-intent.json',
    '.pipeline/repository-bootstrap-recovery.json','.pipeline/repository-bootstrap-recovered-lock',
    '.pipeline/repository-bootstrap-recovered-lock/owner.json'];
  if(before.wrapper?.entries.some(e=>!allowed.includes(e.path)))conflicts.push('wrapper-foreign-entry');
  let receiptConsistent=false;
  if(records.receipt) {
    const wrapperId=before.wrapper?.entries.find(e=>e.path==='.')?.identity;
    const metadataId=before.wrapper?.entries.find(e=>e.path==='.pipeline' && e.type==='directory')?.identity;
    const value=records.receipt.value;
    receiptConsistent=Boolean(intent && wrapperId && metadataId && equal(value,{
      schemaVersion:1,kind:'wrapper-created',previewDigest:expectedDigest,wrapper,
      identity:{dev:wrapperId.dev,ino:wrapperId.ino},metadataIdentity:{dev:metadataId.dev,ino:metadataId.ino},
      intentDigest:intent.digest,pipelineActivated:false,repositoryEffectsPerformed:false}));
    if(!receiptConsistent)conflicts.push('receipt-binding');
  }
  const parent=path.dirname(wrapper);
  if(!(await inspectDirectory(parent)).exists ||
    !equal(id(await lstat(parent,{bigint:true})),preview.wrapperObservation.ancestorIdentity) ||
    preview.wrapperObservation.ancestor!==parent)conflicts.push('parent-binding');
  if(records.externalIntent && !before.lock)conflicts.push('intent-without-lock');
  if(records.history && !records.receipt)conflicts.push('history-without-receipt');
  let recovered=false;
  if(records.recovery || records.archivedOwner) {
    const value=records.recovery?.value,oldOwner=records.archivedOwner?.value;
    recovered=Boolean(receiptConsistent && records.history && records.archivedOwner && oldOwner?.workspace===wrapper &&
      oldOwner.schemaVersion===1 && typeof oldOwner.token==='string' && Number.isSafeInteger(oldOwner.pid) && oldOwner.pid>0 &&
      /^sha256:[a-f0-9]{64}$/.test(value?.reconciliationDigest??'') && equal(value,{
        schemaVersion:1,kind:'wrapper-bootstrap-recovered',wrapper,previewDigest:expectedDigest,
        reconciliationDigest:value.reconciliationDigest,ownerDigest:records.archivedOwner.digest,
        originalReceiptDigest:records.receipt.digest,archive:path.join(metadata,'repository-bootstrap-recovered-lock'),
        ownerLiveness:'local-pid-absent',pipelineActivated:false,repositoryEffectsPerformed:false}));
    if(!recovered || before.lock)conflicts.push('recovery-binding');
  }
  let status='missing-records';
  if(conflicts.length)status='conflict';
  else if(before.recoveryGate)status='recovery-incomplete';
  else if(recovered)status='recovery-handoff-recorded';
  else if(receiptConsistent)status=before.lock?'receipt-consistent-lock-retained':'handoff-recorded';
  else if(intent && !before.wrapper)status='before-state-observed';
  else if(intent && before.wrapper)status='effect-compatible-unconfirmed';
  else if(before.lock)status='owner-only-unconfirmed';
  else if(before.wrapper)status='unattributed-wrapper';
  // Recheck all byte/identity observations, including missing records. No atomic
  // snapshot or protection from a malicious concurrent writer is claimed.
  for(const [key,file] of Object.entries(files)) {
    const current=await optional(file);
    if((current?.digest??null)!==(records[key]?.digest??null))fail('repository-bootstrap.observation-drift');
  }
  if(!equal(before,{wrapper:await inventory(wrapper),lock:await inventory(directory),recoveryGate:await inventory(directory+'.recovery')}))
    fail('repository-bootstrap.observation-drift');
  const result={kind:'repository-bootstrap-reconciliation',wrapper,previewDigest:expectedDigest,directory,status,
    conflicts,receiptConsistent,observations:before,
    recordDigests:Object.fromEntries(Object.entries(records).map(([key,value])=>[key,value?.digest??null])),
    ownerLiveness:'not-verified',executionAuthorized:false,canReleaseLock:false,canResume:false};
  return {...result,digest:contractDigest(result)};
}
