import {mkdir,open,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createSwitchContinuationCursor} from './switch-continuation-journal.js';
import {verifySwitchContinuationApproval} from './switch-continuation.js';
import {assertLockHeld} from './lock.js';
import {resolveChild,inspectDirectory} from '../workspace/paths.js';
import {readRecord} from './state.js';
import {sha256} from '../source/inventory.js';
import {fail,ContractError} from '../contracts/parse.js';

const nameFor=n=>String(n).padStart(6,'0')+'.json';
const ioError=e=>e instanceof ContractError?e:new ContractError('switch-continuation-store.io');
function directoryFor(workspace,relative,preview) {
  if(preview.workspace!==workspace || typeof relative!=='string' ||
      !/^\.pipeline\/journals\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/.test(relative) ||
      relative===preview.predecessor.journal)fail('switch-continuation-store.path');
  return resolveChild(workspace,relative);
}

// Audit events only; caller supplies the verified preview. No history resolution
// or proof of provider writes is inferred from a valid event stream.
export async function readSwitchContinuationJournal(workspace,relative,preview) {
  const cursor=createSwitchContinuationCursor(preview),directory=directoryFor(workspace,relative,preview);
  try {
    await inspectDirectory(directory);
    const names=(await readdir(directory)).sort();
    if(!names.length || names.length>cursor.maxEvents)fail('switch-continuation-store.count');
    let lastFileHash=null;
    for(let seq=0;seq<names.length;seq++) {
      if(names[seq]!==nameFor(seq))fail('switch-continuation-store.sequence');
      const record=await readRecord(resolveChild(workspace,relative+'/'+names[seq]));
      cursor.append(record.value);lastFileHash=record.digest;
    }
    if(JSON.stringify((await readdir(directory)).sort())!==JSON.stringify(names))fail('switch-continuation-store.drift');
    return {...cursor.inspect(),lastFileHash};
  }catch(error){throw ioError(error);}
}

// Internal evidence writer only. No target writes or pending-state transition.
// New chain only: no reopen, retry or automatic deletion of partial evidence.
export async function createSwitchContinuationJournal(lock,preview,approval,{ioBoundary=async()=>{},onLocation=async()=>{}}={}) {
  return continuationWriter(lock,preview,approval,{ioBoundary,onLocation});
}

// Reopen only a fully audited open chain with an exact byte head. Selection and
// target checks belong to the executor; uncertain/failed chains never reopen.
export async function openSwitchContinuationJournal(lock,preview,relative,expectedFileHash) {
  return continuationWriter(lock,preview,null,{}, {relative,expectedFileHash});
}

async function continuationWriter(lock,preview,approval,{ioBoundary=async()=>{},onLocation=async()=>{}}={},existing=null) {
  if(existing) {preview=structuredClone(preview);await assertLockHeld(lock);}
  else {
    const checked=await verifySwitchContinuationApproval(lock,preview,approval);
    preview=checked.preview;approval=checked.approval;
  }
  const cursor=createSwitchContinuationCursor(preview),relative=existing?.relative??'.pipeline/journals/'+randomUUID();
  const directory=directoryFor(lock.workspace,relative,preview);
  let state=cursor.inspect(),lastFileHash=null,busy=false,broken=false;
  const metrics={headReads:0,recordReadbacks:0,fullAudits:0};
  async function audit() {
    metrics.fullAudits++;
    const result=await readSwitchContinuationJournal(lock.workspace,relative,preview);
    if(result.sequence!==state.sequence || result.head!==state.head || result.lastFileHash!==lastFileHash)
      fail('switch-continuation-store.drift');
  }
  async function append(kind,payload) {
    if(busy || broken)fail('switch-continuation-store.unavailable');busy=true;
    try {
      await assertLockHeld(lock);await inspectDirectory(directory);
      if(state.sequence) {
        const record=await readRecord(resolveChild(lock.workspace,relative+'/'+nameFor(state.sequence-1)));metrics.headReads++;
        if(record.digest!==lastFileHash)fail('switch-continuation-store.drift');
      }
      const event={schemaVersion:1,seq:state.sequence,previous:state.head,previewDigest:preview.digest,kind,payload};
      const next=cursor.append(event),bytes=Buffer.from(JSON.stringify(event)+'\n');
      const detail={path:relative+'/'+nameFor(state.sequence)};
      const handle=await open(resolveChild(lock.workspace,detail.path),'wx',0o600);
      try {
        await ioBoundary('opened',detail);await handle.writeFile(bytes);await ioBoundary('written',detail);
        await handle.sync();await ioBoundary('synced',detail);
      }finally{await handle.close();}
      const record=await readRecord(resolveChild(lock.workspace,detail.path));metrics.recordReadbacks++;
      if(record.digest!==sha256(bytes))fail('switch-continuation-store.readback');
      await ioBoundary('readback',detail);
      await assertLockHeld(lock);
      state=next;lastFileHash=record.digest;
      if(kind==='phase-checked' || ['failed','uncertain'].includes(payload?.status))await audit();
      return {...state,pending:state.pending?{...state.pending}:null,lastFileHash};
    }catch(error){broken=true;throw ioError(error);}finally{busy=false;}
  }
  try {
    if(existing) {
      const inspected=await readSwitchContinuationJournal(lock.workspace,relative,preview);
      if(inspected.status!=='open' || inspected.lastFileHash!==existing.expectedFileHash)fail('switch-continuation-store.reopen');
      for(let seq=0;seq<inspected.sequence;seq++) {
        const entry=await readRecord(resolveChild(lock.workspace,relative+'/'+nameFor(seq)));
        state=cursor.append(entry.value);lastFileHash=entry.digest;
      }
      if(state.head!==inspected.head || state.sequence!==inspected.sequence)fail('switch-continuation-store.drift');
      await audit();await assertLockHeld(lock);
    }else {
    await onLocation({relative,directory,status:'planned'});
    await verifySwitchContinuationApproval(lock,preview,approval);
    const parent=resolveChild(lock.workspace,'.pipeline/journals');
    try{await mkdir(parent);}catch(error){if(error.code!=='EEXIST')throw error;}
    await inspectDirectory(parent);await mkdir(directory);
    await onLocation({relative,directory,status:'created'});
    await verifySwitchContinuationApproval(lock,preview,approval);
    await append('start',preview.predecessor);await audit();
    await onLocation({relative,directory,status:'initialized'});
    await verifySwitchContinuationApproval(lock,preview,approval);
    }
    return Object.freeze({relative,directory,metrics:()=>({...metrics}),
      intent:(phase,operationId)=>append('intent',{phase,operationId}),
      outcome:(phase,operationId,status,observedHash)=>append('outcome',{phase,operationId,status,observedHash}),
      readback:(phase,operationId,status,observedHash)=>append('readback',{phase,operationId,status,observedHash}),
      phaseChecked:(phase,projectionDigest)=>append('phase-checked',{phase,projectionDigest})});
  }catch(error){broken=true;throw ioError(error);}
}
