import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { fail, parse } from '../contracts/parse.js';
import { contractDigest } from '../contracts/semantic.js';
import { validateSource, runRepositoryGit, acquireRemoteRepository } from '../source/git.js';
import {repositoryBudget} from '../source/repository-budget.js';
import {performance} from 'node:perf_hooks';
import { absoluteRoot, inspectDirectory } from './paths.js';
import { planRepositoryIntents } from './repositories.js';
import { inventoryRepository } from './repository-inventory.js';
import {summarizeInventory,summarizeTree} from './repository-observation.js';
import { inspectRepositoryGit, inspectRepositoryDestination } from './repository-preflight.js';
import { inspectRepositoryTree } from './repository-tree.js';
import { readRecord } from '../operations/state.js';

async function manifestEvidence(workspace, options) {
  if (!options.manifestPath) return null; // Internal domain-only callers, never execution-ready.
  const filename=absoluteRoot(options.manifestPath), extension=path.extname(filename).toLowerCase();
  if (!['.json','.yaml','.yml'].includes(extension)) fail('manifest.format');
  const record=await readRecord(filename,extension==='.json'?'json':'yaml');
  if (contractDigest(record.value)!==contractDigest(workspace)) fail('repositories.manifest-mismatch');
  const base=path.dirname(record.path);
  if (options.manifestBase && absoluteRoot(options.manifestBase)!==base) fail('repositories.manifest-base');
  return {path:record.path,base,bytesDigest:record.digest};
}

// User repositories are NOT S2 pipeline packages: no pipeline manifest/8 MiB
// blob limit or supplier code is used to resolve their commit.
export async function bindLocalRepositorySource(source, manifestBase, options={}) {
  const budget=repositoryBudget(options),deadline=performance.now()+budget.acquisitionMs;
  validateSource(source);
  if (source.subdirectory !== '.') fail('repositories.clone-subdirectory');
  if (source.transport !== 'local') fail('repositories.local-source-required');
  const base = absoluteRoot(manifestBase);
  if (!(await inspectDirectory(base)).exists) fail('repositories.manifest-base');
  const root = path.resolve(base,source.path);
  const observed = await inspectRepositoryGit(root,budget);
  if (observed.blockers.length) fail('repositories.clone-source-blocked');
  const isOid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.ref);
  const refs = isOid || source.ref === 'HEAD' || source.ref.startsWith('refs/')
    ? [source.ref] : ['refs/heads/'+source.ref,'refs/tags/'+source.ref];
  const found = [];
  for (const ref of refs) {
    const result = await runRepositoryGit(root,['--git-dir='+path.join(root,'.git'),'--work-tree='+root,
      'rev-parse','--verify','--quiet','--end-of-options',ref+'^{commit}'],{...budget,deadline,allowMissing:true});
    if (result.code === 0) {
      const commit = result.bytes.toString('utf8').trim();
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) fail('repositories.clone-ref-output');
      found.push(commit);
    }
  }
  if (found.length > 1) fail('repositories.clone-ambiguous-ref');
  if (!found.length) fail('repositories.clone-missing-ref');
  if (isOid && found[0] !== source.ref) fail('repositories.clone-not-commit');
  if ((await inventoryRepository(root)).digest !== observed.inventory.digest) fail('repositories.drift');
  return { source:structuredClone(source),manifestBase:base,resolvedSource:root,commit:found[0],...budget,
    sourceObservation:observed,checkout:'commit-only',uncommittedSourceFiles:'not-cloned' };
}

// Internal read-only candidate. No approval parser/executor may treat this as
// authorization. Portable saved-preview schema and executable approval are pending.
export async function prepareRepositoryPreview(pipeline, workspace, wrapper, choices, options = {}) {
  return prepare(pipeline,workspace,wrapper,choices,options);
}

