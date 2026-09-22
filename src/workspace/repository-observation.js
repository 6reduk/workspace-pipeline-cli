import {contractDigest} from '../contracts/semantic.js';
import {fail} from '../contracts/parse.js';

const hash=v=>typeof v==='string' && /^sha256:[a-f0-9]{64}$/.test(v);
const exact=(v,keys)=>v && typeof v==='object' && !Array.isArray(v) &&
  Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const identityKeys=['dev','ino','mode','nlink','size','mtimeNs','ctimeNs'];

// Full observations are transient. Saved records bind every entry through the
// exact identity digest and the separate rename-stable content projection.
// This is an observation, not proof of execution or permission to replay it.
export function validateInventorySummary(v) {
  if(!exact(v,['kind','root','rootIdentity','entryCount','bytes','digest','contentDigest']) ||
    v.kind!=='repository-inventory-summary' || typeof v.root!=='string' || !v.root ||
    !exact(v.rootIdentity,identityKeys) || identityKeys.some(k=>typeof v.rootIdentity[k]!=='string' || !/^-?\d+$/.test(v.rootIdentity[k])) ||
    !Number.isSafeInteger(v.entryCount) || v.entryCount<1 || v.entryCount>200000 ||
    !Number.isSafeInteger(v.bytes) || v.bytes<0 || v.bytes>100*1024**3 ||
    !hash(v.digest) || !hash(v.contentDigest))fail('repositories.inventory-summary');
  return v;
}
export function repositoryContentDigest(inventory) {
  if(inventory?.kind==='repository-inventory-summary')return validateInventorySummary(inventory).contentDigest;
  return contractDigest(inventory.entries.map(e=>({path:e.path,type:e.type,mode:e.identity.mode,
    ...(e.type==='file'?{size:e.identity.size,sha256:e.sha256}:{})})));
}
export function summarizeInventory(inventory) {
  if(inventory?.kind==='repository-inventory-summary')return structuredClone(validateInventorySummary(inventory));
  if(!Array.isArray(inventory?.entries) || inventory.entries[0]?.path!=='.' ||
    inventory.entries[0]?.type!=='directory')fail('repositories.inventory-summary');
  return validateInventorySummary({kind:'repository-inventory-summary',root:inventory.root,
    rootIdentity:structuredClone(inventory.entries[0].identity),entryCount:inventory.entries.length,
    bytes:inventory.bytes,digest:inventory.digest,contentDigest:repositoryContentDigest(inventory)});
}
export function summarizeTree(tree) {
  if(!Array.isArray(tree?.entries))fail('repository-tree.summary');
  const {entries,...body}=tree;
  return {kind:'repository-tree-summary',...body,entryCount:entries.length};
}
