import { posix } from 'node:path';
import { fail } from '../contracts/parse.js';
import { portablePath } from '../contracts/semantic.js';
import { utf8 } from '../source/inventory.js';

// Reads exclusively from the already verified Git tree supplied by preparePlan.
// No checkout paths, network requests, source modules or filesystem fallback.
export function sourceBytes(context, name) {
  portablePath(name);
  const bytes = context.files.get(name);
  if (!Buffer.isBuffer(bytes)) fail('provider.source-missing');
  return Buffer.from(bytes);
}
export function sourceText(context, name) { return utf8(sourceBytes(context, name)); }

export function snapshotFilePath(context, name) {
  snapshotResourcePath(context);
  sourceBytes(context, name);
  return posix.join(context.snapshot.path, name);
}

export function snapshotResourcePath(context) {
  const { snapshot, pipeline } = context;
  if (!snapshot || !/^sha256:[a-f0-9]{64}$/.test(snapshot.digest) ||
      snapshot.path !== '.pipeline/snapshots/' + snapshot.digest.slice(7)) fail('provider.snapshot');
  portablePath(pipeline.resources);
  const prefix = pipeline.resources + '/';
  if (![...context.files.keys()].some(name => name.startsWith(prefix))) fail('provider.resources');
  return posix.join(snapshot.path, pipeline.resources);
}
