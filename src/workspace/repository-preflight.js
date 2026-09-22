import path from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fail, ContractError } from '../contracts/parse.js';
import { performance } from 'node:perf_hooks';
import { runRepositoryGit } from '../source/git.js';
import { repositoryBudget } from '../source/repository-budget.js';
import { sha256 } from '../source/inventory.js';
import { absoluteRoot, inspectDirectory } from './paths.js';
import { inventoryRepository } from './repository-inventory.js';

// Refuse occupied destinations, even empty directories. No overwrite/merge implied.
export async function inspectRepositoryDestination(directory) {
  const target = absoluteRoot(directory);
  try {
    if ((await inspectDirectory(target)).exists) fail('repositories.destination-exists');
    let ancestor = path.dirname(target);
    while (!(await inspectDirectory(ancestor)).exists) ancestor = path.dirname(ancestor);
    const stat = await lstat(ancestor,{bigint:true});
    return {target,exists:false,ancestor,ancestorIdentity:{dev:String(stat.dev),ino:String(stat.ino)},
      executionAuthorized:false};
  } catch (error) {
    throw error instanceof ContractError ? error : new ContractError(error.code==='EBUSY'?'repositories.busy':
      ['EACCES','EPERM'].includes(error.code)?'repositories.access-denied':'repositories.destination-io');
  }
}

// Conservative local metadata screening. Passing this is NOT Git health, full
// relocatability, lock availability or an executable preview. Unknown config blocks.
export async function inspectRepositoryMetadata(directory, requestedBudget = {}) {
  const budget=repositoryBudget(requestedBudget);
  const options={...budget,deadline:requestedBudget.deadline ?? performance.now()+budget.acquisitionMs};
  const inventory = await inventoryRepository(directory);
  const entries = new Map(inventory.entries.map(entry=>[entry.path,entry]));
  const blockers = [];
  const block = code => { if (!blockers.includes(code)) blockers.push(code); };
  if (entries.get('.git')?.type !== 'directory') block('git.embedded-directory-required');
  for (const entry of inventory.entries) {
    const name = entry.path.toLowerCase();
    if (name.endsWith('/.git') && name !== '.git') block('git.nested-repository');
    if (name === '.gitmodules' || name.endsWith('/.gitmodules') || name.startsWith('.git/modules/')) block('git.submodules');
    if (name === '.git/commondir' || name === '.git/gitdir' || name === '.git/worktrees' || name.startsWith('.git/worktrees/')) block('git.linked-worktrees');
    if (name === '.git/objects/info/alternates' || name === '.git/objects/info/http-alternates') block('git.external-objects');
    if (name.startsWith('.git/') && name.endsWith('.lock')) block('git.lock-present');
    if (name === '.git/config.worktree') block('git.worktree-config');
    if (['.git/merge_head','.git/cherry_pick_head','.git/revert_head','.git/bisect_start',
      '.git/rebase-merge','.git/rebase-apply','.git/sequencer'].includes(name)) block('git.operation-pending');
    if (name.startsWith('.git/hooks/') && entry.type === 'file' && !name.endsWith('.sample')) block('git.active-hooks');
  }
  const config = entries.get('.git/config');
  if (config?.type !== 'file') block('git.config-missing');
  // Only read embedded config once shape is safe. --no-includes avoids reading
  // arbitrary include paths. Native Git parses quoting and continuation lines.
  if (!blockers.length) {
    const filename = path.join(inventory.root,'.git','config');
    const verify = async () => {
      await inspectDirectory(path.dirname(filename));
      const stat = await lstat(filename,{bigint:true});
      if (!stat.isFile() || String(stat.ino)!==config.identity.ino || String(stat.dev)!==config.identity.dev || stat.nlink!==1n)
        fail('repositories.drift');
      if ('sha256' in config && createHash('sha256').update(await readFile(filename)).digest('hex')!==config.sha256)
        fail('repositories.drift');
    };
    await verify();
    const output = (await runRepositoryGit(inventory.root,['--git-dir='+path.dirname(filename),
      '--work-tree='+inventory.root,'config','--file',filename,'--no-includes','--null','--list'],options)).bytes.toString('utf8');
    await verify();
    for (const record of output.split('\0').filter(Boolean)) {
      const split=record.indexOf('\n'), key=(split<0?record:record.slice(0,split)).toLowerCase();
      const value=split<0?'':record.slice(split+1);
      if (/^core\.(repositoryformatversion|filemode|logallrefupdates|symlinks|ignorecase|autocrlf|safecrlf|eol|protectntfs|protecthfs)$/.test(key)) continue;
      if (key==='core.bare' && value==='false') continue;
      if (key==='extensions.objectformat' && ['sha1','sha256'].includes(value)) continue;
      if (/^(user\.(name|email)|remote\.[^.]+\.fetch|branch\.[^.]+\.(remote|merge))$/.test(key)) continue;
      if (/^remote\.[^.]+\.(url|pushurl)$/.test(key) && /^(https:\/\/|ssh:\/\/|[^\s/:]+@[^\s/:]+:)/.test(value)) continue;
      block('git.config-requires-review');
    }
  }
  // Config parse must not replace evidence with a later state unnoticed.
  const after = await inventoryRepository(inventory.root);
  if (after.digest !== inventory.digest) fail('repositories.drift');
  return {inventory,blockers,status:blockers.length?'blocked':'metadata-screened',
    gitHealth:'not-verified',executionAuthorized:false};
}

