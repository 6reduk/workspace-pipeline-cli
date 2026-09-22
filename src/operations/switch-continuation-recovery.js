import {mkdir,open} from 'node:fs/promises';
import {createSwitchContinuationRecoveryRecord,validateSwitchContinuationRecoveryRecord,assertSwitchContinuationPredecessor} from './switch-continuation-records.js';
import {createSwitchContinuationJournal,readSwitchContinuationJournal} from './switch-continuation-store.js';
import {verifySwitchContinuationApproval} from './switch-continuation.js';
import {readSwitchRecovery} from './switch-recovery-store.js';
import {readRecord} from './state.js';
import {assertLockHeld} from './lock.js';
import {resolveChild,inspectDirectory} from '../workspace/paths.js';
import {contractDigest} from '../contracts/semantic.js';
import {sha256} from '../source/inventory.js';
import {fail,ContractError} from '../contracts/parse.js';
import {MAX_CONTINUATION_DEPTH} from './lineage-guard.js';

function checkPath(relative) {
  const match=typeof relative==='string' && /^\.pipeline\/transactions\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/recovery.json(?![\s\S])/.exec(relative);
  if(!match)fail('switch-continuation-recovery.path');
  return match[1];
}

// Two bounded iterative passes, not recursively repeated ancestry reads.
// Shared continuation limit plus the original switch; over-limit is fail-closed.
async function readChain(workspace,relative) {
  const chain=[],seen=new Set();
  while(true) {
    const id=checkPath(relative);
    if(seen.has(relative))fail('switch-continuation-recovery.cycle');
    if(chain.length>MAX_CONTINUATION_DEPTH)fail('switch-continuation-recovery.depth');
    seen.add(relative);
    const stored=await readRecord(resolveChild(workspace,relative));
    if(stored.value?.kind==='switch-recovery') {
      const root=await readSwitchRecovery(workspace,relative);
      if(root.fileHash!==stored.digest)fail('switch-continuation-recovery.drift');
      chain.push({relative,...root});break;
    }
    const record=validateSwitchContinuationRecoveryRecord(stored.value);
    if(record.preview.workspace!==workspace || record.journal!=='.pipeline/journals/'+id)
      fail('switch-continuation-recovery.binding');
    const journal=await readSwitchContinuationJournal(workspace,record.journal,record.preview);
    chain.push({relative,record,fileHash:stored.digest,journal});
    relative=record.preview.recoveryPath;
  }
  for(let i=chain.length-2;i>=0;i--)assertSwitchContinuationPredecessor(chain[i].record.preview,chain[i+1]);
  return chain;
}

export async function readSwitchLineage(workspace,relative) {
  const before=await readChain(workspace,relative),after=await readChain(workspace,relative);
  const binding=chain=>chain.map(e=>({relative:e.relative,fileHash:e.fileHash,journal:e.journal}));
  if(contractDigest(binding(before))!==contractDigest(binding(after)))fail('switch-continuation-recovery.drift');
  return {...after[0],root:after.at(-1),ancestors:after.slice(1),applySupported:false,runtime:'not-run'};
}

// Historical evidence audit, not current-target approval or active-chain selection.
export async function readSwitchContinuationRecovery(workspace,relative) {
  const evidence=await readSwitchLineage(workspace,relative);
  if(evidence.record.kind!=='switch-continuation-recovery')fail('switch-continuation-recovery.binding');
  return evidence;
}

// Persist prerequisites only. Partial evidence remains on failure. No mutable
// journal writer is returned and no targets or active/pending state are changed.
export async function persistSwitchContinuationRecovery(lock,preview,approval,{boundary=async()=>{},onJournal=async()=>{}}={}) {
  const checked=await verifySwitchContinuationApproval(lock,preview,approval);
  // Bound the whole envelope before writing. A different placeholder UUID avoids
  // accidentally selecting the predecessor as the destination.
  const placeholders=['00000000-0000-0000-0000-000000000000','00000000-0000-0000-0000-000000000001'];
  const placeholder=placeholders.map(id=>'.pipeline/journals/'+id).find(p=>p!==checked.preview.predecessor.journal);
  createSwitchContinuationRecoveryRecord({...checked,journal:placeholder});
  const journal=await createSwitchContinuationJournal(lock,checked.preview,checked.approval,{onLocation:onJournal});
  const uuid=journal.relative.split('/').at(-1),relative='.pipeline/transactions/'+uuid+'/recovery.json';
  const record=createSwitchContinuationRecoveryRecord({...checked,journal:journal.relative});
  const bytes=Buffer.from(JSON.stringify(record)+'\n');
  try {
    await verifySwitchContinuationApproval(lock,checked.preview,checked.approval);
    const parent=resolveChild(lock.workspace,'.pipeline/transactions'),directory=resolveChild(lock.workspace,'.pipeline/transactions/'+uuid);
    try{await mkdir(parent);}catch(error){if(error.code!=='EEXIST')throw error;}
    await inspectDirectory(parent);await mkdir(directory);await inspectDirectory(directory);
    const handle=await open(resolveChild(lock.workspace,relative),'wx',0o600);
    try {
      await boundary('opened',{path:relative});await handle.writeFile(bytes);await handle.sync();
    }finally{await handle.close();}
    await boundary('recovery-written',{path:relative});
    if((await readRecord(resolveChild(lock.workspace,relative))).digest!==sha256(bytes))fail('switch-continuation-recovery.readback');
    await verifySwitchContinuationApproval(lock,checked.preview,checked.approval);
    const evidence=await readSwitchContinuationRecovery(lock.workspace,relative);
    if(evidence.journal.sequence!==1 || evidence.journal.status!==(record.preview.remaining.length?'open':'completed'))fail('switch-continuation-recovery.journal');
    await assertLockHeld(lock);
    return {recoveryPath:relative,recoveryHash:evidence.fileHash,journalPath:record.journal,
      applySupported:false,runtime:'not-run'};
  }catch(error){throw error instanceof ContractError?error:new ContractError('switch-continuation-recovery.io');}
}
