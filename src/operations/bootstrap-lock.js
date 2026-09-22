import path from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { lstat,mkdir,open,readdir,unlink,rmdir } from 'node:fs/promises';
import { fail,ContractError } from '../contracts/parse.js';
import { sha256 } from '../source/inventory.js';
import { absoluteRoot,inspectDirectory,pathBudget } from '../workspace/paths.js';
import { readRecord } from './state.js';

const held=new WeakMap();
const identity=s=>String(s.dev)+':'+String(s.ino);
export function bootstrapLockDirectory(workspace) {
  workspace=absoluteRoot(workspace);pathBudget(workspace);
  if(path.dirname(workspace)===workspace)fail('bootstrap-lock.root');
  const directory=path.join(path.dirname(workspace),'.wpc-bootstrap-'+sha256(workspace.toLowerCase()).slice(7));
  pathBudget(directory);return directory;
}
export async function assertNoBootstrapRecovery(workspace) {
  for(const suffix of ['.recovery','.recovery-resume']) {
    try {await lstat(bootstrapLockDirectory(workspace)+suffix);}
    catch(e){if(e.code==='ENOENT')continue;throw e;}
    fail('bootstrap-lock.recovery-pending');
  }
}
export async function assertBootstrapLockHeld(lock) {
  const check=lock && held.get(lock);
  if(!check)fail('bootstrap-lock.capability');
  await check();
}

// Init/adopt exclusion before wrapper exists. Requires an existing direct parent;
// ancestor creation must have its own approved bootstrap sequence, never recursive
// mkdir here. Keep held through handoff to the ordinary S5 workspace lock.
export async function acquireBootstrapLock(workspace,{onLocation=async()=>{},ioBoundary=async()=>{}}={}) {
  workspace=absoluteRoot(workspace);pathBudget(workspace);
  const parent=path.dirname(workspace);
  if(parent===workspace)fail('bootstrap-lock.root');
  await inspectDirectory(workspace);
  if(!(await inspectDirectory(parent)).exists)fail('bootstrap-lock.parent-missing');
  const parentId=identity(await lstat(parent,{bigint:true}));
  const directory=bootstrapLockDirectory(workspace);
  pathBudget(directory);
  const ownerFile=path.join(directory,'owner.json');
  let created=false;
  try {
    await assertNoBootstrapRecovery(workspace);
    await onLocation({workspace,directory,status:'planned'});
    await inspectDirectory(parent);
    if(identity(await lstat(parent,{bigint:true}))!==parentId)fail('bootstrap-lock.parent-drift');
    try {await mkdir(directory,{mode:0o700});created=true;}
    catch(error){if(error.code==='EEXIST')fail('bootstrap-lock.busy');throw error;}
    await ioBoundary('directory-created',{directory});
    await inspectDirectory(directory);
    const directoryId=identity(await lstat(directory,{bigint:true}));
    const owner={schemaVersion:1,workspace,token:randomUUID(),pid:process.pid,host:hostname(),createdAt:new Date().toISOString()};
    const bytes=Buffer.from(JSON.stringify(owner)+'\n'),digest=sha256(bytes);
    const handle=await open(ownerFile,'wx',0o600);
    try {await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
    if((await readRecord(ownerFile)).digest!==digest)fail('bootstrap-lock.readback');
    await assertNoBootstrapRecovery(workspace);
    let released=false;
    const check=async()=>{
      if(released)fail('bootstrap-lock.released');
      await inspectDirectory(directory);
      if(identity(await lstat(parent,{bigint:true}))!==parentId || identity(await lstat(directory,{bigint:true}))!==directoryId)
        fail('bootstrap-lock.identity');
      if((await readRecord(ownerFile)).digest!==digest)fail('bootstrap-lock.owner-changed');
    };
    const lock=Object.freeze({workspace,directory,token:owner.token,
      async release() {
        try {
          await check();
          const names=await readdir(directory);
          if(names.length!==1 || names[0]!=='owner.json')fail('bootstrap-lock.foreign-entry');
          await unlink(ownerFile);await rmdir(directory);released=true;
        }catch(error){throw error instanceof ContractError?error:new ContractError('bootstrap-lock.release-failed');}
      }});
    held.set(lock,check);
    await onLocation({workspace,directory,status:'held'});
    return lock;
  }catch(cause){
    const error=cause instanceof ContractError?cause:new ContractError('bootstrap-lock.io');
    // No rollback of an incomplete/unknown owner record. Location enables review.
    if(created)error.bootstrapDirectory=directory;
    throw error;
  }
}