async function preparedRemoteBinding(binding, source, preparationRoot, options) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) fail('repositories.saved-binding');
  const keys=['source','resolvedSource','preparation','repo','commit','packLimit','gitMs','acquisitionMs','history','checkout','executionAuthorized','preparedInventory'];
  const budget=repositoryBudget(options),deadline=performance.now()+budget.acquisitionMs;
  if (Object.keys(binding).sort().join(',')!==keys.sort().join(',')) fail('repositories.saved-binding');
  const preparation=absoluteRoot(binding.preparation), repo=absoluteRoot(binding.repo);
  if (path.dirname(preparation)!==preparationRoot || !/^wpc-repository-[A-Za-z0-9_-]+$/.test(path.basename(preparation)) ||
    repo!==path.join(preparation,'objects.git') || binding.resolvedSource!==source.url ||
    contractDigest(binding.source)!==contractDigest(source) ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(binding.commit) ||
    Object.keys(budget).some(k=>binding[k]!==budget[k]) || binding.history!=='shallow-depth-1' ||
    binding.checkout!=='not-performed' || binding.executionAuthorized!==false) fail('repositories.saved-binding');
  const inventory=await inventoryRepository(repo);
  if (contractDigest(summarizeInventory(inventory))!==contractDigest(binding.preparedInventory)) fail('repositories.preparation-drift');
  await runRepositoryGit(repo,['cat-file','-e',binding.commit+'^{commit}'],{...budget,deadline});
  await runRepositoryGit(repo,['fsck','--connectivity-only','--no-reflogs','--no-progress'],{...budget,deadline});
  if ((await inventoryRepository(repo)).digest!==inventory.digest) fail('repositories.preparation-drift');
  return structuredClone(binding);
}

async function prepare(pipeline, workspace, wrapper, choices, options, savedBindings) {
  const manifest=await manifestEvidence(workspace,options);
  options={...options,...(manifest?{manifestBase:manifest.base}:{})};
  const intents = planRepositoryIntents(pipeline,workspace,wrapper,choices,options);
  const wrapperState=await inspectDirectory(intents.wrapper);
  const wrapperStat=wrapperState.exists?await lstat(intents.wrapper,{bigint:true}):null;
  const wrapperObservation=wrapperStat
    ? {action:'keep',path:intents.wrapper,identity:{dev:String(wrapperStat.dev),ino:String(wrapperStat.ino)}}
    : {action:'create',...(await inspectRepositoryDestination(intents.wrapper))};
  let preparationRoot;
  if (intents.operations.some(o=>o.action==='clone' && o.source.transport==='remote')) {
    if (!savedBindings && options.network !== true) fail('source.network-required');
    preparationRoot = absoluteRoot(options.tempRoot);
    if (!(await inspectDirectory(preparationRoot)).exists) fail('repository-source.temp-root');
    const protectedRoots = [intents.wrapper,...intents.operations.filter(o=>o.from).map(o=>o.from),
      ...intents.operations.filter(o=>o.action==='clone' && o.source.transport==='local')
        .map(o=>path.resolve(absoluteRoot(options.manifestBase),o.source.path))];
    for (const root of protectedRoots) {
      const relative=path.relative(root.toLowerCase(),preparationRoot.toLowerCase());
      if (relative==='' || (!path.isAbsolute(relative) && relative!=='..' && !relative.startsWith('..'+path.sep)))
        fail('repository-source.preparation-location');
    }
  }
  const operations = [], blockers = [];
  if(!wrapperState.exists && wrapperObservation.ancestor!==path.dirname(intents.wrapper))
    blockers.push({repository:null,code:'repositories.wrapper-parent-missing'});
  for (const intent of intents.operations) {
    const operation = {...intent};
    if (intent.action === 'keep') operation.existing = await inspectRepositoryGit(intent.target);
    else operation.destination = await inspectRepositoryDestination(intent.target);
    if(operation.destination &&
      (wrapperState.exists ? operation.destination.ancestor!==path.dirname(intent.target) : path.dirname(intent.target)!==intents.wrapper))
      blockers.push({repository:intent.repository,code:'repositories.target-parent-missing'});
    if (intent.action === 'move') {
      operation.existing = await inspectRepositoryGit(intent.from);
      if (operation.existing.inventory.entries[0].identity.dev !== operation.destination.ancestorIdentity.dev)
        blockers.push({repository:intent.repository,code:'repositories.cross-device-not-supported'});
    }
    if (operation.existing)
      for (const code of operation.existing.blockers) blockers.push({repository:intent.repository,code});
    if (intent.action === 'clone') {
      if (intent.source.transport==='local') operation.binding = await bindLocalRepositorySource(intent.source,options.manifestBase,options);
      else {
        if (savedBindings) operation.binding=await preparedRemoteBinding(savedBindings.get(intent.repository),intent.source,preparationRoot,options);
        else {
          const prepared = await acquireRemoteRepository(intent.source,{tempRoot:preparationRoot,network:options.network,...repositoryBudget(options)});
          operation.binding = {...prepared,preparedInventory:await inventoryRepository(prepared.repo)};
        }
      }
      operation.checkoutTree=await inspectRepositoryTree(operation.binding.repo ?? operation.binding.resolvedSource,
        operation.binding.commit,intent.target,operation.binding);
    }
    operation.compensation = intent.action === 'keep' ? 'none' : 'fresh-preview-required; no automatic deletion or rollback';
    operations.push(operation);
  }
  // A multi-repository scan may take time: validate every earlier observation
  // again before returning. This is still not an atomic filesystem snapshot.
  for (const operation of operations) {
    const observation = operation.existing ?? operation.binding?.sourceObservation;
    if (observation && (await inventoryRepository(observation.inventory.root)).digest !== observation.inventory.digest)
      fail('repositories.drift');
    if (operation.binding?.preparedInventory &&
      (await inventoryRepository(operation.binding.repo)).digest !== operation.binding.preparedInventory.digest)
      fail('repositories.preparation-drift');
    if (operation.destination && contractDigest(await inspectRepositoryDestination(operation.target)) !== contractDigest(operation.destination))
      fail('repositories.destination-drift');
  }
  if (contractDigest(await manifestEvidence(workspace,options))!==contractDigest(manifest)) fail('repositories.manifest-drift');
  const finalWrapper=await inspectDirectory(intents.wrapper);
  if(finalWrapper.exists!==wrapperState.exists)fail('repositories.wrapper-drift');
  if(finalWrapper.exists) {
    const stat=await lstat(intents.wrapper,{bigint:true});
    if(String(stat.dev)!==wrapperObservation.identity.dev || String(stat.ino)!==wrapperObservation.identity.ino)
      fail('repositories.wrapper-drift');
  } else if(contractDigest({action:'create',...(await inspectRepositoryDestination(intents.wrapper))})!==contractDigest(wrapperObservation))
    fail('repositories.wrapper-drift');
  for(const op of operations) {
    if(op.existing)op.existing.inventory=summarizeInventory(op.existing.inventory);
    if(op.binding?.sourceObservation)op.binding.sourceObservation.inventory=summarizeInventory(op.binding.sourceObservation.inventory);
    if(op.binding?.preparedInventory)op.binding.preparedInventory=summarizeInventory(op.binding.preparedInventory);
    if(op.checkoutTree)op.checkoutTree=summarizeTree(op.checkoutTree);
  }
  const result = {kind:'repository-preview-candidate',command:intents.command,wrapper:intents.wrapper,wrapperObservation,manifest,
    inputDigest:contractDigest({pipeline,workspace,choices}),layout:intents.layout,
    operations,blockers,status:blockers.length?'blocked':'review-only',executionAuthorized:false};
  return {...result,digest:contractDigest(result)};
}

