import {mkdir,open,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createSwitchEventCursor} from './switch-journal.js';
import {assertLockHeld} from './lock.js';
import {resolveChild,inspectDirectory} from '../workspace/paths.js';
import {readRecord} from './state.js';
import {sha256} from '../source/inventory.js';
import {fail,ContractError} from '../contracts/parse.js';

const nameFor=n=>String(n).padStart(6,'0')+'.json';
const ioError=e=>e instanceof ContractError?e:new ContractError('switch-journal.io');
function directoryFor(workspace,relative,preview) {
  if(preview.workspace!==workspace || !/^\.pipeline\/journals\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/.test(relative))fail('switch-journal.path');
  return resolveChild(workspace,relative);
}

// Full read-only audit of persisted events; never resumes execution or activates.
export async function readSwitchJournal(workspace,relative,preview,previous) {
  const cursor=createSwitchEventCursor(preview,previous),directory=directoryFor(workspace,relative,preview);
  try {
    await inspectDirectory(directory);
    const names=(await readdir(directory)).sort();
    if(!names.length || names.length>cursor.maxEvents)fail('switch-journal.count');
    let lastFileHash=null;
    for(let seq=0;seq<names.length;seq++) {
      if(names[seq]!==nameFor(seq))fail('switch-journal.sequence');
      const record=await readRecord(resolveChild(workspace,relative+'/'+names[seq]));
      cursor.append(record.value);lastFileHash=record.digest;
    }
    if(JSON.stringify((await readdir(directory)).sort())!==JSON.stringify(names))fail('switch-journal.drift');
    return {...cursor.inspect(),lastFileHash};
  }catch(error){throw ioError(error);}
}

// Internal persistence only. This writes journal evidence, not provider targets.
// No auto-resume/approval or integration with normal recovery is implied.
export async function createSwitchJournal(lock,preview,previous,{ioBoundary=async()=>{},onLocation=async()=>{}}={}) {
  return journalWriter(lock,preview,previous,{ioBoundary,onLocation});
}

// Explicit reopening of an intact open chain only, never uncertain continuation.
export async function openSwitchJournal(lock,preview,previous,relative,expectedFileHash) {
  return journalWriter(lock,preview,previous,{}, {relative,expectedFileHash});
}

async function journalWriter(lock,preview,previous,{ioBoundary=async()=>{},onLocation=async()=>{}}={},existing=null) {
  const cursor=createSwitchEventCursor(preview,previous);
  await assertLockHeld(lock);
  const relative=existing?.relative??'.pipeline/journals/'+randomUUID(),directory=directoryFor(lock.workspace,relative,preview);
  preview=structuredClone(preview);previous=structuredClone(previous);
  let state=cursor.inspect(),lastFileHash=null,busy=false,broken=false;
  const metrics={headReads:0,recordReadbacks:0,fullAudits:0};
  async function audit() {
    metrics.fullAudits++;
    const result=await readSwitchJournal(lock.workspace,relative,preview,previous);
    if(result.sequence!==state.sequence || result.head!==state.head || result.lastFileHash!==lastFileHash)fail('switch-journal.drift');
    return result;
  }
  async function append(kind,payload) {
    if(busy || broken)fail('switch-journal.unavailable');busy=true;
    try {
      await assertLockHeld(lock);await inspectDirectory(directory);
      if(state.sequence) {
        const head=await readRecord(resolveChild(lock.workspace,relative+'/'+nameFor(state.sequence-1)));metrics.headReads++;
        if(head.digest!==lastFileHash)fail('switch-journal.drift');
      }
      const event={schemaVersion:1,seq:state.sequence,previous:state.head,previewDigest:preview.digest,kind,payload};
      // Validate before disk writes. A later IO failure poisons this writer.
      const next=cursor.append(event),bytes=Buffer.from(JSON.stringify(event)+'\n');
      const detail={path:relative+'/'+nameFor(state.sequence)};
      const handle=await open(resolveChild(lock.workspace,detail.path),'wx',0o600);
      try {
        await ioBoundary('opened',detail);await handle.writeFile(bytes);await ioBoundary('written',detail);
        await handle.sync();await ioBoundary('synced',detail);
      }finally{await handle.close();}
      const record=await readRecord(resolveChild(lock.workspace,detail.path));metrics.recordReadbacks++;
      if(record.digest!==sha256(bytes))fail('switch-journal.readback');
      await ioBoundary('readback',detail);
      state=next;lastFileHash=record.digest;
      // Full audit at both phase boundaries (before allowing install) and stop.
      if(kind==='phase-checked' || ['failed','uncertain'].includes(payload?.status))await audit();
      return {...state,pending:state.pending?{...state.pending}:null,lastFileHash};
    }catch(error){broken=true;throw ioError(error);}finally{busy=false;}
  }
  try {
    if(existing) {
      const inspected=await readSwitchJournal(lock.workspace,relative,preview,previous);
      if(inspected.status!=='open' || inspected.lastFileHash!==existing.expectedFileHash)fail('switch-journal.reopen');
      for(let seq=0;seq<inspected.sequence;seq++) {
        const entry=await readRecord(resolveChild(lock.workspace,relative+'/'+nameFor(seq)));
        state=cursor.append(entry.value);lastFileHash=entry.digest;
      }
      if(state.head!==inspected.head || state.sequence!==inspected.sequence)fail('switch-journal.drift');
      await audit();
    }else {
    await onLocation({relative,directory,status:'planned'});
    const parent=resolveChild(lock.workspace,'.pipeline/journals');
    try{await mkdir(parent);}catch(error){if(error.code!=='EEXIST')throw error;}
    await inspectDirectory(parent);await mkdir(directory);
    await onLocation({relative,directory,status:'created'});
    await append('start',null);await audit();
    await onLocation({relative,directory,status:'initialized'});
    }
    return Object.freeze({relative,directory,metrics:()=>({...metrics}),
      intent:(phase,operationId)=>append('intent',{phase,operationId}),
      outcome:(phase,operationId,status,observedHash)=>append('outcome',{phase,operationId,status,observedHash}),
      phaseChecked:(phase,projectionDigest)=>append('phase-checked',{phase,projectionDigest})});
  }catch(error){throw ioError(error);}
}
