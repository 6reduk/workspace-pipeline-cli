import path from 'node:path';
import { open, lstat, realpath, opendir } from 'node:fs/promises';
import { parse, fail, ContractError, MAX_INPUT_BYTES } from '../contracts/parse.js';
import { validateStructure } from '../contracts/validate.js';
import { validateState, contractDigest } from '../contracts/semantic.js';
import { validateSource } from '../source/git.js';
import { sha256, utf8, verifyPackage, LIMITS, cap } from '../source/inventory.js';
import { absoluteRoot, inspectDirectory, resolveChild } from '../workspace/paths.js';
import {installedSelection,resolveProviders} from '../providers/bundles.js';

// Verify the installed bytes, not merely the source identity in state. This is
// an observation for preview; apply must recheck it under the S5 transaction.
// No original manifest/source lookup or Git/network activity is required.
export async function verifyInstalledSnapshot(previous) {
  validateState(previous);
  if (!previous.active || previous.pending !== null) fail('snapshot.state');
  const snapshot = previous.active.snapshot;
  const root = resolveChild(absoluteRoot(previous.workspace), snapshot.path);
  const verified = await verifySnapshotDirectory(root, {...snapshot,pipelineId:previous.active.pipelineId,version:previous.active.version});
  const selection=resolveProviders(verified.manifest,installedSelection(previous.active));
  if(contractDigest(selection.providers)!==contractDigest([...previous.active.providers].sort()) ||
      contractDigest(selection.bundles??null)!==contractDigest(previous.active.bundles??null)) fail('bundle.snapshot-binding');
  return {...verified,snapshot:structuredClone(snapshot)};
}
export async function verifyPreparedSnapshot(acquired) {
  return verifySnapshotDirectory(absoluteRoot(acquired.snapshotPath), {...acquired,pipelineId:acquired.manifest.id,version:acquired.manifest.version});
}
async function verifySnapshotDirectory(root, expected) {
  const entries = [], files = new Map(), directories = new Set();
  let nodes = 0, total = 0;
  try {
    if (!(await inspectDirectory(root)).exists) fail('snapshot.missing');
    async function walk(directory, prefix = '') {
      for await (const item of await opendir(directory)) {
        // Count directories too: an empty-directory flood is still bounded.
        cap(++nodes, LIMITS.files * 2, 'snapshot.nodes');
        const relative = prefix + item.name, filename = resolveChild(root, relative);
        const info = await lstat(filename);
        if (info.isSymbolicLink()) fail('snapshot.link');
        if (info.isDirectory()) {
          directories.add(relative);
          await inspectDirectory(filename);
          await walk(filename, relative + '/');
          continue;
        }
        if (!info.isFile() || info.nlink !== 1) fail('snapshot.type');
        cap(entries.length + 1, LIMITS.files, 'source.files');
        cap(info.size, LIMITS.blob, 'source.blob');
        cap(total + info.size, LIMITS.total, 'source.total');
        const handle = await open(filename, 'r');
        let bytes;
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.nlink !== 1) fail('snapshot.drift');
          // One extra byte detects growth without unbounded readFile allocation.
          const buffer = Buffer.alloc(info.size + 1);
          let length = 0;
          while (length < buffer.length) {
            const read = await handle.read(buffer, length, buffer.length - length, null);
            if (read.bytesRead === 0) break;
            length += read.bytesRead;
          }
          if (length !== info.size) fail('snapshot.drift');
          bytes = buffer.subarray(0, length);
        } finally { await handle.close(); }
        total += bytes.length;
        entries.push({ path: relative, size: bytes.length, mode: '100644', type: 'blob' });
        files.set(relative, bytes);
      }
    }
    await walk(root);
    entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const verified = await verifyPackage(entries, async entry => files.get(entry.path));
    const expectedDirectories = new Set();
    for (const name of verified.files.keys()) {
      const parts = name.split('/');
      for (let i = 1; i < parts.length; i++) expectedDirectories.add(parts.slice(0, i).join('/'));
    }
    if (directories.size !== expectedDirectories.size || [...directories].some(name => !expectedDirectories.has(name))) fail('snapshot.extra-directory');
    if (verified.digest !== expected.digest || verified.inventoryDigest !== expected.inventoryDigest ||
        verified.manifest.id !== expected.pipelineId || verified.manifest.version !== expected.version) fail('snapshot.binding');
    return { ...verified, root, runtime: 'not-run' };
  } catch (error) {
    throw error instanceof ContractError ? error : new ContractError('snapshot.io');
  }
}

