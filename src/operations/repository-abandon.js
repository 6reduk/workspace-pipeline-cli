import path from 'node:path';
import {hostname} from 'node:os';
import {randomUUID} from 'node:crypto';
import {mkdir,open,rename,lstat} from 'node:fs/promises';
import {absoluteRoot,inspectDirectory} from '../workspace/paths.js';
import {inventoryRepository} from '../workspace/repository-inventory.js';
import {contractDigest} from '../contracts/semantic.js';
import {fail,MAX_INPUT_BYTES} from '../contracts/parse.js';
import {readRecord} from './state.js';
import {readRepositoryInputs} from './repository-inputs.js';
import {bootstrapLockDirectory} from './bootstrap-lock.js';
import {withRecoveryLease,assertRecoveryLeaseHeld} from './recovery-lease.js';
import {sha256} from '../source/inventory.js';
import {inspectRepositoryReconciliation} from './repository-reconcile.js';

const eq=(a,b)=>contractDigest(a)===contractDigest(b);
const uuid=s=>typeof s==='string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(s);
const id=s=>({dev:String(s.dev),ino:String(s.ino)});
async function exists(p){try{await lstat(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
// Renaming a root changes its timestamps. Content, nested identities and file
// hashes remain bound; directory timestamps alone do not prove foreign writes.
async function observe(p,omit=[]){
  if(!await exists(p))return null;
  const v=await inventoryRepository(p);
  return v.entries.filter(e=>!omit.some(x=>e.path===x || e.path.startsWith(x+'/'))).map(e=>
    ({path:e.path,type:e.type,identity:e.type==='directory'?{dev:e.identity.dev,ino:e.identity.ino}:e.identity,
      ...(e.sha256?{sha256:e.sha256}:{})}));
}
function stopped(o){
  if(o.host!==hostname() || !Number.isSafeInteger(o.pid) || o.pid<=0)fail('repository-abandon.owner-unknown');
  try{process.kill(o.pid,0);}catch(e){if(e.code==='ESRCH')return;fail('repository-abandon.owner-unknown');}
  fail('repository-abandon.owner-live');
}
function routes(w,attempt){return {gate:bootstrapLockDirectory(w)+'.recovery',
  archive:path.join(path.dirname(w),'.wpc-repository-resolution-'+attempt),
  sources:[path.join(w,'.pipeline/repository-operation.json'),path.join(w,'.pipeline/lock'),bootstrapLockDirectory(w)]};}
async function lock(p,w){
  const v=await observe(p);if(!v)return null;
  if(!eq(v.map(e=>e.path).sort(),['.','owner.json']))fail('repository-abandon.lock-incomplete');
  const o=(await readRecord(path.join(p,'owner.json'))).value;
  if(Object.keys(o).sort().join(',')!=='createdAt,host,pid,schemaVersion,token,workspace' ||
    o.workspace!==w || o.schemaVersion!==1 || !uuid(o.token) || typeof o.createdAt!=='string' ||
    !Number.isFinite(Date.parse(o.createdAt)))fail('repository-abandon.owner-binding');stopped(o);return v;
}
async function data(w,input){
  const preview=JSON.parse(input.previewText),trees=[];
  if(!Array.isArray(preview.operations) || !preview.operations.length || preview.operations.length>128)fail('repository-abandon.inputs');
  for(const op of preview.operations){
    for(const p of [op.target,...(op.action==='move'?[op.from]:[])]){
      absoluteRoot(p);if(trees.some(x=>x.path===p))continue;
      const entries=await observe(p);
      trees.push({path:p,inventory:entries===null?null:{entryCount:entries.length,digest:contractDigest(entries)}});
    }
  }
  return {trees,metadata:await observe(path.join(w,'.pipeline'),['lock','repository-operation.json'])};
}
async function state(w){
  const r=routes(w,'unused');
  for(const p of [r.gate,bootstrapLockDirectory(w)+'.recovery-resume'])if(await exists(p))fail('repository-abandon.recovery-pending');
  const m=await readRecord(r.sources[0]);
  if(m.value.schemaVersion!==1 || m.value.status!=='requires-reconciliation')fail('repository-abandon.marker');
  const input=await readRepositoryInputs(w,m.value.journal,m.value.previewDigest);
  if((await inspectRepositoryReconciliation(w,input.previewText,m.value.previewDigest)).canFinalize)
    fail('repository-abandon.finalizable');
  return {parent:id(await lstat(path.dirname(w),{bigint:true})),wrapperIdentity:id(await lstat(w,{bigint:true})),
    markerDigest:m.digest,inputDigest:input.recordDigest,journal:m.value.journal,previewDigest:m.value.previewDigest,
    locks:[await lock(r.sources[1],w),await lock(r.sources[2],w)],...await data(w,input)};
}
export async function prepareRepositoryAbandon(wrapper){
  wrapper=absoluteRoot(wrapper);await inspectDirectory(wrapper);
  const before=await state(wrapper);if(!eq(before,await state(wrapper)))fail('repository-abandon.drift');
  const value={schemaVersion:1,kind:'repository-abandon-preview',wrapper,attempt:randomUUID(),
    decision:'preserve-current-state-abandon-operation',before,executionAuthorized:false,
    completed:false,pipelineActivated:false,requiresNewRepositoryPreview:true};
  return {...value,digest:contractDigest(value)};
}
function validate(p,w){
  const {digest,...body}=p??{};
  if(p?.kind!=='repository-abandon-preview' || p.wrapper!==w || p.schemaVersion!==1 ||
    p.decision!=='preserve-current-state-abandon-operation' || !uuid(p.attempt) ||
    contractDigest(body)!==digest)fail('repository-abandon.preview');
}
async function persist(p,value){
  const b=Buffer.from(JSON.stringify(value)+'\n');if(b.length>MAX_INPUT_BYTES)fail('repository-abandon.size');
  const h=await open(p,'wx',0o600);try{await h.writeFile(b);await h.sync();}finally{await h.close();}
  if((await readRecord(p)).digest!==sha256(b))fail('repository-abandon.readback');
}
// Read-only observation for a fresh continuation approval. No successful-effect
// claim: this route explicitly preserves partial/uncertain trees as user data.
export async function inspectRepositoryAbandon(wrapper,attempt){
  wrapper=absoluteRoot(wrapper);if(!uuid(attempt))fail('repository-abandon.attempt');
  const r=routes(wrapper,attempt),request=await readRecord(path.join(r.archive,'request.json')),p=request.value;
  validate(p,wrapper);if(p.attempt!==attempt)fail('repository-abandon.binding');
  const gateActive=await exists(r.gate),guard=gateActive?r.gate:path.join(r.archive,'guard');
  const owner=await readRecord(path.join(guard,'owner.json'));
  if(owner.value.wrapper!==wrapper || owner.value.attempt!==attempt || owner.value.previewDigest!==p.digest)fail('repository-abandon.guard');
  const contents=await observe(guard);if(!eq(contents.map(e=>e.path).sort(),['.','owner.json']))fail('repository-abandon.guard');
  const locations=[];
  for(let i=0;i<r.sources.length;i++){
    const source=await exists(r.sources[i]),dest=path.join(r.archive,String(i));
    const archived=await exists(dest),expected=i===0?true:p.before.locks[i-1]!==null;
    if(expected?source===archived:source||archived)fail('repository-abandon.location');
    const at=source?r.sources[i]:dest;
    if(i===0){if((await readRecord(at)).digest!==p.before.markerDigest)fail('repository-abandon.marker-drift');}
    else if(expected && !eq(await lock(at,wrapper),p.before.locks[i-1]))fail('repository-abandon.lock-drift');
    locations.push(expected?(source?'source':'archived'):'absent');
  }
  const marker=await readRecord(locations[0]==='source'?r.sources[0]:path.join(r.archive,'0'));
  const input=await readRepositoryInputs(wrapper,marker.value.journal,marker.value.previewDigest);
  if(input.recordDigest!==p.before.inputDigest || !eq(await data(wrapper,input),{trees:p.before.trees,metadata:p.before.metadata}) ||
    !eq(id(await lstat(wrapper,{bigint:true})),p.before.wrapperIdentity) ||
    !eq(id(await lstat(path.dirname(wrapper),{bigint:true})),p.before.parent))fail('repository-abandon.subject-drift');
  const receiptPath=path.join(r.archive,'receipt.json'),receipt=await exists(receiptPath)?await readRecord(receiptPath):null;
  const expected={schemaVersion:1,status:'abandoned-preserving-current-state',previewDigest:p.digest,
    completed:false,pipelineActivated:false,requiresNewRepositoryPreview:true};
  if(receipt && (!eq(receipt.value,expected) || locations.includes('source')))fail('repository-abandon.receipt');
  if(!gateActive && !receipt)fail('repository-abandon.order');
  const archive=await observe(r.archive),approvals=archive.filter(e=>/^authorization-\d{4}\.json$/.test(e.path)).sort((a,b)=>a.path.localeCompare(b.path));
  if(approvals.length>64)fail('repository-abandon.approval-limit');
  const previousApprovals=[];
  for(const [i,a] of approvals.entries()){
    if(a.path!=='authorization-'+String(i+1).padStart(4,'0')+'.json')fail('repository-abandon.approval-sequence');
    const record=await readRecord(path.join(r.archive,a.path)),v=record.value,o=v.observation;
    const {digest,...body}=o??{};
    if(Object.keys(v).sort().join(',')!=='decision,observation,previousApprovals,schemaVersion,sequence' ||
      v.schemaVersion!==1 || v.sequence!==i+1 || !eq(v.previousApprovals,previousApprovals) ||
      v.decision!=='preserve-current-state-abandon-operation' || o?.wrapper!==wrapper || o.attempt!==attempt ||
      o.requestDigest!==request.digest || o.ownerDigest!==owner.digest || contractDigest(body)!==digest)
      fail('repository-abandon.approval');
    previousApprovals.push({name:a.path,digest:record.digest});
  }
  const allowed=['.','request.json',...approvals.map(a=>a.path),...locations.flatMap((s,i)=>s==='archived'?
    (i===0?[String(i)]:[String(i),i+'/owner.json']):[]),...(receipt?['receipt.json']:[]),...(!gateActive?['guard','guard/owner.json']:[])].sort();
  if(!eq(archive.map(e=>e.path).sort(),allowed))fail('repository-abandon.foreign-history');
  const body={kind:'repository-abandon-observation',wrapper,attempt,requestDigest:request.digest,
    ownerDigest:owner.digest,guard:contents,locations,archive,gateActive,receiptDigest:receipt?.digest??null,executionAuthorized:false};
  return {...body,digest:contractDigest(body)};
}
export async function applyRepositoryAbandon(wrapper,preview,{ioBoundary=async()=>{},continuation=false}={}){
  wrapper=absoluteRoot(wrapper);
  return withRecoveryLease(wrapper,async lease=>{
    const checkLease=()=>assertRecoveryLeaseHeld(lease);checkLease();
    let p=preview,r,original;
    if(!continuation){
      validate(p,wrapper);if(!eq(await state(wrapper),p.before))fail('repository-abandon.stale');r=routes(wrapper,p.attempt);
      if(await exists(r.archive))fail('repository-abandon.history-exists');
      await mkdir(r.archive);await persist(path.join(r.archive,'request.json'),p);
      await ioBoundary('abandon-request-retained');checkLease();
      if(!eq(await state(wrapper),p.before))fail('repository-abandon.stale');
      await mkdir(r.gate);await persist(path.join(r.gate,'owner.json'),{wrapper,attempt:p.attempt,previewDigest:p.digest,pid:process.pid,host:hostname()});
      original=await inspectRepositoryAbandon(wrapper,p.attempt);
      await ioBoundary('abandon-guard-created');
    }else{
      const fresh=await inspectRepositoryAbandon(wrapper,preview?.attempt);
      if(!eq(fresh,preview))fail('repository-abandon.stale');original=fresh;r=routes(wrapper,preview.attempt);
      if(!fresh.gateActive)return {status:'abandoned-preserving-current-state',archive:r.archive,completed:false,pipelineActivated:false};
      stopped((await readRecord(path.join(r.gate,'owner.json'))).value);
      p=(await readRecord(path.join(r.archive,'request.json'))).value;
      const prior=fresh.archive.filter(e=>/^authorization-\d{4}\.json$/.test(e.path)).sort((a,b)=>a.path.localeCompare(b.path));
      if(prior.length>=64)fail('repository-abandon.approval-limit');
      const previousApprovals=[];
      for(const a of prior)previousApprovals.push({name:a.path,digest:(await readRecord(path.join(r.archive,a.path))).digest});
      await persist(path.join(r.archive,'authorization-'+String(prior.length+1).padStart(4,'0')+'.json'),{
        schemaVersion:1,sequence:prior.length+1,previousApprovals,
        decision:'preserve-current-state-abandon-operation',observation:fresh});
      original=await inspectRepositoryAbandon(wrapper,p.attempt);await ioBoundary('abandon-continuation-approved');
    }
    let current=original;
    const check=async()=>{checkLease();const next=await inspectRepositoryAbandon(wrapper,p.attempt);
      if(continuation)stopped((await readRecord(path.join(r.gate,'owner.json'))).value);
      if(!eq(next,current))fail('repository-abandon.drift');};
    for(let i=0;i<3;i++){
      await check();if(current.locations[i]!=='source')continue;
      await rename(r.sources[i],path.join(r.archive,String(i)));
      current=await inspectRepositoryAbandon(wrapper,p.attempt);await ioBoundary('abandon-moved-'+i);
    }
    await check();
    if(!current.receiptDigest){
      await persist(path.join(r.archive,'receipt.json'),{schemaVersion:1,status:'abandoned-preserving-current-state',previewDigest:p.digest,
        completed:false,pipelineActivated:false,requiresNewRepositoryPreview:true});
      current=await inspectRepositoryAbandon(wrapper,p.attempt);await ioBoundary('abandon-receipt');
    }
    await check();await rename(r.gate,path.join(r.archive,'guard'));await ioBoundary('abandon-guard-archived');
    checkLease();
    if(!eq(await observe(path.join(r.archive,'guard')),original.guard) ||
      (await readRecord(path.join(r.archive,'request.json'))).digest!==original.requestDigest ||
      (await readRecord(path.join(r.archive,'receipt.json'))).digest!==current.receiptDigest)
      fail('repository-abandon.readback');
    return {status:'abandoned-preserving-current-state',archive:r.archive,receipt:path.join(r.archive,'receipt.json'),
      completed:false,pipelineActivated:false,requiresNewRepositoryPreview:true};
  });
}
