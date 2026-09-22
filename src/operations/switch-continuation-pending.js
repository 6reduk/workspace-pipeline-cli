import {open,rename} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {readSwitchContinuationRecovery} from './switch-continuation-recovery.js';
import {verifySwitchContinuationApproval} from './switch-continuation.js';
import {assertLockHeld} from './lock.js';
import {readState,observeTargets} from './state.js';
import {resolveChild,inspectDirectory} from '../workspace/paths.js';
import {validateState,contractDigest} from '../contracts/semantic.js';
import {parse,fail,ContractError} from '../contracts/parse.js';
import {sha256} from '../source/inventory.js';

// Exact selection readback only, not a target-state or execution-readiness check.
export async function inspectSelectedSwitchContinuation(workspace,recoveryPath,recoveryHash) {
  const filename=resolveChild(workspace,'.pipeline/state.json'),before=await readState(filename);
  const evidence=await readSwitchContinuationRecovery(workspace,recoveryPath),record=evidence.record;
  if(evidence.fileHash!==recoveryHash)fail('switch-continuation-pending.evidence');
  const parent=evidence.root;
  const expected={...parent.record.previous,status:'needs-reconciliation',pending:record.digest,runtime:'not-run'};
  if(contractDigest(before.value)!==contractDigest(expected))fail('switch-continuation-pending.selection');
  const repeated=await readSwitchContinuationRecovery(workspace,recoveryPath);
  if(repeated.fileHash!==evidence.fileHash || contractDigest(repeated.journal)!==contractDigest(evidence.journal) ||
      (await readState(filename)).digest!==before.digest)fail('switch-continuation-pending.drift');
  return {status:'needs-reconciliation',pending:record.digest,stateFileHash:before.digest,recoveryPath,
    recoveryHash:evidence.fileHash,journalStatus:evidence.journal.status,executionAllowed:false,runtime:'not-run'};
}

// Select an initialized continuation from the exact old pending state. Neither
// targets nor active deployment are changed; failed writes are never rolled back.
export async function markSwitchContinuationPending(lock,recoveryPath,recoveryHash,approval,{boundary=async()=>{}}={}) {
  approval=parse(JSON.stringify(approval),'json');
  await assertLockHeld(lock);
  const evidence=await readSwitchContinuationRecovery(lock.workspace,recoveryPath),record=evidence.record;
  if(evidence.fileHash!==recoveryHash || evidence.journal.sequence!==1 || evidence.journal.status!==(record.preview.remaining.length?'open':'completed') ||
      contractDigest(record.approval)!==contractDigest(approval))fail('switch-continuation-pending.evidence');
  await verifySwitchContinuationApproval(lock,record.preview,approval);
  const filename=resolveChild(lock.workspace,'.pipeline/state.json'),before=await readState(filename);
  if(before.digest!==record.preview.stateFileHash)fail('switch-continuation-pending.state');
  const pending={...before.value,pending:record.digest};validateState(pending);
  const bytes=Buffer.from(JSON.stringify(pending)+'\n'),scratch='.pipeline/.continuation-state-'+randomUUID()+'.tmp';
  const staged=resolveChild(lock.workspace,scratch);
  try {
    await assertLockHeld(lock);await inspectDirectory(resolveChild(lock.workspace,'.pipeline'));
    const handle=await open(staged,'wx',0o600);
    try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
    await boundary('before-rename',{path:'.pipeline/state.json',stagedPath:scratch});
    await verifySwitchContinuationApproval(lock,record.preview,approval);
    const fresh=await readSwitchContinuationRecovery(lock.workspace,recoveryPath);
    if(fresh.fileHash!==recoveryHash || contractDigest(fresh.journal)!==contractDigest(evidence.journal))
      fail('switch-continuation-pending.evidence');
    const [temp]=await observeTargets(lock.workspace,[scratch]);
    if(temp.bytes===null || sha256(temp.bytes)!==sha256(bytes))fail('switch-continuation-pending.staging');
    await assertLockHeld(lock);
    if((await readState(filename)).digest!==before.digest)fail('switch-continuation-pending.state');
    await rename(staged,filename);
    await boundary('renamed',{path:'.pipeline/state.json'});
    if((await readState(filename)).digest!==sha256(bytes))fail('switch-continuation-pending.readback');
    const result=await inspectSelectedSwitchContinuation(lock.workspace,recoveryPath,recoveryHash);
    await assertLockHeld(lock);return result;
  }catch(error){throw error instanceof ContractError?error:new ContractError('switch-continuation-pending.io');}
}