// Read-only bounded observation. Not an S5 lock or protection against concurrent
// replacement. No native Git, network or configuration writes here.
export async function readRecord(filename, format = 'json') {
  filename = absoluteRoot(filename);
  let handle;
  try {
    await inspectDirectory(path.dirname(filename));
    const entry = await lstat(filename);
    if (entry.isSymbolicLink() || !entry.isFile()) fail('record.type');
    handle = await open(filename, 'r');
    const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_INPUT_BYTES) fail('parse.size');
    const bytes = buffer.subarray(0, length);
    return { path: await realpath(filename), digest: sha256(bytes), value: parse(utf8(bytes), format) };
  } catch (e) {
    if (e instanceof ContractError) throw e;
    fail(e.code === 'ENOENT' ? 'record.missing' : 'record.io');
  } finally { if (handle) await handle.close(); }
}
export async function readState(filename) {
  const record = await readRecord(filename);
  validateState(record.value);
  return { ...record, stateDigest: contractDigest(record.value) };
}
function previousGuard(previous, wrapper) {
  if (!previous) return;
  validateState(previous);
  if (previous.pending !== null) fail('state.pending');
  if (absoluteRoot(previous.workspace) !== wrapper) fail('source-rebind-required');
}
async function manifestRecord(filename, hasOriginal = false) {
  const extension = path.extname(filename).toLowerCase();
  if (!['.json', '.yaml', '.yml'].includes(extension)) fail('manifest.format');
  const record = await readRecord(filename, extension === '.json' ? 'json' : 'yaml');
  validateStructure('workspace', record.value); validateSource(record.value.pipeline);
  const base = path.dirname(record.path), source = record.value.pipeline;
  let resolvedSource = source.url;
  if (source.transport === 'local') {
    try { resolvedSource = await realpath(path.resolve(base, source.path)); }
    catch (error) { fail(hasOriginal ? 'source-rebind-required' : error.code === 'ENOENT' ? 'source.missing-repository' : 'source.repository-unavailable'); }
  }
  return { manifest: record.value, origin: { path: record.path, base, digest: record.digest, resolvedSource } };
}
export async function resolveOrigin({ wrapper, previous = null, manifestPath, command = 'setup' }) {
  wrapper = absoluteRoot(wrapper);
  previousGuard(previous, wrapper);
  if (!['setup', 'update', 'repair'].includes(command)) fail('origin.command');
  const active = previous?.active;
  if (command === 'repair') {
    if (!active || manifestPath !== undefined) fail('origin.repair');
    // Repair gets identity from installed state. Snapshot bytes still need a
    // separate integrity check before planning/apply; this performs no source I/O.
    return { mode: 'installed', snapshot: structuredClone(active.snapshot) };
  }
  const original = active?.snapshot.origin;
  const filename = absoluteRoot(manifestPath ?? original?.path ?? path.join(wrapper, 'workspace.yaml'));
  if (original && filename !== absoluteRoot(original.path)) fail('source-rebind-required');
  let current;
  try { current = await manifestRecord(filename, Boolean(original)); }
  catch (e) { if (original && e.code === 'record.missing') fail('source-rebind-required'); throw e; }
  if (original && (current.origin.path !== original.path || current.origin.base !== original.base ||
      current.origin.resolvedSource !== original.resolvedSource)) fail('source-rebind-required');
  return { mode: 'source', ...current };
}
// Explicit preview only. This never grants permission to acquire the proposed
// source, changes state or bypasses resolveOrigin. Approval binding is S4 plan work.
export async function previewRebind({ wrapper, previous, manifestPath }) {
  validateState(previous);
  if (!previous.active || previous.pending !== null || manifestPath === undefined) fail('origin.rebind');
  const proposed = await manifestRecord(absoluteRoot(manifestPath));
  return { kind: 'rebind-preview', beforeStateHash: contractDigest(previous),
    previousWorkspace: previous.workspace, workspace: absoluteRoot(wrapper),
    previousOrigin: structuredClone(previous.active.snapshot.origin), proposed,
    requiresApproval: true, sourceAccessAuthorized: false };
}

// The CLI must obtain this decision from the user, not from package contents.
// It authorizes source access only, never filesystem apply. Recompute the proposal
// before access so edited manifests, relocated source or changed state invalidate it.
export async function resolveApprovedRebind({wrapper,previous,manifestPath,proposal,approval}) {
  if (!approval || approval.decision!=='approve' || Object.keys(approval).sort().join(',')!=='decision,proposalDigest' ||
      approval.proposalDigest!==contractDigest(proposal)) fail('rebind.approval');
  const fresh=await previewRebind({wrapper,previous,manifestPath});
  if (contractDigest(fresh)!==approval.proposalDigest) fail('rebind.drift');
  // Workspace relocation is S6; S1 plans cannot silently change previous.workspace.
  if (fresh.workspace!==previous.workspace) fail('rebind.workspace-move');
  return {mode:'source',...fresh.proposed,rebind:{proposal:fresh,approval:structuredClone(approval)}};
}

export async function observeTargets(wrapper, names) {
  const result=[];let total=0;
  cap(names.length,LIMITS.files,'preview.count');
  for(const name of [...new Set(names)].sort()) {
    const filename=resolveChild(absoluteRoot(wrapper),name);
    let handle;
    try {
      const parent=await inspectDirectory(path.dirname(filename));
      if (!parent.exists) {result.push({path:name,bytes:null});continue;}
      // Probe the final filename spelling without treating it as a directory.
      const directory=await opendir(path.dirname(filename));
      for await(const entry of directory) if(entry.name.toLowerCase()===path.basename(filename).toLowerCase() && entry.name!==path.basename(filename)) fail('layout.case-alias');
      let info;
      try {info=await lstat(filename);} catch(error) {if(error.code==='ENOENT'){result.push({path:name,bytes:null});continue;}throw error;}
      if(!info.isFile() || info.isSymbolicLink() || info.nlink!==1) fail('target.type');
      cap(info.size,LIMITS.blob,'preview.size');cap(total+info.size,LIMITS.total,'preview.total');
      handle=await open(filename,'r');
      const opened=await handle.stat();
      if(!opened.isFile() || opened.ino!==info.ino || opened.dev!==info.dev || opened.nlink!==1) fail('target.drift');
      const buffer=Buffer.alloc(info.size+1);let length=0;
      while(length<buffer.length){const read=await handle.read(buffer,length,buffer.length-length,null);if(!read.bytesRead)break;length+=read.bytesRead;}
      if(length!==info.size)fail('target.drift');
      total+=length;result.push({path:name,bytes:buffer.subarray(0,length)});
    } catch(error) {throw error instanceof ContractError ? error : new ContractError('target.io');}
    finally {if(handle)await handle.close();}
  }
  return result;
}
