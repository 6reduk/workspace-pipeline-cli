import { fail } from '../contracts/parse.js';
import { contractDigest } from '../contracts/semantic.js';

const hashPattern = /^sha256:[a-f0-9]{64}$/;
const validHash = value => value === null || (typeof value === 'string' && hashPattern.test(value));

// Only plain own data properties: fail before invoking getters or reading fields.
export function requestShape(value, required, optional, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
  const allowed = new Set([...required, ...optional]);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!allowed.has(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code);
  }
  if (required.some(key => !Object.hasOwn(value, key))) fail(code);
}

// Pure reconciliation, not authorization or a state writer. Null means absent;
// JSON null has a non-null digest. Explicit takeover is bound to observed bytes
// (or field value); the final preview still needs user approval before apply.
export function reconcileOwnership({ currentHash, desiredHash, managedHash = null, takeover = null }) {
  if (![currentHash, desiredHash, managedHash].every(validHash)) fail('ownership.hash');
  if (takeover !== null && (typeof takeover !== 'object' ||
      Object.keys(takeover).sort().join(',') !== 'beforeHash,desiredHash' ||
      takeover.beforeHash !== currentHash || takeover.desiredHash !== desiredHash)) fail('ownership.takeover');

  if (managedHash !== null && currentHash !== managedHash) fail('ownership.drift');
  if (desiredHash === null) {
    if (managedHash === null) return { action: 'preserve', owned: false, backupRequired: false };
    return { action: 'delete', owned: false, backupRequired: true };
  }
  if (managedHash !== null) return {
    action: currentHash === desiredHash ? 'preserve' : 'replace', owned: true,
    backupRequired: currentHash !== desiredHash
  };
  if (currentHash === null) return { action: 'create', owned: true, backupRequired: false };
  if (takeover !== null) return {
    action: currentHash === desiredHash ? 'preserve' : 'replace', owned: true, backupRequired: true
  };
  if (currentHash === desiredHash) return { action: 'preserve', owned: false, backupRequired: false };
  fail('ownership.foreign');
}

function tokens(pointer) {
  if (typeof pointer !== 'string' || !pointer.startsWith('/') || /~(?![01])/.test(pointer)) fail('ownership.pointer');
  const result = pointer.slice(1).split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (result.some(s => ['__proto__', 'prototype', 'constructor'].includes(s))) fail('ownership.pointer');
  return result;
}

// Accept only JSON-domain data, including null-prototype parser objects. No
// getters, exotic prototypes, sparse arrays, cycles, or implicit JSON coercions.
function jsonCopy(value, depth = 0, seen = new Set()) {
  if (depth > 64) fail('ownership.value');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return value;
  if (typeof value !== 'object' || seen.has(value)) fail('ownership.value');
  const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
  if (!array && proto !== null && proto !== Object.prototype) fail('ownership.value');
  seen.add(value);
  const result = array ? [] : Object.create(null);
  const keys = Reflect.ownKeys(value).filter(k => !(array && k === 'length'));
  if (array && (keys.length !== value.length || keys.some((k, i) => k !== String(i)))) fail('ownership.value');
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !d.enumerable || !Object.hasOwn(d, 'value') ||
        ['__proto__', 'prototype', 'constructor'].includes(key)) fail('ownership.value');
    result[key] = jsonCopy(d.value, depth + 1, seen);
  }
  seen.delete(value);
  return result;
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function field(root, parts) {
  let node = root;
  for (const part of parts) {
    if (!object(node)) fail('ownership.ancestor');
    if (!Object.hasOwn(node, part)) return { present: false };
    node = node[part];
  }
  return { present: true, value: node };
}

// Trusted adapters supply requests for exact JSON pointers. Arrays may be owned
// as whole values, never addressed by index. Foreign siblings stay intact.
// This layer does not infer provider/path permissions or persist backup records.
export function reconcileFields(current, requests) {
  const result = jsonCopy(current);
  if (!object(result) || !Array.isArray(requests) || requests.length > 1000) fail('ownership.fields');
  const ordered = Array.from(requests, request => {
    requestShape(request, ['pointer', 'present'], ['value', 'managedHash', 'takeover'], 'ownership.fields');
    const parts = tokens(request.pointer);
    if (typeof request.present !== 'boolean' || (request.present && !Object.hasOwn(request, 'value'))) fail('ownership.fields');
    return { request, parts };
  }).sort((a, b) => a.request.pointer < b.request.pointer ? -1 : a.request.pointer > b.request.pointer ? 1 : 0);
  for (let i = 0; i < ordered.length; i++) for (let j = 0; j < i; j++) {
    const a = ordered[i].parts, b = ordered[j].parts;
    if (a.slice(0, Math.min(a.length, b.length)).every((p, k) => p === b[k])) fail('ownership.overlap');
  }
  const decisions = [];
  for (const { request, parts } of ordered) {
    const before = field(result, parts), desired = request.present ? jsonCopy(request.value) : undefined;
    const currentHash = before.present ? contractDigest(before.value) : null;
    const desiredHash = request.present ? contractDigest(desired) : null;
    const decision = reconcileOwnership({ currentHash, desiredHash, managedHash: request.managedHash ?? null, takeover: request.takeover ?? null });
    if (decision.action !== 'preserve') {
      let parent = result;
      for (const part of parts.slice(0, -1)) {
        if (!Object.hasOwn(parent, part)) parent[part] = Object.create(null);
        if (!object(parent[part])) fail('ownership.ancestor');
        parent = parent[part];
      }
      const last = parts.at(-1);
      if (decision.action === 'delete') delete parent[last];
      else parent[last] = desired;
    }
    decisions.push({ pointer: request.pointer, currentHash, desiredHash, ...decision });
  }
  return { value: result, decisions };
}
