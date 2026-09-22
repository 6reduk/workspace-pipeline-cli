import path from 'node:path';
import {hostname} from 'node:os';
import {randomUUID} from 'node:crypto';
import {lstat,mkdir,open,rename,readdir} from 'node:fs/promises';
import {fail,MAX_INPUT_BYTES} from '../contracts/parse.js';
import {contractDigest} from '../contracts/semantic.js';
import {absoluteRoot,inspectDirectory,pathBudget} from '../workspace/paths.js';
import {inventoryRepository} from '../workspace/repository-inventory.js';
import {readRecord} from './state.js';
import {bootstrapLockDirectory,assertNoBootstrapRecovery} from './bootstrap-lock.js';
import {withRecoveryLease,assertRecoveryLeaseHeld} from './recovery-lease.js';
import {sha256} from '../source/inventory.js';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const equal=(a,b)=>contractDigest(a)===contractDigest(b);
const id=s=>({dev:String(s.dev),ino:String(s.ino)});
function stopped(owner){
  if(owner.host!==hostname())return false;
  try{process.kill(owner.pid,0);return false;}catch(e){return e.code==='ESRCH';}
}
function historyPath(wrapper,attempt){
  if(!uuid.test(attempt??''))fail('bootstrap-retire.attempt');
  const result=path.join(path.dirname(wrapper),'.wpc-bootstrap-abandoned-'+attempt);pathBudget(result);return result;
}
function ownerBinding(owner,wrapper){
  if(!owner || Object.keys(owner).sort().join(',')!=='createdAt,host,pid,schemaVersion,token,workspace' ||
    owner.schemaVersion!==1 || owner.workspace!==wrapper || !uuid.test(owner.token??'') ||
    !Number.isSafeInteger(owner.pid) || owner.pid<=0 || typeof owner.host!=='string' ||
    typeof owner.createdAt!=='string' || !Number.isFinite(Date.parse(owner.createdAt)))fail('bootstrap-retire.owner');
}
async function absent(filename){try{await lstat(filename);}catch(e){if(e.code==='ENOENT')return;throw e;}fail('bootstrap-retire.destination-exists');}

