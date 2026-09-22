import { mkdir,open,readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fail,ContractError } from '../contracts/parse.js';
import { contractDigest } from '../contracts/semantic.js';
import { resolveChild,inspectDirectory } from '../workspace/paths.js';
import { sha256 } from '../source/inventory.js';
import { readRecord } from './state.js';
import { assertLockHeld } from './lock.js';

const exact=(o,keys)=>o!==null && typeof o==='object' && !Array.isArray(o) && Object.keys(o).sort().join(',')===[...keys].sort().join(',');
const hash=s=>typeof s==='string' && /^sha256:[a-f0-9]{64}$/.test(s);
const file=seq=>String(seq).padStart(6,'0')+'.json';
function bound(preview) {
  if (!preview || preview.kind!=='repository-preview-candidate' || !hash(preview.digest) ||
    !Array.isArray(preview.operations) || !preview.operations.length || preview.operations.length>128)fail('repository-journal.preview');
  const {digest,...body}=preview;
  if(contractDigest(body)!==digest)fail('repository-journal.preview');
  const ids=new Set();
  for(const op of preview.operations) {
    if(!op || typeof op.repository!=='string' || ids.has(op.repository))fail('repository-journal.preview');
    ids.add(op.repository);
  }
}
function advance(state,kind,payload,preview) {
  const op=preview.operations[state.nextIndex];
  if(kind==='authorization') {
    if(state.sequence!==1 || state.authorization!==null || state.pending!==null ||
      !exact(payload,['path','digest']) || !hash(payload.digest) ||
      !/^\.pipeline\/repository-authorizations\/[a-f0-9-]{36}\.json$/.test(payload.path))fail('repository-journal.authorization');
    return {...state,authorization:payload};
  }
  if(kind==='intent') {
    if(state.pending!==null || state.stopped || !op ||
      !exact(payload,['repository','operationDigest']) || payload.repository!==op.repository || payload.operationDigest!==contractDigest(op))
      fail('repository-journal.sequence');
    return {...state,pending:state.nextIndex};
  }
  if(kind!=='outcome' || state.pending===null || !exact(payload,['status','evidenceDigest']) ||
    !['completed','failed','uncertain'].includes(payload.status) ||
    !(hash(payload.evidenceDigest) || (payload.status==='uncertain' && payload.evidenceDigest===null)))fail('repository-journal.outcome');
  return {...state,pending:null,nextIndex:state.nextIndex+1,stopped:payload.status!=='completed',outcomes:[...state.outcomes,payload]};
}
const initial=()=>({sequence:0,lastHash:null,nextIndex:0,pending:null,stopped:false,outcomes:[],authorization:null});
function result(state,preview) {
  const terminal=state.stopped || state.nextIndex===preview.operations.length;
  return {...state,phase:state.pending!==null?'interrupted':terminal?'terminal':'open',
    operations:preview.operations.map((op,i)=>({repository:op.repository,
      ...(state.outcomes[i] ?? {status:state.pending===i?'uncertain':'skipped',evidenceDigest:null})})),
    // Outcomes are executor claims with evidence references, not self-proving PASS.
    evidenceVerified:false};
}

export async function readRepositoryJournal(workspace,relative,preview) {
  bound(preview);
  if(workspace!==preview.wrapper || !/^\.pipeline\/repository-journals\/[a-f0-9-]{36}$/.test(relative))fail('repository-journal.path');
  const directory=resolveChild(workspace,relative);
  try {
    await inspectDirectory(directory);const names=(await readdir(directory)).sort();
    if(!names.length || names.length>2+2*preview.operations.length)fail('repository-journal.sequence');
    let state=initial();
    for(let seq=0;seq<names.length;seq++) {
      if(names[seq]!==file(seq))fail('repository-journal.sequence');
      const record=await readRecord(resolveChild(workspace,relative+'/'+file(seq))),event=record.value;
      if(!exact(event,['schemaVersion','seq','previous','previewDigest','kind','payload']) || event.schemaVersion!==1 ||
        event.seq!==seq || event.previous!==state.lastHash || event.previewDigest!==preview.digest)fail('repository-journal.binding');
      if(seq===0) {if(event.kind!=='start' || event.payload!==null)fail('repository-journal.sequence');}
      else {
        if(event.kind==='authorization' && event.payload?.path!==relative.replace('/repository-journals/','/repository-authorizations/')+'.json')
          fail('repository-journal.authorization');
        state=advance(state,event.kind,event.payload,preview);
      }
      state={...state,sequence:seq+1,lastHash:record.digest};
    }
    return result(state,preview);
  }catch(error){throw error instanceof ContractError?error:new ContractError('repository-journal.io');}
}

