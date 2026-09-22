import { mkdir, open, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fail, ContractError } from '../contracts/parse.js';
import { validateOperation, validateReceiptForPlan, contractDigest } from '../contracts/semantic.js';
import { resolveChild, inspectDirectory } from '../workspace/paths.js';
import { readRecord } from './state.js';
import { assertLockHeld } from './lock.js';
import { sha256 } from '../source/inventory.js';

const nameFor = seq => String(seq).padStart(6, '0') + '.json';
const exact = (record, keys) => record !== null && typeof record === 'object' &&
  Object.keys(record).sort().join(',') === [...keys].sort().join(',');

function assertOutcome(target,payload) {
  if(!exact(payload,['status','observedHash']) || !['completed','failed','uncertain'].includes(payload.status))fail('journal.sequence');
  if((payload.status==='completed' && payload.observedHash!==target.desiredHash) ||
      (payload.status==='failed' && payload.observedHash!==target.beforeHash) ||
      (payload.observedHash!==null && !/^sha256:[a-f0-9]{64}$/.test(payload.observedHash)))fail('journal.outcome');
}

function receipt(plan, previous, outcomes, pending) {
  if (pending !== null) outcomes = [...outcomes, {status:'uncertain',observedHash:null}];
  const operations = plan.targets.map((target, i) => ({operationId:target.id,
    beforeHash:target.beforeHash,desiredHash:target.desiredHash,
    ...(outcomes[i] ?? {status:'skipped',observedHash:null})}));
  const status = operations.every(op=>op.status==='completed') ? 'completed' :
    operations.some(op=>op.status==='uncertain') ? 'uncertain' : 'failed';
  return validateReceiptForPlan({schemaVersion:1,kind:'receipt',planDigest:contractDigest(plan),status,operations},plan,previous);
}

// Read-only interpretation of persisted evidence. No rollback, continuation or
// ready-state activation. An intent without outcome is uncertain, not failed.
export async function readJournal(workspace, relative, plan, previous) {
  validateOperation(plan,previous);
  if(plan.kind!=='plan')fail('journal.plan');
  if (plan.workspace !== workspace || !/^\.pipeline\/journals\/[a-f0-9-]{36}$/.test(relative)) fail('journal.path');
  const directory = resolveChild(workspace,relative);
  try {
    await inspectDirectory(directory);
    const names = (await readdir(directory)).sort();
    if (!names.length || names.length > 1+2*plan.targets.length) fail('journal.sequence');
    let chain=null, pending=null, stopped=false; const outcomes=[],planDigest=contractDigest(plan);
    for (let seq=0;seq<names.length;seq++) {
      if(names[seq]!==nameFor(seq)) fail('journal.sequence');
      const record=await readRecord(resolveChild(workspace,relative+'/'+names[seq]));
      const event=record.value;
      if(!exact(event,['schemaVersion','seq','previous','planDigest','kind','payload']) || event.schemaVersion!==1 ||
          event.seq!==seq || event.previous!==chain || event.planDigest!==planDigest) fail('journal.binding');
      if(seq===0) {
        if(event.kind!=='start' || event.payload!==null)fail('journal.sequence');
      } else if(event.kind==='intent') {
        if(pending!==null || outcomes.length>=plan.targets.length || stopped ||
          !exact(event.payload,['operationId']) || event.payload.operationId!==plan.targets[outcomes.length].id) fail('journal.sequence');
        pending=outcomes.length;
      } else if(event.kind==='outcome') {
        if(pending===null)fail('journal.sequence');
        assertOutcome(plan.targets[pending],event.payload);
        outcomes.push(event.payload);pending=null;stopped=event.payload.status!=='completed';
      } else fail('journal.sequence');
      chain=record.digest;
    }
    const terminal=outcomes.length===plan.targets.length || stopped;
    return {sequence:names.length,lastHash:chain,nextIndex:outcomes.length,pending,
      phase:pending!==null?'interrupted':terminal?'terminal':'open',
      receipt:terminal || pending!==null ? receipt(plan,previous,outcomes,pending) : null};
  } catch(error) {throw error instanceof ContractError ? error : new ContractError('journal.io');}
}