// Only an absent wrapper and complete, stopped owner-only lock. Empty/torn owner
// records cannot prove liveness and remain blocked. Never infer historical effects.
export async function inspectBootstrapOwner(wrapper){
  wrapper=absoluteRoot(wrapper);
  const observe=async()=>{
    await assertNoBootstrapRecovery(wrapper);
    if((await inspectDirectory(wrapper)).exists)fail('bootstrap-retire.wrapper-exists');
    const parent=path.dirname(wrapper);if(!(await inspectDirectory(parent)).exists)fail('bootstrap-retire.parent-missing');
    const directory=bootstrapLockDirectory(wrapper);
    const inventory=await inventoryRepository(directory,{entries:4,bytes:MAX_INPUT_BYTES,depth:1});
    if(inventory.entries.map(e=>e.path).sort().join(',')!=='.,owner.json')fail('bootstrap-retire.not-owner-only');
    const record=await readRecord(path.join(directory,'owner.json'));ownerBinding(record.value,wrapper);
    await assertNoBootstrapRecovery(wrapper);
    return {kind:'bootstrap-owner-observation',wrapper,directory,inventory,ownerDigest:record.digest,
      parentIdentity:id(await lstat(parent,{bigint:true})),ownerStopped:stopped(record.value),
      wrapperAbsentAtCheck:true,executionAuthorized:false};
  };
  const first=await observe();if(!equal(first,await observe()))fail('bootstrap-retire.drift');
  return {...first,digest:contractDigest(first)};
}
export async function prepareBootstrapOwnerRetirement(wrapper){
  const observation=await inspectBootstrapOwner(wrapper),attempt=randomUUID();
  const body={schemaVersion:1,kind:'bootstrap-owner-retirement-preview',wrapper:observation.wrapper,attempt,
    history:historyPath(observation.wrapper,attempt),observation,status:observation.ownerStopped?'review-only':'blocked',
    executionAuthorized:false,pipelineActivated:false};
  return {...body,digest:contractDigest(body)};
}
function validatePreview(wrapper,preview){
  const {digest,...body}=preview??{};
  if(body.kind!=='bootstrap-owner-retirement-preview' || body.schemaVersion!==1 || body.wrapper!==wrapper ||
    body.status!=='review-only' || body.executionAuthorized!==false || body.pipelineActivated!==false ||
    contractDigest(body)!==digest || body.history!==historyPath(wrapper,body.attempt))fail('bootstrap-retire.approval');
  const {digest:od,...ob}=body.observation??{};
  if(contractDigest(ob)!==od || ob.wrapper!==wrapper || ob.directory!==bootstrapLockDirectory(wrapper) ||
    ob.inventory?.root!==ob.directory ||
    ob.kind!=='bootstrap-owner-observation' || ob.ownerStopped!==true || ob.wrapperAbsentAtCheck!==true ||
    ob.executionAuthorized!==false)fail('bootstrap-retire.approval');
}
export async function verifyBootstrapOwnerRetirement(wrapper,history){
  wrapper=absoluteRoot(wrapper);history=absoluteRoot(history);
  const attempt=path.basename(history).replace(/^\.wpc-bootstrap-abandoned-/,'');
  if(history!==historyPath(wrapper,attempt))fail('bootstrap-retire.history-path');
  await inspectDirectory(history);
  if((await readdir(history)).sort().join(',')!=='lock,request.json')fail('bootstrap-retire.history-incomplete');
  const request=await readRecord(path.join(history,'request.json')),v=request.value;
  if(!equal(v,{schemaVersion:1,kind:'bootstrap-owner-retirement-request',preview:v.preview}))fail('bootstrap-retire.request');
  validatePreview(wrapper,v.preview);if(v.preview.history!==history)fail('bootstrap-retire.history-binding');
  const saved=await inventoryRepository(path.join(history,'lock'),{entries:4,bytes:MAX_INPUT_BYTES,depth:1});
  const projection=inv=>inv.entries.map(e=>({path:e.path,type:e.type,dev:e.identity.dev,ino:e.identity.ino,
    mode:e.identity.mode,sha256:e.sha256??null}));
  const archivedOwner=await readRecord(path.join(history,'lock','owner.json'));ownerBinding(archivedOwner.value,wrapper);
  if(!equal(projection(saved),projection(v.preview.observation.inventory)) ||
    archivedOwner.digest!==v.preview.observation.ownerDigest)
    fail('bootstrap-retire.history-drift');
  if((await readRecord(request.path)).digest!==request.digest)fail('bootstrap-retire.history-drift');
  return {status:'bootstrap-owner-attempt-archived',history,requestDigest:request.digest,
    repositoryEffectsPerformed:false,pipelineActivated:false,wrapperStateNotVerified:true};
}
export async function applyBootstrapOwnerRetirement(wrapper,preview,{ioBoundary=async()=>{}}={}){
  wrapper=absoluteRoot(wrapper);validatePreview(wrapper,preview);
  return withRecoveryLease(wrapper,async lease=>{
    const check=async()=>{
      assertRecoveryLeaseHeld(lease);
      if(!equal(await inspectBootstrapOwner(wrapper),preview.observation))fail('bootstrap-retire.stale');
    };
    await check();await absent(preview.history);await mkdir(preview.history,{mode:0o700});
    const historyIdentity=id(await lstat(preview.history,{bigint:true}));
    await ioBoundary('bootstrap-retirement-history-created',{history:preview.history});
    await inspectDirectory(preview.history);
    if(!equal(id(await lstat(preview.history,{bigint:true})),historyIdentity) || (await readdir(preview.history)).length)
      fail('bootstrap-retire.history-drift');
    const value={schemaVersion:1,kind:'bootstrap-owner-retirement-request',preview};
    const bytes=Buffer.from(JSON.stringify(value)+'\n');if(bytes.length>MAX_INPUT_BYTES)fail('bootstrap-retire.input-size');
    const file=path.join(preview.history,'request.json'),h=await open(file,'wx',0o600);
    try{await h.writeFile(bytes);await h.sync();}finally{await h.close();}
    if((await readRecord(file)).digest!==sha256(bytes))fail('bootstrap-retire.readback');
    await ioBoundary('bootstrap-retirement-request-retained',{history:preview.history});
    await check();await inspectDirectory(preview.history);
    if(!equal(id(await lstat(preview.history,{bigint:true})),historyIdentity) ||
      (await readdir(preview.history)).join(',')!=='request.json' || (await readRecord(file)).digest!==sha256(bytes))
      fail('bootstrap-retire.history-drift');
    // Single handoff: the original lock blocks normal writers until this rename.
    // All history inputs already exist; no guard needs later unlocking.
    assertRecoveryLeaseHeld(lease);await rename(preview.observation.directory,path.join(preview.history,'lock'));
    await ioBoundary('bootstrap-retirement-lock-archived',{history:preview.history});
    const result=await verifyBootstrapOwnerRetirement(wrapper,preview.history);
    assertRecoveryLeaseHeld(lease);return result;
  });
}
