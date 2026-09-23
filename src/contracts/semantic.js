import { posix, win32 } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { fail } from './parse.js';
import { validateStructure } from './validate.js';
import { requiredCapabilities, assertAdapter } from '../providers/interface.js';
import { resolveProviders, validateInstalledBundles } from '../providers/bundles.js';
import {retiredSkillOwnership} from '../operations/skill-retirement.js';

const has = (o, k) => Object.hasOwn(o, k);
export function portablePath(value) {
  if (typeof value !== 'string' || !value || value.length > 240 || !/^[A-Za-z0-9_. /-]+$/.test(value)) fail('path.invalid');
  for (const part of value.split('/')) {
    if (!part || part.length > 100 || part === '.' || part === '..' || /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || part.toLowerCase() === '.git') fail('path.invalid');
  }
  return value;
}
function machinePath(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value) ||
      !(posix.isAbsolute(value) || win32.isAbsolute(value))) fail('state.absolute-path');
}
export function validateLayoutReferences(layout) {
  for (const ref of [layout.documentation, ...Object.values(layout.projectRoots ?? {})]) {
    if (!has(layout.repositories, ref.repository)) fail('layout.repository');
    if (ref.path !== '.') portablePath(ref.path);
  }
  for (const repo of Object.values(layout.repositories)) {
    portablePath(repo.path);
    if (repo.source && repo.source.subdirectory !== '.') fail('source.clone-subdirectory');
  }
}
export function validateInventory(inventory, { inventoryPath, manifestPath }) {
  validateStructure('inventory', inventory);
  portablePath(inventoryPath); portablePath(manifestPath);
  const seen = new Set();
  for (const name of Object.keys(inventory)) {
    portablePath(name);
    const key = name.toLowerCase();
    if (key === inventoryPath.toLowerCase()) fail('inventory.self');
    if (seen.has(key)) fail('inventory.collision');
    seen.add(key);
  }
  if (!has(inventory, manifestPath)) fail('inventory.manifest');
  // Blob contents / missing and extra physical files / digest verification belong to S2.
  return inventory;
}
export function validateBundle(pipeline, workspace, adapters) {
  validateStructure('pipeline', pipeline); validateStructure('workspace', workspace);
  if (workspace.pipeline.subdirectory !== '.') portablePath(workspace.pipeline.subdirectory);
  portablePath(pipeline.resources); portablePath(pipeline.inventory);
  for (const decl of Object.values(pipeline.providers)) {
    requiredCapabilities(decl);
    for (const key of ['skills', 'agents', 'mcp', 'entryInstructions'])
      if (decl[key] !== null) portablePath(decl[key]);
  }
  for (const profile of Object.values(pipeline.workspaceProfiles ?? {})) validateLayoutReferences(profile);
  let layout = workspace.layout;
  if (workspace.profile !== undefined) {
    if (!has(pipeline.workspaceProfiles ?? {}, workspace.profile)) fail('layout.profile');
    layout = pipeline.workspaceProfiles[workspace.profile];
  }
  validateLayoutReferences(layout);
  const selection = resolveProviders(pipeline, workspace);
  for (const bundle of Object.values(pipeline.bundles ?? {})) portablePath(bundle.entry.source);
  for (const id of selection.providers) {
    if (!has(pipeline.providers, id)) fail('provider.absent');
    if (adapters) assertAdapter(adapters[id], id, pipeline.providers[id]);
  }
  const entry = workspace.agentsDocument ?? pipeline.agentsDocument;
  if (entry.mode === 'source') portablePath(entry.path);
  return { layout, agentsDocument: entry, ...selection };
}
export function renderEntry(text, layout) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 2 * 1024 * 1024) fail('entry.input');
  validateLayoutReferences(layout);
  const output = text.replace(/\{\{([^{}]*)\}\}/g, (matchText, token, offset) => {
    if (text[offset - 1] === '{' || text[offset + matchText.length] === '}') fail('entry.token');
    if (token === 'documentation') {
      const doc = layout.documentation;
      return posix.join(layout.repositories[doc.repository].path, doc.path);
    }
    const match = /^repository\.([a-z][a-z0-9-]{0,62})$/.exec(token);
    if (!match || !has(layout.repositories, match[1])) fail('entry.token');
    return layout.repositories[match[1]].path;
  });
  if (output.includes('{{') || output.includes('}}')) fail('entry.token');
  return output;
}
export function resolveEntryChange(current, desired, baseHash, currentHash, decision) {
  // Pure policy decision; caller S4/S8 must compute hashes from exact bytes.
  if (current === null) return 'create';
  if (current === desired) return 'preserve';
  if (decision === 'preserve') return 'preserve';
  if (baseHash !== null && baseHash === currentHash) return 'replace';
  if (decision === 'replace') return 'replace';
  // Merging requires a separately reviewed desired result, never an implicit merge.
  fail('entry.conflict');
}
function pointer(value) {
  if (typeof value !== 'string' || !/^(?:\/(?:[^~/]|~[01])*)+$/.test(value)) fail('ownership.pointer');
  for (const part of value.split('/').slice(1).map(s => s.replace(/~1/g, '/').replace(/~0/g, '~')))
    if (['__proto__', 'constructor', 'prototype'].includes(part)) fail('ownership.pointer');
}
function snapshot(s) {
  if (s.source.subdirectory !== '.') portablePath(s.source.subdirectory);
  portablePath(s.path); machinePath(s.origin.path); machinePath(s.origin.base);
  if (!s.path.startsWith('.pipeline/snapshots/')) fail('state.snapshot-path');
  if (s.source.transport === 'local') machinePath(s.origin.resolvedSource);
  else if (s.origin.resolvedSource !== s.source.url) fail('source.identity');
}
function ownership(records, providers) {
  const seen = [];
  for (const record of records) {
    portablePath(record.path);
    if (record.backup !== null) {
      portablePath(record.backup);
      if (!record.backup.startsWith('.pipeline/backups/')) fail('ownership.backup');
    }
    if (record.beforeHash !== null && record.backup === null) fail('ownership.backup');
    if (record.owner !== 'shared' && !providers.includes(record.owner)) fail('ownership.owner');
    if (record.kind === 'file' && record.pointer !== null) fail('ownership.pointer');
    if (record.kind === 'field') pointer(record.pointer);
    for (const previous of seen) if (previous.path.toLowerCase() === record.path.toLowerCase()) {
      if (previous.kind === 'file' || record.kind === 'file' || previous.pointer === record.pointer ||
          previous.pointer.startsWith(record.pointer + '/') || record.pointer.startsWith(previous.pointer + '/')) fail('ownership.overlap');
    }
    seen.push(record);
  }
}
function deployment(d) {
  validateInstalledBundles(d);
  snapshot(d.snapshot); validateLayoutReferences(d.layout);
  if (Object.keys(d.adapterVersions).sort().join(',') !== [...d.providers].sort().join(',')) fail('state.adapters');
  ownership(d.owned, d.providers);
}
export function validateState(state) {
  validateStructure('state', state); machinePath(state.workspace);
  if (state.active) deployment(state.active);
  if (state.status === 'ready' && (!state.active || state.pending !== null)) fail('state.ready');
  if (state.status === 'not-installed' && (state.active !== null || state.pending !== null)) fail('state.absent');
  if (state.status === 'needs-reconciliation' && state.pending === null) fail('state.pending');
  if (state.status === 'drift' && state.active === null) fail('state.drift');
  return state;
}
export function validateOperation(op, previous) {
  validateStructure('operation', op);
  const ids = new Set();
  if (op.kind === 'plan') {
    machinePath(op.workspace);
    // Existing-state plans require the exact previous state, including removed
    // providers. The desired provider set alone cannot authorize cleanup.
    if (op.beforeStateHash !== null) {
      if (previous == null) fail('plan.previous-required');
      validateState(previous);
      if (previous.workspace !== op.workspace || contractDigest(previous) !== op.beforeStateHash) fail('plan.previous');
    } else if (previous != null) fail('plan.previous');
    const owners = new Set(['shared', ...(previous?.active?.providers ?? []), ...(op.desired?.providers ?? [])]);
    if (op.source) snapshot(op.source);
    if (op.desired) {
      deployment(op.desired);
      if (!op.source || !isDeepStrictEqual(op.source, op.desired.snapshot)) fail('plan.source');
    }
    if (['setup', 'update', 'repair', 'switch'].includes(op.command) && !op.desired) fail('plan.deployment');
    const paths = new Set();
    for (const t of op.targets) {
      if (!owners.has(t.owner)) fail('operation.owner');
      if (ids.has(t.id)) fail('operation.duplicate'); ids.add(t.id);
      portablePath(t.path);
      if (paths.has(t.path.toLowerCase())) fail('operation.path'); paths.add(t.path.toLowerCase());
      if (t.action === 'create' && (t.beforeHash !== null || t.desiredHash === null)) fail('operation.hash');
      if (t.action === 'delete' && (t.beforeHash === null || t.desiredHash !== null)) fail('operation.hash');
      const retiredBundleFile = op.command==='update' && previous?.active?.owned.some(o=>
        o.path===t.path && o.owner===t.owner && o.kind==='file') &&
        Object.entries(previous.active.bundles??{}).some(([id,b])=>op.desired?.bundles?.[id] &&
          b.providers.includes(t.owner) && !op.desired.providers.includes(t.owner));
      const retiredSkillFile=op.command==='update' && retiredSkillOwnership(previous,op.desired).some(o=>o.path===t.path && o.owner===t.owner);
      if (t.action === 'verify-absent' && ((!['remove','reset'].includes(op.command) && !retiredBundleFile && !retiredSkillFile) || t.beforeHash !== null || t.desiredHash !== null)) fail('operation.hash');
      if (['replace', 'edit-fields'].includes(t.action) && (t.beforeHash === null || t.desiredHash === null)) fail('operation.hash');
      if ((t.action === 'edit-fields') !== (t.fields.length > 0)) fail('operation.fields');
      const fieldPointers = [];
      for (const f of t.fields) {
        pointer(f.pointer);
        if (fieldPointers.some(p => p === f.pointer || p.startsWith(f.pointer + '/') || f.pointer.startsWith(p + '/'))) fail('operation.fields');
        fieldPointers.push(f.pointer);
      }
    }
  } else {
    let stopped = false;
    for (const r of op.operations) {
      if (ids.has(r.operationId)) fail('operation.duplicate'); ids.add(r.operationId);
      if (stopped && r.status !== 'skipped') fail('receipt.order');
      if (r.status !== 'completed') stopped = true;
      if (r.status === 'completed' && r.observedHash !== r.desiredHash) fail('receipt.readback');
      if (r.status === 'failed' && r.observedHash !== r.beforeHash) fail('receipt.before');
    }
    const statuses = op.operations.map(r => r.status);
    const expected = statuses.every(s => s === 'completed') ? 'completed' :
      statuses.includes('uncertain') ? 'uncertain' : 'failed';
    if (op.status !== expected) fail('receipt.status');
  }
  return op;
}
// Hash domain data, not file bytes: sorted object keys, array order retained.
// Use only validated JSON-domain values. Source blob hashes remain exact byte hashes.
export function contractDigest(value) {
  const canonical = v => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  };
  return 'sha256:' + createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}
