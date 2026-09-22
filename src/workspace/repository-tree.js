import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fail } from '../contracts/parse.js';
import { contractDigest } from '../contracts/semantic.js';
import { runRepositoryGit,parseListing } from '../source/git.js';
import { repositoryBudget } from '../source/repository-budget.js';
import { absoluteRoot,pathBudget } from './paths.js';

// User repository paths are not package paths: Unicode and large assets allowed.
// Keep one portable namespace so a Windows checkout cannot alias another entry.
export function checkRepositoryTreePaths(entries, destination) {
  destination=absoluteRoot(destination);
  if (entries.length>200000) fail('repository-tree.entries');
  const names=new Map();let total=0;
  for (const entry of entries) {
    if (entry.type!=='blob' || !['100644','100755'].includes(entry.mode)) fail('repository-tree.entry-type');
    if (!Number.isSafeInteger(entry.size) || entry.size<0) fail('repository-tree.size');
    total+=entry.size;if(total>100*1024**3)fail('repository-tree.bytes');
    if (typeof entry.path!=='string' || /[\\\u0000-\u001f\u007f<>:"|?*]/u.test(entry.path)) fail('repository-tree.path');
    const parts=entry.path.split('/');
    if(parts.length>128)fail('repository-tree.depth');
    for(let i=0;i<parts.length;i++) {
      const part=parts[i];
      if (!part || part==='.' || part==='..' || /[. ]$/.test(part) ||
        /^\.git$/i.test(part) || /~[0-9]/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)) fail('repository-tree.path');
      const spelling=parts.slice(0,i+1).join('/'),key=spelling.normalize('NFC').toLowerCase();
      const kind=i===parts.length-1?'file':'directory',previous=names.get(key);
      if(previous && (previous.spelling!==spelling || previous.kind!==kind || kind==='file'))fail('repository-tree.collision');
      names.set(key,{spelling,kind});
    }
    pathBudget(path.join(destination,...parts));
  }
  return total;
}

// Read committed objects, never checkout/smudge/filter. Connectivity and exact
// source/staging inventory bindings are supplied by the surrounding preview.
export async function inspectRepositoryTree(repo, commit, destination, requestedBudget = {}) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) fail('repository-tree.commit');
  const budget=repositoryBudget(requestedBudget);
  const options={...budget,deadline:performance.now()+budget.acquisitionMs};
  const entries=parseListing((await runRepositoryGit(repo,['ls-tree','-r','-l','-z','--full-tree',commit],
    {...options,outputLimit:256*1024*1024})).bytes);
  const totalBytes=checkRepositoryTreePaths(entries,destination);
  const seen=new Set();
  for(const entry of entries) {
    // Valid LFS pointers are small. No external LFS client/download is invoked.
    if(entry.size>1024 || seen.has(entry.oid))continue;
    seen.add(entry.oid);
    const bytes=(await runRepositoryGit(repo,['cat-file','blob',entry.oid],{...options,outputLimit:1024})).bytes;
    if(bytes.length!==entry.size)fail('repository-tree.blob-size');
    if(bytes.toString('utf8').startsWith('version https://git-lfs.github.com/spec/v1'))fail('repository-tree.lfs');
  }
  return {commit,entries,totalBytes,digest:contractDigest(entries),
    checkout:'not-performed',filters:'not-run',executionAuthorized:false};
}
