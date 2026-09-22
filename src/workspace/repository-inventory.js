import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ContractError, fail } from '../contracts/parse.js';
import { absoluteRoot, inspectDirectory } from './paths.js';

// Separate from S2 package caps: user repositories may contain large assets.
// A cap failure never yields a partial successful inventory.
const defaults = Object.freeze({ entries: 200000, bytes: 100 * 1024 ** 3, depth: 128 });
const stamp = s => [s.dev,s.ino,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].map(String).join(':');
const identity = s => ({ dev:String(s.dev), ino:String(s.ino), mode:String(s.mode), nlink:String(s.nlink),
  size:String(s.size), mtimeNs:String(s.mtimeNs), ctimeNs:String(s.ctimeNs) });

// Read-only observation, not an atomic snapshot or proof of movable Git metadata.
// Includes ignored/untracked data and .git without invoking Git or user hooks.
export async function inventoryRepository(directory, options = {}) {
  if (Object.keys(options).some(key => !Object.hasOwn(defaults,key))) fail('repositories.inventory-options');
  const limits = { ...defaults, ...options };
  for (const key of Object.keys(defaults))
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > defaults[key])
      fail('repositories.inventory-limit');
  const root = absoluteRoot(directory), entries = [];
  let bytes = 0;
  try {
    if (!(await inspectDirectory(root)).exists) fail('repositories.missing');
    const visit = async (filename, relative, depth) => {
      if (depth > limits.depth) fail('repositories.depth');
      if (entries.length >= limits.entries) fail('repositories.entries');
      const before = await lstat(filename,{bigint:true});
      if (before.isSymbolicLink()) fail('repositories.link');
      if (before.isDirectory()) {
        await inspectDirectory(filename);
        const names = (await readdir(filename)).sort();
        if (names.length > limits.entries - entries.length - 1) fail('repositories.entries');
        entries.push({path:relative,type:'directory',identity:identity(before)});
        for (const name of names) await visit(path.join(filename,name),relative === '.' ? name : relative+'/'+name,depth+1);
        const after = await lstat(filename,{bigint:true});
        if (stamp(before) !== stamp(after) || JSON.stringify(names) !== JSON.stringify((await readdir(filename)).sort()))
          fail('repositories.drift');
      } else if (before.isFile()) {
        // Shared mutable bytes would invalidate preservation/independence claims.
        if (before.nlink !== 1n) fail('repositories.hardlink');
        if (before.size > BigInt(limits.bytes - bytes)) fail('repositories.bytes');
        await inspectDirectory(path.dirname(filename));
        const handle = await open(filename,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        let total = 0;
        const hash = createHash('sha256');
        try {
          if (stamp(before) !== stamp(await handle.stat({bigint:true}))) fail('repositories.drift');
          const buffer = Buffer.alloc(64 * 1024);
          for (;;) {
            const {bytesRead} = await handle.read(buffer,0,buffer.length,null);
            if (!bytesRead) break;
            total += bytesRead;
            if (bytes + total > limits.bytes || BigInt(total) > before.size) fail('repositories.bytes');
            hash.update(buffer.subarray(0,bytesRead));
          }
          if (BigInt(total) !== before.size || stamp(before) !== stamp(await handle.stat({bigint:true})))
            fail('repositories.drift');
        } finally { await handle.close(); }
        if (stamp(before) !== stamp(await lstat(filename,{bigint:true}))) fail('repositories.drift');
        bytes += total;
        entries.push({path:relative,type:'file',identity:identity(before),sha256:hash.digest('hex')});
      } else fail('repositories.special-file');
    };
    await visit(root,'.',0);
    // Catch changes to an earlier file while later entries were read.
    for (const entry of entries) {
      const current = await lstat(entry.path === '.' ? root : path.join(root,...entry.path.split('/')),{bigint:true});
      if (current.isSymbolicLink() || JSON.stringify(identity(current)) !== JSON.stringify(entry.identity)) fail('repositories.drift');
    }
    return { root, entries, bytes, status:'observation-only', git:'not-verified',
      executionAuthorized:false, digest:'sha256:'+createHash('sha256').update(JSON.stringify(entries)).digest('hex') };
  } catch (error) { throw error instanceof ContractError ? error : new ContractError(
    error.code==='EBUSY'?'repositories.busy':['EACCES','EPERM'].includes(error.code)?'repositories.access-denied':'repositories.inventory-io'); }
}
