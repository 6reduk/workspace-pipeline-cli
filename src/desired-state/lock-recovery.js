import path from 'node:path';
import {homedir,hostname} from 'node:os';
import {randomUUID} from 'node:crypto';
import {readdir,rename,unlink,rmdir} from 'node:fs/promises';
import {fail,parse} from '../contracts/parse.js';
import {contractDigest} from '../contracts/semantic.js';
import {absoluteRoot,inspectDirectory} from '../workspace/paths.js';
import {observeTargets} from '../operations/state.js';
import {assertNoRepositoryPending} from '../operations/repository-pending.js';
import {withRecoveryLease,assertRecoveryLeaseHeld} from '../operations/recovery-lease.js';
import {sha256,utf8} from '../source/inventory.js';
import {readDesiredRecords} from './records.js';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function liveness(owner) {
  if(owner.host!==hostname())return 'unknown-host';
  try{process.kill(owner.pid,0);return 'live-or-reused-pid';}
  catch(e){return e.code==='ESRCH'?'local-pid-absent':'unknown';}
}
function location(workspace,{global=false,userHome=homedir()}={}) {
  if(typeof global!=='boolean')fail('desired.recovery-options');
  const root=global?absoluteRoot(userHome):workspace;
  return {root,relative:global?'.grok/.wpc-config-lock':'.pipeline/lock',
    filename:global?'owner':'owner.json',purpose:global?'desired-global-settings':'desired-state'};
}
async function ownerAt(loc,relative,workspace) {
  const directory=path.join(loc.root,...relative.split('/'));
  if(!(await inspectDirectory(directory)).exists)return null;
  const names=await readdir(directory);
  if(names.length!==1||names[0]!==loc.filename)fail('desired.recovery-foreign-entry');
  const [observed]=await observeTargets(loc.root,[relative+'/'+loc.filename]);
  if(observed.bytes===null)fail('desired.recovery-owner-missing');
  const owner=parse(utf8(observed.bytes),'json');
  if(!owner || Object.keys(owner).sort().join(',')!=='createdAt,host,pid,purpose,schemaVersion,token,workspace' ||
      owner.schemaVersion!==1||owner.purpose!==loc.purpose||owner.workspace!==workspace||!uuid.test(owner.token??'')||
      !Number.isSafeInteger(owner.pid)||owner.pid<=0||typeof owner.host!=='string'||
      typeof owner.createdAt!=='string'||!Number.isFinite(Date.parse(owner.createdAt)))fail('desired.recovery-owner-invalid');
  return {owner,hash:sha256(observed.bytes),liveness:liveness(owner)};
}

// Read-only: age alone never authorizes release, and signal 0 does not kill.
export async function inspectDesiredLock(workspace,options={}) {
  workspace=absoluteRoot(workspace);const loc=location(workspace,options);
  await assertNoRepositoryPending(workspace);
  const records=await readDesiredRecords(workspace);
  const state={installed:records.installed?.hash??null,pending:records.pending?.hash??null};
  const lock=await ownerAt(loc,loc.relative,workspace);
  const result={workspace,global:options.global===true,path:path.join(loc.root,...loc.relative.split('/')),state,
    status:lock===null?'absent':lock.liveness==='local-pid-absent'?'stopped-owner-observed':'owner-unconfirmed',lock};
  return {...result,digest:contractDigest(result)};
}

// The existing OS lease serializes recoverers, without another stale lockfile.
// Rename the exact stale directory atomically; never delete/reuse its old path
// after rename, since a fresh cooperative writer may immediately acquire it.
export async function recoverDesiredLock(workspace,expected,options={}) {
  workspace=absoluteRoot(workspace);const loc=location(workspace,options);
  return withRecoveryLease(loc.root,async lease=>{
    let current=await inspectDesiredLock(workspace,options);
    if(current.digest!==expected.digest)fail('desired.recovery-observation-changed');
    if(current.status==='absent')return {status:'no-lock',workspace,global:options.global===true};
    if(current.status!=='stopped-owner-observed')fail('desired.recovery-owner-unconfirmed');
    current=await inspectDesiredLock(workspace,options);
    if(current.digest!==expected.digest)fail('desired.recovery-observation-changed');
    assertRecoveryLeaseHeld(lease);
    const relative=loc.relative+'-retiring-'+randomUUID(),temporary=path.join(loc.root,...relative.split('/'));
    await rename(current.path,temporary);
    try {
      const saved=await ownerAt(loc,relative,workspace);
      if(!saved || saved.hash!==current.lock.hash)fail('desired.recovery-retired-mismatch');
      assertRecoveryLeaseHeld(lease);
      await unlink(path.join(temporary,loc.filename));
      await rmdir(temporary); // Never recursively remove unexpected children.
    }catch(error){error.recovery={lockReleased:true,residualPath:temporary};throw error;}
    return {status:'lock-retired',workspace,global:options.global===true,
      next:'Inspect doctor, then explicitly retry reset or remove; operation records and configuration were not changed.'};
  });
}
