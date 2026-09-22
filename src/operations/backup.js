import path from 'node:path';
import { mkdir, open } from 'node:fs/promises';
import { fail, ContractError } from '../contracts/parse.js';
import { portablePath } from '../contracts/semantic.js';
import { sha256, LIMITS, cap } from '../source/inventory.js';
import { resolveChild, inspectDirectory } from '../workspace/paths.js';
import { observeTargets, verifyPreparedSnapshot } from './state.js';
import { assertLockHeld } from './lock.js';

function backupPath(workspace, relative) {
  portablePath(relative);
  if (!relative.startsWith('.pipeline/backups/')) fail('backup.path');
  return resolveChild(workspace,relative);
}

// Read-only exact byte verification; digest refers to the whole containing file,
// not a JSON-field value. Field ownership hashes cannot substitute for this hash.
export async function verifyBackup(workspace, relative, expectedHash) {
  backupPath(workspace,relative);
  if(typeof expectedHash!=='string' || !/^sha256:[a-f0-9]{64}$/.test(expectedHash))fail('backup.hash');
  const [{bytes}]=await observeTargets(workspace,[relative]);
  if(bytes===null)fail('backup.missing');
  if(sha256(bytes)!==expectedHash)fail('backup.mismatch');
  return {path:relative,hash:expectedHash,size:bytes.length};
}

// Internal primitive, not plan authorization. Coordinator must bind relative and
// expectedHash to an approved preview and run full preflight before target writes.
// Copies bytes; no hardlink/shared mutable source. Existing entries are preserved,
// even when mismatching. A torn newly created backup is retained, never auto-repaired.
export async function saveBackup(lock, relative, bytes, expectedHash) {
  await assertLockHeld(lock);
  const filename=backupPath(lock.workspace,relative);
  if(!Buffer.isBuffer(bytes))fail('backup.bytes');
  cap(bytes.length,LIMITS.blob,'backup.size');
  bytes=Buffer.from(bytes);
  if(sha256(bytes)!==expectedHash)fail('backup.hash');
  try {
    const [{bytes:existing}]=await observeTargets(lock.workspace,[relative]);
    if(existing!==null) return {...await verifyBackup(lock.workspace,relative,expectedHash),created:false};
    // Create one inspected parent at a time; never recursive mkdir through a link.
    let parent=lock.workspace;
    for(const part of path.relative(lock.workspace,path.dirname(filename)).split(path.sep)) {
      parent=path.join(parent,part);await assertLockHeld(lock);
      try{await mkdir(parent);}catch(error){if(error.code!=='EEXIST')throw error;}
      await inspectDirectory(parent);
    }
    await assertLockHeld(lock);
    let handle;
    try{handle=await open(filename,'wx',0o600);}
    catch(error){if(error.code==='EEXIST')fail('backup.conflict');throw error;}
    try{await handle.writeFile(bytes);await handle.sync();}
    finally{await handle.close();}
    return {...await verifyBackup(lock.workspace,relative,expectedHash),created:true};
  }catch(error){throw error instanceof ContractError?error:new ContractError('backup.io');}
}

// Install verified file bytes, never copy a tree recursively or link source files.
// No active-state change. A partially populated directory stays unusable until
// verification succeeds; mismatching existing directories are never repaired here.
export async function copySnapshot(lock, prepared) {
  await assertLockHeld(lock);
  const verified=await verifyPreparedSnapshot(prepared);
  const relative='.pipeline/snapshots/'+verified.digest.slice(7);
  const destination=resolveChild(lock.workspace,relative);
  const expected={snapshotPath:destination,manifest:verified.manifest,digest:verified.digest,inventoryDigest:verified.inventoryDigest};
  // Validate the complete resolved path budget before creating snapshot metadata.
  for(const name of verified.files.keys())resolveChild(lock.workspace,relative+'/'+name);
  try {
    if((await inspectDirectory(destination)).exists) {
      await verifyPreparedSnapshot(expected);
      return {path:relative,digest:verified.digest,created:false};
    }
    const parent=resolveChild(lock.workspace,'.pipeline/snapshots');
    await assertLockHeld(lock);
    try{await mkdir(parent);}catch(error){if(error.code!=='EEXIST')throw error;}
    await inspectDirectory(parent);
    try{await mkdir(destination);}catch(error){if(error.code==='EEXIST')fail('snapshot.conflict');throw error;}
    for(const [name,bytes] of verified.files) {
      await assertLockHeld(lock);await inspectDirectory(destination);
      const filename=resolveChild(lock.workspace,relative+'/'+name);
      let directory=destination;
      for(const segment of name.split('/').slice(0,-1)) {
        directory=path.join(directory,segment);
        try{await mkdir(directory);}catch(error){if(error.code!=='EEXIST')throw error;}
        await inspectDirectory(directory);
      }
      const handle=await open(filename,'wx',0o600);
      try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
    }
    await verifyPreparedSnapshot(expected);
    return {path:relative,digest:verified.digest,created:true};
  }catch(error){throw error instanceof ContractError?error:new ContractError('snapshot.copy');}
}
