import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { mkdir, open, readdir, unlink, rmdir, lstat } from 'node:fs/promises';
import { ContractError, fail } from '../contracts/parse.js';
import { absoluteRoot, inspectDirectory, resolveChild } from '../workspace/paths.js';
import { readRecord } from './state.js';
import { sha256 } from '../source/inventory.js';
import { assertNoRepositoryPending,inspectRepositoryPending } from './repository-pending.js';
import { assertBootstrapLockHeld } from './bootstrap-lock.js';
import {assertNoMigrationPending} from './migration-pending.js';
import {assertLegacyUnityLease,legacyUnityLeasePayload} from '../migrations/legacy-unity-lease.js';

const heldLocks = new WeakMap();
const migrationLocks = new WeakMap();
export async function assertMigrationLockHeld(lock,recoveryPath,recoveryHash){
  await assertLockHeld(lock);
  const lease=migrationLocks.get(lock);
  if(!lease)fail('migration.lock-capability');
  const expected=legacyUnityLeasePayload(lease,lock.workspace);
  if(expected.recoveryPath!==recoveryPath||expected.recoveryHash!==recoveryHash)fail('migration.lock-binding');
}
export async function assertLockHeld(lock) {
  const check = lock && heldLocks.get(lock);
  if (!check) fail('lock.capability');
  await check();
}

// Cooperative workspace-local exclusion. Existing/stale locks are never stolen.
// This does not prevent an editor or hostile process from replacing filesystem
// entries; S5 apply must independently recheck each subject before every write.
export async function acquireWorkspaceLock(workspace,{repositoryOperation,migrationOperation}={}) {
  workspace = absoluteRoot(workspace);
  if(repositoryOperation!==undefined&&migrationOperation!==undefined)fail('lock.capability-conflict');
  const guard=async()=>{
    if(migrationOperation!==undefined){
      await assertLegacyUnityLease(migrationOperation,workspace);
      const pending=await inspectRepositoryPending(workspace);
      if(pending.blockers.some(b=>b.code!=='migration.pending'))fail('lock.repository-pending');
    }else if(repositoryOperation!==undefined) {
      // A repository-operation capability does not authorize migration recovery.
      await assertNoMigrationPending(workspace);
      await assertBootstrapLockHeld(repositoryOperation);
      if(repositoryOperation.workspace!==workspace)fail('lock.repository-capability');
    } else await assertNoRepositoryPending(workspace);
  };
  if (!(await inspectDirectory(workspace)).exists) fail('lock.workspace-missing');
  await guard();
  const metadata = resolveChild(workspace, '.pipeline');
  const directory = resolveChild(workspace, '.pipeline/lock');
  const ownerFile = resolveChild(workspace, '.pipeline/lock/owner.json');
  let createdMetadata = null;
  try {
    try { await mkdir(metadata); createdMetadata = await lstat(metadata); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    await inspectDirectory(metadata);
    try { await mkdir(directory); }
    catch (error) { if (error.code === 'EEXIST') fail('lock.busy'); throw error; }
    // Failure after mkdir deliberately leaves a non-acquirable lock for review.
    await inspectDirectory(directory);
    const owner = { schemaVersion: 1, workspace, token: randomUUID(), pid: process.pid,
      host: hostname(), createdAt: new Date().toISOString() };
    const bytes = Buffer.from(JSON.stringify(owner) + '\n');
    const handle = await open(ownerFile, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    const digest = sha256(bytes);
    if ((await readRecord(ownerFile)).digest !== digest) fail('lock.readback');
    await guard();
    let released = false;
    const check = async () => {
      if (released) fail('lock.released');
      await inspectDirectory(directory);
      if ((await readRecord(ownerFile)).digest !== digest) fail('lock.owner-changed');
      await guard();
    };
    const lock = Object.freeze({ workspace, directory, token: owner.token,
      async release({removeEmptyMetadata=false}={}) {
        if (released) fail('lock.released');
        try {
          await inspectDirectory(directory);
          if ((await readRecord(ownerFile)).digest !== digest) fail('lock.owner-changed');
          const entries = await readdir(directory);
          if (entries.length !== 1 || entries[0] !== 'owner.json') fail('lock.foreign-entry');
          await unlink(ownerFile);
          // Non-recursive only: concurrent/foreign files prevent removal.
          await rmdir(directory);
          released = true;
          // Only a failed migration start may remove metadata created by this
          // lock. Never recursively delete, remove pre-existing metadata, or
          // discard a marker/recovery/foreign entry left by an interrupted write.
          if(removeEmptyMetadata && migrationOperation!==undefined && createdMetadata) {
            const current=await lstat(metadata);
            if(current.isDirectory() && !current.isSymbolicLink() &&
                current.dev===createdMetadata.dev && current.ino===createdMetadata.ino) {
              try { await rmdir(metadata); }
              catch(error) { if(!['ENOTEMPTY','EEXIST'].includes(error.code))throw error; }
            }
          }
        } catch (error) {
          throw error instanceof ContractError ? error : new ContractError('lock.release-failed');
        }
      }
    });
    heldLocks.set(lock, check);
    if(migrationOperation!==undefined)migrationLocks.set(lock,migrationOperation);
    return lock;
  } catch (error) {
    throw error instanceof ContractError ? error : new ContractError('lock.io');
  }
}