// Native, read-only local structure checks. Dirty state is evidence, not a
// rejection. Still not move authorization or certification of relocated behavior.
export async function inspectRepositoryGit(directory, requestedBudget = {}) {
  const budget=repositoryBudget(requestedBudget);
  const execution={...budget,deadline:requestedBudget.deadline ?? performance.now()+budget.acquisitionMs};
  const screened = await inspectRepositoryMetadata(directory,execution);
  if (screened.blockers.length) return screened;
  const root = screened.inventory.root;
  const prefix = ['--git-dir='+path.join(root,'.git'),'--work-tree='+root];
  const git = (args, options) => runRepositoryGit(root,[...prefix,...args],{...execution,...options});
  const text = async args => (await git(args)).bytes.toString('utf8').trim();
  const format = await text(['rev-parse','--show-object-format=storage']);
  if (!['sha1','sha256'].includes(format)) fail('repositories.git-format');
  const oid = value => new RegExp('^[a-f0-9]{'+(format==='sha1'?40:64)+'}$').test(value);
  const headResult = await git(['rev-parse','--verify','--quiet','HEAD'],{allowMissing:true});
  let head = headResult.code === 0 ? headResult.bytes.toString('utf8').trim() : null;
  if (head !== null && !oid(head)) fail('repositories.git-head');
  if (head === null) {
    // Missing HEAD is allowed only as an unborn local branch, not detached damage.
    const branch = await text(['symbolic-ref','HEAD']);
    if (!branch.startsWith('refs/heads/')) fail('repositories.git-head');
    const ref = await git(['show-ref','--verify','--quiet',branch],{allowMissing:true});
    if (ref.code !== 1) fail('repositories.git-head');
  } else await git(['cat-file','-e',head+'^{commit}']);
  const index = (await git(['ls-files','--stage','-z'],{outputLimit:256*1024*1024})).bytes;
  const blockers = [];
  for (const record of index.toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(\d{6}) ([a-f0-9]+) ([0-3])\t/.exec(record);
    if (!match || !oid(match[2])) fail('repositories.git-index');
    if (match[1]==='160000') blockers.push('git.submodules');
    if (match[3]!=='0') blockers.push('git.unmerged-index');
  }
  // No --lost-found or other repair/write mode. Repository transport budget only.
  await git(['fsck','--connectivity-only','--no-reflogs','--no-progress']);
  const status = (await git(['status','--porcelain=v1','-z','--untracked-files=all','--ignore-submodules=all'],
    {outputLimit:256*1024*1024})).bytes;
  const after = await inventoryRepository(root);
  if (after.digest !== screened.inventory.digest) fail('repositories.drift');
  return {...screened,blockers:[...new Set(blockers)],status:blockers.length?'blocked':'git-inspected',
    gitHealth:'local-connectivity-checked',head,objectFormat:format,
    indexDigest:sha256(index),statusDigest:sha256(status),dirty:status.length!==0,
    // Raw file names/status are intentionally not included in diagnostics.
    executionAuthorized:false};
}
