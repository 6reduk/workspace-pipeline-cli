import path from 'node:path';
import {hostname} from 'node:os';
import {lstat,open,rename,readdir} from 'node:fs/promises';
import {fail,MAX_INPUT_BYTES} from '../contracts/parse.js';
import {contractDigest} from '../contracts/semantic.js';
import {absoluteRoot,inspectDirectory,pathBudget} from '../workspace/paths.js';
import {inventoryRepository} from '../workspace/repository-inventory.js';
import {bootstrapLockDirectory} from './bootstrap-lock.js';
import {readRecord} from './state.js';
import {withRecoveryLease,assertRecoveryLeaseHeld} from './recovery-lease.js';
import {sha256} from '../source/inventory.js';

const equal=(a,b)=>contractDigest(a)===contractDigest(b);
const rootId=inv=>{const s=inv?.entries.find(e=>e.path==='.')?.identity;return s?{dev:s.dev,ino:s.ino}:null;};
const stopped=owner=>{
  if(owner?.host!==hostname() || !Number.isSafeInteger(owner.pid) || owner.pid<=0)return false;
  try{process.kill(owner.pid,0);return false;}catch(e){return e.code==='ESRCH';}
};
async function inventory(directory){return (await inspectDirectory(directory)).exists?inventoryRepository(directory,{entries:512,bytes:16*1024*1024,depth:8}):null;}
async function record(filename){try{await lstat(filename);}catch(e){if(e.code==='ENOENT')return null;throw e;}return readRecord(filename);}
function routes(wrapper,initial) {
  const retry=initial.status==='before-state-observed',base=bootstrapLockDirectory(wrapper),metadata=path.join(wrapper,'.pipeline');
  const archive=retry?path.join(path.dirname(wrapper),'.wpc-bootstrap-history-'+initial.digest.slice(7)):
    path.join(metadata,'repository-bootstrap-recovered-lock');
  const result={base,gate:base+'.recovery',metadata,archive,retry,
    history:path.join(path.dirname(wrapper),'.wpc-bootstrap-recovery-'+initial.digest.slice(7)),
    intent:path.join(metadata,'repository-bootstrap-intent.json'),
    receipt:retry?path.join(archive,'recovery.json'):path.join(metadata,'repository-bootstrap-recovery.json')};
  for(const value of Object.values(result))if(typeof value==='string')pathBudget(value);
  return result;
}
function expectedReceipt(wrapper,initial,r) {
  return r.retry?{schemaVersion:1,kind:'wrapper-bootstrap-attempt-archived',wrapper,previewDigest:initial.previewDigest,
    reconciliationDigest:initial.digest,archive:r.archive,ownerDigest:initial.recordDigests.owner,
    intentDigest:initial.recordDigests.externalIntent,ownerLiveness:'local-pid-absent',wrapperAbsentAtCheck:true,
    attemptCompleted:false,pipelineActivated:false}:{schemaVersion:1,kind:'wrapper-bootstrap-recovered',wrapper,
    previewDigest:initial.previewDigest,reconciliationDigest:initial.digest,ownerDigest:initial.recordDigests.owner,
    originalReceiptDigest:initial.recordDigests.receipt,archive:r.archive,ownerLiveness:'local-pid-absent',
    pipelineActivated:false,repositoryEffectsPerformed:false};
}

