import path from 'node:path';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { fail, ContractError } from '../contracts/parse.js';
import { portablePath } from '../contracts/semantic.js';

export function absoluteRoot(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value)) fail('layout.absolute-root');
  return path.resolve(value);
}
export function pathBudget(value, platform = process.platform) {
  if ((platform === 'win32' ? value.length > 240 : Buffer.byteLength(value) > 1024)) fail('layout.path-length');
}
export function resolveChild(root, relative) {
  if (relative !== '.') portablePath(relative);
  const target = path.resolve(root, ...relative.split('/'));
  const rel = path.relative(root, target);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) fail('layout.escape');
  pathBudget(target);
  return target;
}
// Read-only observation, not an atomic preflight. S5 must recheck before writes.
// Reject links (including internal ones) rather than guessing their ownership.
export async function inspectDirectory(value) {
  const absolute = absoluteRoot(value), parsed = path.parse(absolute);
  let current = parsed.root, missing = false;
  try {
    for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      if (!missing) {
        let names;
        try { names = await readdir(current); }
        catch (e) {
          // Traversal may be permitted while parent enumeration is forbidden.
          // Only an existing exact canonical child can justify continuing.
          if (!['EACCES', 'EPERM'].includes(e.code)) throw e;
          const actual = await realpath(path.join(current, segment));
          if (path.basename(actual) !== segment) fail('layout.case-alias');
          names = [segment];
        }
        const matches = names.filter(n => n.toLowerCase() === segment.toLowerCase());
        if (matches.length > 1 || (matches.length === 1 && matches[0] !== segment)) fail('layout.case-alias');
      }
      current = path.join(current, segment);
      if (missing) continue;
      let stat;
      try { stat = await lstat(current); }
      catch (e) { if (e.code === 'ENOENT') { missing = true; continue; } throw e; }
      if (stat.isSymbolicLink()) fail('layout.link');
      if (!stat.isDirectory()) fail('layout.not-directory');
      const actual = await realpath(current);
      if (path.resolve(actual).toLowerCase() !== path.resolve(current).toLowerCase()) fail('layout.reparse');
    }
    return { path: absolute, exists: !missing };
  } catch (e) { throw e instanceof ContractError ? e : new ContractError('layout.io'); }
}
