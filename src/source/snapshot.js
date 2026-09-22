import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fail, ContractError } from '../contracts/parse.js';
import { portablePath } from '../contracts/semantic.js';
import { LIMITS, sha256, cap } from './inventory.js';

export function checkDestination(destination, platform = process.platform) {
  cap(platform === 'win32' ? destination.length : Buffer.byteLength(destination),
    platform === 'win32' ? LIMITS.windowsPath : LIMITS.posixPath, 'snapshot.path-length');
}
// Disposable preparation only. Does not activate an installed workspace.
// No implicit cleanup: failed preparations remain identifiable to the caller.
export async function materialize(verified, tempRoot = tmpdir()) {
  const parent = await realpath(tempRoot);
  const root = await mkdtemp(path.join(parent, 'wpc-snapshot-'));
  try {
  const prepared = [];
  for (const [name, bytes] of verified.files) {
    portablePath(name);
    if (!Buffer.isBuffer(bytes) || sha256(bytes) !== verified.fileHashes[name]) fail('snapshot.input');
    const target = path.join(root, ...name.split('/'));
    checkDestination(target);
    prepared.push([target, bytes]);
  }
  for (const [target, bytes] of prepared) {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    if (sha256(await readFile(target)) !== sha256(bytes)) fail('snapshot.readback');
  }
  return root;
  } catch (cause) {
    const error = cause instanceof ContractError ? cause : new ContractError('snapshot.io');
    error.snapshotPath = root;
    throw error;
  }
}
