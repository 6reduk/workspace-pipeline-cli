import {open,rename} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {readSwitchRecovery} from './switch-recovery-store.js';
import {verifySwitchApproval} from './switch-preflight.js';
import {assertLockHeld} from './lock.js';
import {readState,observeTargets} from './state.js';
import {resolveChild,inspectDirectory} from '../workspace/paths.js';
import {validateState} from '../contracts/semantic.js';
import {parse,fail,ContractError} from '../contracts/parse.js';
import {sha256} from '../source/inventory.js';

// Internal state transition only. The caller supplies genuine current approval.
// No provider writes, phase execution, automatic retry or active-state promotion.
export async function markSwitchPending(lock,recoveryPath,recoveryHash,approval,registry,{boundary=async()=>{}}={}) {
  await assertLockHeld(lock);
  const evidence=await readSwitchRecovery(lock.workspace,recoveryPath),record=evidence.record;
  if(evidence.fileHash!==recoveryHash || evidence.journal.sequence!==1 || evidence.journal.status!=='open')fail('switch-pending.evidence');
  await verifySwitchApproval(lock,record.prepared,approval,registry,record.previous);
  // Bind this exact transaction, not just equal desired bytes or equal preview.
  // The record digest includes its UUID journal identity.
  const pending={...record.previous,status:'needs-reconciliation',pending:record.digest,runtime:'not-run'};
  validateState(pending);
  const bytes=Buffer.from(JSON.stringify(parse(JSON.stringify(pending),'json'))+'\n');
  const relative='.pipeline/state.json',scratch='.pipeline/.switch-state-'+randomUUID()+'.tmp';
  const filename=resolveChild(lock.workspace,relative),staged=resolveChild(lock.workspace,scratch);
  try {
    await assertLockHeld(lock);await inspectDirectory(resolveChild(lock.workspace,'.pipeline'));
    const handle=await open(staged,'wx',0o600);
    try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
    await boundary('before-rename',{path:relative,stagedPath:scratch});
    await verifySwitchApproval(lock,record.prepared,approval,registry,record.previous);
    const fresh=await readSwitchRecovery(lock.workspace,recoveryPath);
    if(fresh.fileHash!==recoveryHash || fresh.journal.sequence!==1 || fresh.journal.head!==evidence.journal.head)fail('switch-pending.evidence');
    const [temp]=await observeTargets(lock.workspace,[scratch]);
    if(temp.bytes===null || sha256(temp.bytes)!==sha256(bytes))fail('switch-pending.staging');
    await assertLockHeld(lock);
    if((await readState(filename)).digest!==record.prepared.stateFileHash)fail('switch-pending.state-drift');
    await rename(staged,filename);
    await boundary('renamed',{path:relative});
    if((await readState(filename)).digest!==sha256(bytes))fail('switch-pending.readback');
    return {status:'needs-reconciliation',pending:record.digest,stateFileHash:sha256(bytes),recoveryPath,applySupported:false,runtime:'not-run'};
  }catch(error){throw error instanceof ContractError?error:new ContractError('switch-pending.io');}
}