// Read-only reconstruction from the original request, not inference from an empty
// wrapper. Completed history requires its exact initial reconciliation digest.
export async function inspectBootstrapRecovery({wrapper,initialDigest}) {
  wrapper=absoluteRoot(wrapper);
  if(initialDigest!==undefined && !/^sha256:[a-f0-9]{64}$/.test(initialDigest))fail('bootstrap-continue.initial-digest');
  const observe=async()=>{
    const gate=bootstrapLockDirectory(wrapper)+'.recovery',active=await inventory(gate);
    if(!active && !initialDigest)fail('bootstrap-continue.initial-digest-required');
    const directory=active?gate:path.join(path.dirname(wrapper),'.wpc-bootstrap-recovery-'+initialDigest.slice(7));
    const guard=active??await inventory(directory);
    if(!guard)fail('bootstrap-continue.missing');
    const request=await record(path.join(directory,'request.json')),owner=await record(path.join(directory,'owner.json'));
    if(!request || !owner)fail('bootstrap-continue.request-incomplete');
    const value=request.value,initial=value.initial,preview=value.preview;
    if(!initial || !preview)fail('bootstrap-continue.request');
    const {digest,...body}=initial,{digest:pd,...pb}=preview;
    if(value.schemaVersion!==1 || Object.keys(value).sort().join(',')!=='approval,initial,preview,schemaVersion' ||
      !equal(value.approval,{decision:'approve',reconciliationDigest:digest}) || contractDigest(body)!==digest ||
      contractDigest(pb)!==pd || initial.previewDigest!==pd || preview.wrapper!==wrapper || initial.wrapper!==wrapper ||
      (initialDigest!==undefined && initialDigest!==digest) || initial.directory!==bootstrapLockDirectory(wrapper) ||
      initial.kind!=='repository-bootstrap-reconciliation' || initial.executionAuthorized!==false ||
      preview.kind!=='repository-preview-candidate' || preview.executionAuthorized!==false ||
      preview.wrapperObservation?.target!==wrapper || !equal(initial.conflicts,[]) ||
      !['before-state-observed','receipt-consistent-lock-retained'].includes(initial.status) ||
      preview.wrapperObservation?.ancestor!==path.dirname(wrapper) || preview.wrapperObservation.action!=='create' ||
      !equal(owner.value,{pid:owner.value.pid,host:owner.value.host,wrapper,reconciliationDigest:digest}))
      fail('bootstrap-continue.request');
    const r=routes(wrapper,initial);
    if(active && await inventory(r.history))fail('bootstrap-continue.duplicate-gate');
    const parent=await lstat(path.dirname(wrapper),{bigint:true});
    if(!equal({dev:String(parent.dev),ino:String(parent.ino)},preview.wrapperObservation.ancestorIdentity))fail('bootstrap-continue.parent-drift');
    const source=await inventory(r.base),archive=await inventory(r.archive),currentWrapper=await inventory(wrapper);
    if(Boolean(source)===Boolean(archive))fail('bootstrap-continue.lock-location');
    const lock=source??archive,lockPath=source?r.base:r.archive;
    if(!equal(rootId(lock),rootId(initial.observations.lock)))fail('bootstrap-continue.lock-identity');
    const originalOwner=await record(path.join(lockPath,'owner.json'));
    if(originalOwner?.digest!==initial.recordDigests.owner)fail('bootstrap-continue.owner-drift');
    const ext=await record(path.join(lockPath,'intent.json')),hist=r.retry?null:await record(r.intent);
    const intentDigest=initial.recordDigests.externalIntent??initial.recordDigests.history;
    if(r.retry ? ext?.digest!==intentDigest : Boolean(ext)===Boolean(hist) || (ext??hist)?.digest!==intentDigest)
      fail('bootstrap-continue.intent-drift');
    if(!r.retry && archive && ext)fail('bootstrap-continue.order');
    const receipt=await record(r.receipt),expected=expectedReceipt(wrapper,initial,r);
    if(receipt && (!archive || !equal(receipt.value,expected)))fail('bootstrap-continue.receipt');
    const lockNames=['.','owner.json',...(ext?['intent.json']:[]),...(r.retry && receipt?['recovery.json']:[])].sort();
    if(!equal(lock.entries.map(e=>e.path).sort(),lockNames))fail('bootstrap-continue.foreign-lock-entry');
    if(r.retry){if(currentWrapper)fail('bootstrap-continue.wrapper-appeared');}
    else {
      const old=initial.observations.wrapper;
      if(!currentWrapper || !equal(rootId(currentWrapper),rootId(old)))fail('bootstrap-continue.wrapper-drift');
      const md=inv=>{const e=inv.entries.find(e=>e.path==='.pipeline')?.identity;return e?{dev:e.dev,ino:e.ino}:null;};
      if(!equal(md(currentWrapper),md(old)))fail('bootstrap-continue.wrapper-drift');
      const originalReceipt=await record(path.join(r.metadata,'repository-bootstrap.json'));
      if(originalReceipt?.digest!==initial.recordDigests.receipt)fail('bootstrap-continue.wrapper-drift');
      const allowed=['.','.pipeline','.pipeline/repository-bootstrap.json',...(hist?['.pipeline/repository-bootstrap-intent.json']:[]),
        ...(archive?['.pipeline/repository-bootstrap-recovered-lock','.pipeline/repository-bootstrap-recovered-lock/owner.json']:[]),
        ...(receipt?['.pipeline/repository-bootstrap-recovery.json']:[])];
      if(!equal(currentWrapper.entries.map(e=>e.path).sort(),allowed.sort()))fail('bootstrap-continue.foreign-wrapper-entry');
    }
    if(!active && !receipt)fail('bootstrap-continue.order');
    const authorizations=[];
    const names=guard.entries.map(e=>e.path).filter(n=>!['.','owner.json','request.json'].includes(n)).sort();
    if(names.length>64 || names.some((n,i)=>n!=='authorization-'+String(i+1).padStart(4,'0')+'.json'))fail('bootstrap-continue.authorization-entries');
    for(const name of names) {
      const saved=await record(path.join(directory,name)),v=saved?.value,o=v?.observation;
      if(!o)fail('bootstrap-continue.authorization');
      const {digest:od,...ob}=o;
      if(!equal(v,{schemaVersion:1,approval:{decision:'approve',recoveryDigest:od},observation:o}) ||
        contractDigest(ob)!==od || o.kind!=='bootstrap-recovery-observation' || o.wrapper!==wrapper ||
        o.initialDigest!==digest || o.requestDigest!==request.digest || o.ownerDigest!==owner.digest ||
        !equal(o.authorizations,authorizations) || o.ownerStopped!==true || o.originalOwnerStopped!==true ||
        o.status==='complete' || o.executionAuthorized!==false)fail('bootstrap-continue.authorization');
      authorizations.push({name,digest:saved.digest});
    }
    const result={kind:'bootstrap-recovery-observation',wrapper,initialDigest:digest,requestDigest:request.digest,
      ownerDigest:owner.digest,ownerStopped:stopped(owner.value),originalOwnerStopped:stopped(originalOwner.value),
      status:!active?'complete':receipt?'receipt-recorded':archive?'lock-archived':!r.retry && hist?'intent-archived':'request-recorded',
      routes:r,directory,guard,source,archive,currentWrapper,receiptDigest:receipt?.digest??null,
      intentExternal:Boolean(ext),authorizations,executionAuthorized:false};
    return {...result,digest:contractDigest(result)};
  };
  const first=await observe();if(!equal(first,await observe()))fail('bootstrap-continue.drift');return first;
}

