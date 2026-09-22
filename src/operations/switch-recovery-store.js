import {mkdir,open} from 'node:fs/promises';
import {verifySwitchApproval} from './switch-preflight.js';
import {createSwitchRecoveryRecord,validateSwitchRecoveryRecord} from './switch-records.js';
import {createSwitchJournal,readSwitchJournal} from './switch-journal-store.js';
import {copySnapshot,saveBackup} from './backup.js';
import {incomingSwitchBackups} from './switch-backups.js';
import {assertLockHeld} from './lock.js';
import {readRecord,observeTargets,verifyPreparedSnapshot,verifyInstalledSnapshot} from './state.js';
import {resolveChild,inspectDirectory} from '../workspace/paths.js';
import {sha256} from '../source/inventory.js';
import {fail,ContractError} from '../contracts/parse.js';

// Read-only structural/durable evidence inspection, not current-target recovery
// or permission to continue. Generic history integration is still pending.
export async function readSwitchRecovery(workspace,relative) {
  const match=typeof relative==='string' && /^\.pipeline\/transactions\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/recovery.json(?![\s\S])/.exec(relative);
  if(!match)fail('switch-recovery.path');
  const stored=await readRecord(resolveChild(workspace,relative)),record=validateSwitchRecoveryRecord(stored.value);
  if(record.previous.workspace!==workspace || record.journal!=='.pipeline/journals/'+match[1])fail('switch-recovery.binding');
  await verifyInstalledSnapshot(record.previous);
  for(const backup of [...record.prepared.removal.backups,...incomingSwitchBackups(record.prepared.preview.phases[1].preview)]) {
    const [observation]=await observeTargets(workspace,[backup.path]);
    if(observation.bytes===null || sha256(observation.bytes)!==backup.hash)fail('switch-recovery.backup');
  }
  const desired=record.prepared.preview.phases[1].preview.plan.desired;
  await verifyPreparedSnapshot({snapshotPath:resolveChild(workspace,record.snapshots.new.path),
    manifest:{id:desired.pipelineId,version:desired.version},digest:record.snapshots.new.digest,inventoryDigest:record.snapshots.new.inventoryDigest});
  const journal=await readSwitchJournal(workspace,record.journal,record.prepared.preview,record.previous);
  if((await readRecord(resolveChild(workspace,relative))).digest!==stored.digest)fail('switch-recovery.drift');
  return {record,fileHash:stored.digest,journal,applySupported:false,runtime:'not-run'};
}

// Persist prerequisites only. Never changes active/pending state or target files.
// Orphan/partial metadata is retained on failure, never retried or cleaned here.
export async function persistSwitchRecovery(lock,prepared,approval,registry,previous,{boundary=async()=>{},onJournal=async()=>{}}={}) {
  const checked=await verifySwitchApproval(lock,prepared,approval,registry,previous);
  const args={prepared:checked.prepared,approval:checked.approval,previous:checked.previous};
  // Bound serialization before any additional metadata write.
  createSwitchRecoveryRecord({...args,journal:'.pipeline/journals/00000000-0000-0000-0000-000000000000'});
  const backups=incomingSwitchBackups(args.prepared.preview.phases[1].preview);
  // Check all existing collisions before saving any new backup. Old backups are
  // immutable; a shared path with different bytes is a blocker, not an overwrite.
  for(const backup of backups) {
    const [current]=await observeTargets(lock.workspace,[backup.path]);
    if(current.bytes!==null && sha256(current.bytes)!==backup.hash)fail('switch-recovery.backup-conflict');
  }
  await copySnapshot(lock,checked.snapshot);
  await boundary('snapshot');
  await verifySwitchApproval(lock,args.prepared,args.approval,registry,args.previous);
  for(const backup of backups)await saveBackup(lock,backup.path,backup.bytes,backup.hash);
  await boundary('backups');
  await verifySwitchApproval(lock,args.prepared,args.approval,registry,args.previous);
  const journal=await createSwitchJournal(lock,args.prepared.preview,args.previous,{onLocation:onJournal});
  const uuid=journal.relative.split('/').at(-1),relative='.pipeline/transactions/'+uuid+'/recovery.json';
  const record=createSwitchRecoveryRecord({...args,journal:journal.relative});
  const bytes=Buffer.from(JSON.stringify(record)+'\n');
  try {
    await assertLockHeld(lock);
    const parent=resolveChild(lock.workspace,'.pipeline/transactions'),directory=resolveChild(lock.workspace,'.pipeline/transactions/'+uuid);
    try{await mkdir(parent);}catch(error){if(error.code!=='EEXIST')throw error;}
    await inspectDirectory(parent);await mkdir(directory);await inspectDirectory(directory);
    const handle=await open(resolveChild(lock.workspace,relative),'wx',0o600);
    try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
    await boundary('recovery-written',{path:relative});
    if((await readRecord(resolveChild(lock.workspace,relative))).digest!==sha256(bytes))fail('switch-recovery.readback');
    await verifySwitchApproval(lock,args.prepared,args.approval,registry,args.previous);
    const evidence=await readSwitchRecovery(lock.workspace,relative);
    if(evidence.journal.sequence!==1 || evidence.journal.status!=='open')fail('switch-recovery.journal');
    await assertLockHeld(lock);
    // No mutable journal writer is returned: no provider operation is authorized.
    return {recoveryPath:relative,recoveryHash:evidence.fileHash,journalPath:journal.relative,
      snapshotPath:record.snapshots.new.path,applySupported:false,runtime:'not-run'};
  }catch(error){throw error instanceof ContractError?error:new ContractError('switch-recovery.io');}
}