export async function createJournal(lock, plan, previous=null, {ioBoundary=async()=>{},onLocation=async()=>{}}={}) {
  validateOperation(plan,previous);
  if(plan.kind!=='plan')fail('journal.plan');
  await assertLockHeld(lock);
  if(plan.workspace!==lock.workspace) fail('journal.workspace');
  plan=structuredClone(plan);previous=structuredClone(previous);
  const relative='.pipeline/journals/'+randomUUID();
  const parent=resolveChild(lock.workspace,'.pipeline/journals'), directory=resolveChild(lock.workspace,relative);
  const planDigest=contractDigest(plan),metrics={headReads:0,recordReadbacks:0,fullAudits:0};
  async function persist(event) {
    await assertLockHeld(lock);await inspectDirectory(directory);
    const filename=resolveChild(lock.workspace,relative+'/'+nameFor(event.seq));
    const detail={path:relative+'/'+nameFor(event.seq),stagedPath:relative+'/'+nameFor(event.seq)};
    const bytes=Buffer.from(JSON.stringify(event)+'\n'),handle=await open(filename,'wx',0o600);
    try {
      await ioBoundary('opened',detail);
      await handle.writeFile(bytes);await ioBoundary('written',detail);
      await handle.sync();await ioBoundary('synced',detail);
    }
    finally {await handle.close();}
    const record=await readRecord(filename);metrics.recordReadbacks++;
    if(record.digest!==sha256(bytes))fail('journal.readback');
    await ioBoundary('readback',detail);
    return record.digest;
  }
  async function audit(){metrics.fullAudits++;return readJournal(lock.workspace,relative,plan,previous);}
  try {
    await onLocation({relative,directory,status:'planned'});
    try {await mkdir(parent);}catch(error){if(error.code!=='EEXIST')throw error;}
    await inspectDirectory(parent);await mkdir(directory);
    await onLocation({relative,directory,status:'created'});
    await persist({schemaVersion:1,seq:0,previous:null,planDigest,kind:'start',payload:null});
    let state=await audit(), busy=false, broken=false;
    await onLocation({relative,directory,status:'initialized'});
    async function append(kind,payload) {
      if(busy || broken)fail('journal.unavailable');
      busy=true;
      try {
        await assertLockHeld(lock);
        // Constant-size append verification. Older history is fully audited on
        // terminal outcome and by readJournal (including apply's activation gate).
        // A changed historical prefix may be detected at that later gate, not at
        // the next append. This is not protection against hostile OS access.
        const head=await readRecord(resolveChild(lock.workspace,relative+'/'+nameFor(state.sequence-1)));metrics.headReads++;
        if(head.digest!==state.lastHash)fail('journal.drift');
        const current=state;
        if(kind==='intent') {
          if(current.phase!=='open' || payload.operationId!==plan.targets[current.nextIndex]?.id)fail('journal.sequence');
        } else {
          if(current.pending===null)fail('journal.sequence');
          assertOutcome(plan.targets[current.pending],payload);
        }
        const lastHash=await persist({schemaVersion:1,seq:state.sequence,previous:state.lastHash,planDigest,kind,payload});
        const nextIndex=state.nextIndex+(kind==='outcome'?1:0),pending=kind==='intent'?state.nextIndex:null;
        const terminal=nextIndex===plan.targets.length || (kind==='outcome' && payload.status!=='completed');
        state={sequence:state.sequence+1,lastHash,nextIndex,pending,phase:pending!==null?'interrupted':terminal?'terminal':'open',receipt:null};
        if(terminal) {
          const verified=await audit();
          if(verified.sequence!==state.sequence || verified.lastHash!==state.lastHash || verified.nextIndex!==state.nextIndex ||
              verified.pending!==state.pending || verified.phase!==state.phase)fail('journal.drift');
          state=verified;
        }
        // Nonterminal append results are compact observations, not receipts.
        // Recovery reconstructs uncertainty using the full read-only reader.
        return structuredClone(state);
      }catch(error){broken=true;throw error instanceof ContractError?error:new ContractError('journal.io');}
      finally{busy=false;}
    }
    return Object.freeze({relative,directory,
      metrics:()=>({...metrics}),
      intent: operationId=>append('intent',{operationId}),
      outcome: (status,observedHash)=>append('outcome',{status,observedHash})});
  }catch(error){throw error instanceof ContractError?error:new ContractError('journal.io');}
}