async function persist(filename,value){
  const bytes=Buffer.from(JSON.stringify(value)+'\n');if(bytes.length>MAX_INPUT_BYTES)fail('bootstrap-continue.input-size');
  const h=await open(filename,'wx',0o600);try{await h.writeFile(bytes);await h.sync();}finally{await h.close();}
  if((await readRecord(filename)).digest!==sha256(bytes))fail('bootstrap-continue.readback');
}

// One remaining-action engine. Initial recovery must prove that this process
// owns the existing gate; resumed recovery must prove the recorded owner stopped.
// Both modes still require the kernel lease and revalidate all evidence.
export async function executeBootstrapRecovery({args,lease,current,initialOwner=false}) {
  assertRecoveryLeaseHeld(lease);
  const original=current,r=current.routes,request=await readRecord(path.join(current.directory,'request.json'));
  const boundary=args.ioBoundary??(async()=>{});
  const check=async()=>{
    assertRecoveryLeaseHeld(lease);const next=await inspectBootstrapRecovery({...args,initialDigest:original.initialDigest});
    const owner=await readRecord(path.join(next.directory,'owner.json'));
    const ownerConfirmed=initialOwner?owner.value.pid===process.pid && owner.value.host===hostname():next.ownerStopped;
    if(next.requestDigest!==original.requestDigest || next.ownerDigest!==original.ownerDigest ||
      !equal(rootId(next.guard),rootId(original.guard)) || !ownerConfirmed || !next.originalOwnerStopped ||
      !equal(next,current))fail('bootstrap-continue.drift');
  };
  await check();
  if(!r.retry && current.intentExternal){
    await check();await rename(path.join(r.base,'intent.json'),r.intent);
    current=await inspectBootstrapRecovery({...args,initialDigest:original.initialDigest});await boundary('bootstrap-continuation-intent-archived',current);
  }
  if(current.source){
    await check();await rename(r.base,r.archive);
    current=await inspectBootstrapRecovery({...args,initialDigest:original.initialDigest});await boundary('bootstrap-continuation-lock-archived',current);
  }
  if(!current.receiptDigest){
    await check();await persist(r.receipt,expectedReceipt(original.wrapper,request.value.initial,r));
    current=await inspectBootstrapRecovery({...args,initialDigest:original.initialDigest});await boundary('bootstrap-continuation-receipt-persisted',current);
  }
  await check();await rename(r.gate,r.history);
  current=await inspectBootstrapRecovery({...args,initialDigest:original.initialDigest});await boundary('bootstrap-continuation-gate-archived',current);
  await check();return {status:'bootstrap-recovery-complete',history:r.history,receipt:r.receipt,
    archive:r.archive,requiresRepositoryPreview:true,repositoryEffectsPerformed:false,pipelineActivated:false};
}