// Caller supplies independently retained/approved digest and current trusted
// inputs. A digest copied from the loaded file itself is NOT an approval.
// Reconstructs semantics from inputs and observations, rejects extra/missing
// fields through whole-object equality, and never reacquires remote sources.
export async function revalidateRepositoryPreview(text, expectedDigest, pipeline, workspace, wrapper, choices, options = {}) {
  if (!/^sha256:[a-f0-9]{64}$/.test(expectedDigest ?? '')) fail('repositories.expected-digest');
  const saved=parse(text,'json');
  if (!saved || typeof saved!=='object' || Array.isArray(saved)) fail('repositories.saved-preview');
  const {digest,...body}=saved;
  if (digest!==expectedDigest || contractDigest(body)!==expectedDigest) fail('repositories.preview-digest');
  if (saved.kind!=='repository-preview-candidate' || saved.executionAuthorized!==false ||
    !Array.isArray(saved.operations)) fail('repositories.saved-preview');
  const bindings=new Map();
  for (const operation of saved.operations) {
    if (!operation || typeof operation!=='object' || typeof operation.repository!=='string' || bindings.has(operation.repository))
      fail('repositories.saved-preview');
    bindings.set(operation.repository,operation.binding);
  }
  const fresh=await prepare(pipeline,workspace,wrapper,choices,{...options,network:false},bindings);
  if (contractDigest(fresh)!==contractDigest(saved)) fail('repositories.preview-drift');
  if (fresh.blockers.length || fresh.status!=='review-only') fail('repositories.preview-blocked');
  return fresh;
}
