import { createHash } from 'node:crypto';
import { parse, fail } from '../contracts/parse.js';
import { validateStructure } from '../contracts/validate.js';
import { portablePath, validateInventory, contractDigest } from '../contracts/semantic.js';
import { requiredCapabilities } from '../providers/interface.js';

export const LIMITS = Object.freeze({ files: 10000, blob: 8 * 1024 * 1024,
  total: 128 * 1024 * 1024, manifest: 2 * 1024 * 1024, path: 240, segment: 100,
  windowsPath: 240, posixPath: 1024, gitMs: 120000, acquisitionMs: 300000,
  pack: 256 * 1024 * 1024, metadata: 4 * 1024 * 1024 });
export const sha256 = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
export function cap(value, maximum, code) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) fail(code);
}
export function utf8(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail('source.utf8'); }
}
export function checkEntries(entries) {
  cap(entries.length, LIMITS.files, 'source.files');
  let total = 0;
  const names = new Map();
  for (const e of entries) {
    portablePath(e.path);
    if (!['100644', '100755'].includes(e.mode) || e.type !== 'blob') fail('source.entry-type');
    cap(e.size, LIMITS.blob, 'source.blob');
    total += e.size; cap(total, LIMITS.total, 'source.total');
    const parts = e.path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const spelling = parts.slice(0, i).join('/'), key = spelling.toLowerCase();
      const kind = i === parts.length ? 'file' : 'directory';
      const previous = names.get(key);
      if (previous && (previous.spelling !== spelling || previous.kind !== kind || kind === 'file')) fail('source.collision');
      names.set(key, { spelling, kind });
    }
  }
  return total;
}
// Read only selected tree blobs, never a checked-out worktree or smudge filter.
export async function verifyPackage(entries, readBlob) {
  checkEntries(entries);
  const manifestEntries = entries.filter(e => ['pipeline.json', 'pipeline.yaml', 'pipeline.yml'].includes(e.path));
  if (manifestEntries.length !== 1) fail('source.manifest');
  const buffers = new Map();
  async function read(e, limit = LIMITS.blob) {
    if (!e) fail('source.missing');
    cap(e.size, limit, 'source.metadata-size');
    if (buffers.has(e.path)) return buffers.get(e.path);
    const bytes = await readBlob(e);
    if (!Buffer.isBuffer(bytes) || bytes.length !== e.size) fail('source.blob-size');
    if (bytes.subarray(0, 200).toString('ascii').startsWith('version https://git-lfs.github.com/spec/v1')) fail('source.lfs');
    buffers.set(e.path, bytes); return bytes;
  }
  const manifestEntry = manifestEntries[0];
  const manifestBytes = await read(manifestEntry, LIMITS.manifest);
  const manifest = parse(utf8(manifestBytes), manifestEntry.path.endsWith('.json') ? 'json' : 'yaml');
  validateStructure('pipeline', manifest);
  portablePath(manifest.inventory); portablePath(manifest.resources);
  if (manifest.inventory === manifestEntry.path) fail('inventory.self');
  const inventoryBytes = await read(entries.find(e => e.path === manifest.inventory), LIMITS.manifest);
  const inventory = parse(utf8(inventoryBytes), 'json');
  validateInventory(inventory, { inventoryPath: manifest.inventory, manifestPath: manifestEntry.path });
  const expected = new Set([...Object.keys(inventory), manifest.inventory]);
  if (expected.size !== entries.length || entries.some(e => !expected.has(e.path))) fail('inventory.files');
  for (const e of entries) {
    const bytes = await read(e);
    if (e.path !== manifest.inventory && sha256(bytes) !== inventory[e.path]) fail('inventory.hash');
  }
  function component(p, directory) {
    portablePath(p);
    if (directory ? !entries.some(e => e.path.startsWith(p + '/')) : !buffers.has(p)) fail('source.component');
  }
  component(manifest.resources, true);
  for (const bundle of Object.values(manifest.bundles ?? {})) {
    component(bundle.entry.source, false);
    for (const id of bundle.providers) if (!Object.hasOwn(manifest.providers, id)) fail('bundle.provider-absent');
  }
  for (const decl of Object.values(manifest.providers)) {
    requiredCapabilities(decl);
    for (const key of ['skills', 'agents', 'mcp', 'entryInstructions'])
      if (decl[key] !== null) component(decl[key], key === 'skills' || key === 'agents');
  }
  if (manifest.agentsDocument.mode === 'source') component(manifest.agentsDocument.path, false);
  const fileHashes = Object.fromEntries([...buffers].map(([p, b]) => [p, sha256(b)]));
  return { manifest, manifestPath: manifestEntry.path, inventoryDigest: sha256(inventoryBytes),
    digest: contractDigest(fileHashes), files: buffers, fileHashes };
}