export function validateReceiptForPlan(receipt, plan, previous) {
  validateOperation(plan, previous); validateOperation(receipt);
  if (plan.kind !== 'plan' || receipt.kind !== 'receipt' || receipt.planDigest !== contractDigest(plan)) fail('receipt.binding');
  if (receipt.operations.length !== plan.targets.length) fail('receipt.coverage');
  for (let i = 0; i < plan.targets.length; i++) {
    const t = plan.targets[i], r = receipt.operations[i];
    if (t.id !== r.operationId || t.beforeHash !== r.beforeHash || t.desiredHash !== r.desiredHash) fail('receipt.binding');
  }
  return receipt;
}

// Structural lifecycle guard only. S5 must independently prove writes/readback and
// bind the on-disk before-state; a fabricated receipt is not execution evidence.
export function validateTransition(previous, next, plan, receipt) {
  if (previous !== null) validateState(previous);
  validateState(next); validateReceiptForPlan(receipt, plan, previous);
  if (next.workspace !== plan.workspace || (previous !== null && previous.workspace !== plan.workspace) ||
      plan.beforeStateHash !== (previous === null ? null : contractDigest(previous))) fail('transition.before');
  if (receipt.status === 'completed') {
    if (!isDeepStrictEqual(next.active, plan.desired) || next.pending !== null ||
        next.status !== (plan.desired === null ? 'not-installed' : 'ready')) fail('transition.activation');
  } else {
    if (next.status !== 'needs-reconciliation' || next.pending !== contractDigest(plan) ||
        !isDeepStrictEqual(next.active, previous?.active ?? null)) fail('transition.partial');
    if (contractDigest(next.activation??null)!==contractDigest(previous?.activation??null)) fail('transition.activation-history');
  }
  if (next.runtime !== 'not-run') fail('transition.runtime');
  return next;
}