export async function finishBootstrapRecovery(args) {
  return withRecoveryLease(args.wrapper,async lease=>{
    let current=await inspectBootstrapRecovery(args);
    if(!equal(args.approval,{decision:'approve',recoveryDigest:current.digest}))fail('bootstrap-continue.stale-approval');
    if(current.status==='complete')return {status:'bootstrap-recovery-complete',history:current.directory,repositoryEffectsPerformed:false,pipelineActivated:false};
    if(!current.ownerStopped || !current.originalOwnerStopped)fail('bootstrap-continue.owner-unconfirmed');
    const original=current,r=current.routes;
    const boundary=args.ioBoundary??(async()=>{});
    const check=async()=>{
      assertRecoveryLeaseHeld(lease);const next=await inspectBootstrapRecovery({...args,initialDigest:original.initialDigest});
      if(next.requestDigest!==original.requestDigest || next.ownerDigest!==original.ownerDigest ||
        !equal(rootId(next.guard),rootId(original.guard)) || !next.ownerStopped || !next.originalOwnerStopped)
        fail('bootstrap-continue.drift');
      if(!equal(next,current))fail('bootstrap-continue.drift');return next;
    };
    await check();if(current.authorizations.length>=64)fail('bootstrap-continue.authorization-limit');
    const authorization={schemaVersion:1,approval:args.approval,observation:current};
    if(current.guard.bytes+Buffer.byteLength(JSON.stringify(authorization))+1>16*1024*1024)
      fail('bootstrap-continue.authorization-limit');
    await persist(path.join(r.gate,'authorization-'+String(current.authorizations.length+1).padStart(4,'0')+'.json'),authorization);
    current=await inspectBootstrapRecovery({...args,initialDigest:original.initialDigest});
    await boundary('bootstrap-continuation-authorized',current);
    await check();return executeBootstrapRecovery({args,lease,current});
  });
}