// Same intent/outcome hash-chain protocol as S5, separate namespace because
// repository operations are not file replacement plans. No repository IO here.
export async function createRepositoryJournal(lock,preview,{onLocation=async()=>{},ioBoundary=async()=>{}}={}) {
  bound(preview);await assertLockHeld(lock);
  if(preview.wrapper!==lock.workspace || preview.status!=='review-only' || preview.blockers.length)fail('repository-journal.preview');
  preview=structuredClone(preview);
  const relative='.pipeline/repository-journals/'+randomUUID(),directory=resolveChild(lock.workspace,relative);
  let state=initial(),busy=false,broken=false;
  const persist=async(kind,payload,next)=>{
    await assertLockHeld(lock);await inspectDirectory(directory);
    const filename=resolveChild(lock.workspace,relative+'/'+file(state.sequence));
    const bytes=Buffer.from(JSON.stringify({schemaVersion:1,seq:state.sequence,previous:state.lastHash,previewDigest:preview.digest,kind,payload})+'\n');
    const handle=await open(filename,'wx',0o600);
    try {await ioBoundary('opened',{filename});await handle.writeFile(bytes);await handle.sync();await ioBoundary('synced',{filename});}
    finally {await handle.close();}
    const record=await readRecord(filename);if(record.digest!==sha256(bytes))fail('repository-journal.readback');
    state={...next,sequence:state.sequence+1,lastHash:record.digest};
  };
  try {
    await onLocation({directory,relative,status:'planned'});
    const parent=resolveChild(lock.workspace,'.pipeline/repository-journals');
    try{await mkdir(parent);}catch(e){if(e.code!=='EEXIST')throw e;}
    await inspectDirectory(parent);await mkdir(directory);
    await persist('start',null,state);
    await onLocation({directory,relative,status:'initialized'});
    async function append(kind,payload) {
      if(busy || broken)fail('repository-journal.unavailable');busy=true;
      try {
        await assertLockHeld(lock);
        const head=await readRecord(resolveChild(lock.workspace,relative+'/'+file(state.sequence-1)));
        if(head.digest!==state.lastHash)fail('repository-journal.drift');
        const next=advance(state,kind,payload,preview);await persist(kind,payload,next);
        if(state.stopped || state.nextIndex===preview.operations.length) {
          const audited=await readRepositoryJournal(lock.workspace,relative,preview);
          if(audited.lastHash!==state.lastHash || audited.sequence!==state.sequence)fail('repository-journal.drift');
          return audited;
        }
        return result(state,preview);
      }catch(e){broken=true;throw e instanceof ContractError?e:new ContractError('repository-journal.io');}
      finally{busy=false;}
    }
    return Object.freeze({relative,directory,
      authorize:binding=>{
        if(binding?.path!==relative.replace('/repository-journals/','/repository-authorizations/')+'.json')fail('repository-journal.authorization');
        return append('authorization',binding);
      },
      intent:repository=>append('intent',{repository,operationDigest:contractDigest(preview.operations.find(op=>op.repository===repository) ?? null)}),
      outcome:(status,evidenceDigest)=>append('outcome',{status,evidenceDigest})});
  }catch(e){const error=e instanceof ContractError?e:new ContractError('repository-journal.io');error.repositoryJournal=relative;throw error;}
}
