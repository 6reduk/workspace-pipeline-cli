import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fail } from '../contracts/parse.js';
import { contractDigest } from '../contracts/semantic.js';
import { performance } from 'node:perf_hooks';
import { runGit, runRepositoryGit } from '../source/git.js';
import { repositoryBudget } from '../source/repository-budget.js';
import { summarizeTree } from '../workspace/repository-observation.js';
import { inventoryRepository } from '../workspace/repository-inventory.js';
import { inspectRepositoryGit } from '../workspace/repository-preflight.js';
import { inspectRepositoryTree } from '../workspace/repository-tree.js';
import { assertLockHeld } from './lock.js';
import { assertBootstrapLockHeld } from './bootstrap-lock.js';

const policy={head:'detached',history:'depth-1',origin:'not-configured',templates:'disabled'};
export async function verifyClonedRepository(op,observed) {
  if(contractDigest(op.clonePolicy)!==contractDigest(policy))fail('repository-clone.policy');
  // Conservative config screening precedes native status; arbitrary local filter
  // configuration cannot be executed just because a saved receipt says completed.
  const git=await inspectRepositoryGit(op.target,op.binding);
  if(git.blockers.length || git.head!==op.binding.commit || git.dirty || git.inventory.digest!==observed.digest)return false;
  const tree=await inspectRepositoryTree(op.target,op.binding.commit,op.target,op.binding);
  if(contractDigest(op.checkoutTree?.kind==='repository-tree-summary'?summarizeTree(tree):tree)!==contractDigest(op.checkoutTree))return false;
  const expected=new Set(tree.entries.map(e=>e.path));
  const actual=observed.entries.filter(e=>e.type==='file' && !e.path.startsWith('.git/'));
  if(actual.length!==expected.size || actual.some(e=>!expected.has(e.path)))return false;
  // No origin is silently assigned to a temporary staging directory.
  const remotes=await runGit(op.target,['remote']);
  return remotes.bytes.length===0;
}

// Journal intent and destination precheck belong to the caller. Local transport
// only; no clone hardlinks/shared object database and no account/network access.
export async function materializeRepositoryClone(op,lock,bootstrap,ioBoundary) {
  if(contractDigest(op.clonePolicy)!==contractDigest(policy))fail('repository-clone.policy');
  const budget=repositoryBudget(op.binding), deadline=performance.now()+budget.acquisitionMs;
  const execute=(args,options={})=>runRepositoryGit(op.target,args,{...budget,deadline,...options});
  const source=op.binding.repo ?? op.binding.resolvedSource;
  const before=op.binding.preparedInventory ?? op.binding.sourceObservation.inventory;
  const guard=async()=>{
    await assertLockHeld(lock);await assertBootstrapLockHeld(bootstrap);
    if((await inventoryRepository(source)).digest!==before.digest)fail('repository-clone.source-drift');
  };
  await guard();await mkdir(op.target);
  await ioBoundary('clone-directory-created',{repository:op.repository});
  await guard();
  if((await inventoryRepository(op.target)).entries.length!==1)fail('repository-clone.target-drift');
  await execute(['init','--template=','--object-format='+(op.binding.commit.length===64?'sha256':'sha1')]);
  await guard();
  await execute(['-c','protocol.allow=never','-c','protocol.file.allow=always',
    '-c','fetch.unpackLimit=0','-c','transfer.unpackLimit=0','fetch','--depth=1','--no-tags',
    '--no-recurse-submodules','--no-auto-maintenance','--no-write-fetch-head','--keep','--',source,op.binding.commit],
    {objects:path.join(op.target,'.git','objects')});
  await ioBoundary('clone-fetched',{repository:op.repository});
  await guard();
  const staged=await inventoryRepository(op.target);
  if(staged.entries.some(e=>e.path!=='.' && e.path!=='.git' && !e.path.startsWith('.git/')))fail('repository-clone.target-drift');
  // Metadata whitelist before checkout, not just after it.
  const {inspectRepositoryMetadata}=await import('../workspace/repository-preflight.js');
  if((await inspectRepositoryMetadata(op.target,{...budget,deadline})).blockers.length)fail('repository-clone.metadata');
  await execute(['-c','core.autocrlf=false','-c','core.attributesFile=/dev/null','checkout','--detach',op.binding.commit]);
  await guard();
}
