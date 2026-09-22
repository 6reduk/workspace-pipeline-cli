// Read-only wrapper observation. Acquisition writes only to external temp storage.
// No approval, target writes, lock acquisition or native harness invocation.
import path from 'node:path';
import {tmpdir} from 'node:os';
import {readdir} from 'node:fs/promises';
import {assertLockHeld} from '../operations/lock.js';
import {fail} from '../contracts/parse.js';
import {contractDigest} from '../contracts/semantic.js';
import {absoluteRoot,inspectDirectory} from '../workspace/paths.js';
import {observeTargets,verifyPreparedSnapshot} from '../operations/state.js';
import {acquire} from '../source/git.js';
import {sha256} from '../source/inventory.js';
import {prepareLegacyUnityDeactivation} from './legacy-unity.js';

const targets=['.codex/config.toml','.claude/settings.local.json','AGENTS.md','CLAUDE.md',
 '.unity-sdd/workspace.json','.unity-sdd/claude.json'];
const nested=(parent,child)=>{const r=path.relative(parent,child);return !r||(!path.isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+path.sep));};
async function observe(wrapper,lock){
 if(!(await inspectDirectory(wrapper)).exists)fail('migration.wrapper-missing');
 // Existing managed metadata requires reconciliation, not a second bootstrap.
 if((await inspectDirectory(path.join(wrapper,'.pipeline'))).exists){
  if(!lock||lock.workspace!==wrapper)fail('migration.already-managed');
  await assertLockHeld(lock);
  const names=await readdir(path.join(wrapper,'.pipeline'));
  if(names.length!==1||names[0]!=='lock')fail('migration.already-managed');
 }
 const rows=await observeTargets(wrapper,targets);
 if(rows.some(r=>r.bytes===null))fail('migration.legacy-missing');
 // Native observation order is sorted; callers must not depend on input order.
 return targets.map(name=>rows.find(row=>row.path===name));
}
const fingerprints=rows=>rows.map(r=>({path:r.path,sha256:sha256(r.bytes)}));
export async function prepareLegacyUnityPreflight({wrapper,source,manifestBase,tempRoot=tmpdir(),network=false}){
 wrapper=absoluteRoot(wrapper);tempRoot=absoluteRoot(tempRoot);
 if(nested(wrapper,tempRoot)||nested(tempRoot,wrapper))fail('migration.preparation-location');
 const before=await observe(wrapper);
 const deactivation=prepareLegacyUnityDeactivation([
  {provider:'codex',bytes:before[0].bytes},{provider:'claude',bytes:before[1].bytes}]);
 const acquired=await acquire(source,{manifestBase,tempRoot,network});
 const verified=await verifyPreparedSnapshot(acquired);
 if(verified.manifest.id!=='unity-sdd'||!verified.manifest.providers.codex||!verified.manifest.providers.claude)fail('migration.supply');
 const after=await observe(wrapper);
 if(contractDigest(fingerprints(before))!==contractDigest(fingerprints(after)))fail('migration.observation-drift');
 const body={schemaVersion:1,kind:'legacy-unity-preflight',workspace:wrapper,
  observations:fingerprints(before),deactivation,
  supply:{source:acquired.source,commit:acquired.commit,version:verified.manifest.version,digest:acquired.digest,inventoryDigest:acquired.inventoryDigest,
   snapshotPath:acquired.snapshotPath,objectsPath:acquired.preparation},runtime:'not-run'};
 return {...body,digest:contractDigest(body)};
}

// Recheck observed wrapper and staged package without contacting Git/network.
// Digest equality is integrity, not authorization or proof of an earlier check.
export async function recheckLegacyUnityPreflight(record,wrapper,lock){
 const {digest,...body}=record;
 if(record.kind!=='legacy-unity-preflight'||contractDigest(body)!==digest||record.workspace!==absoluteRoot(wrapper))fail('migration.preflight-binding');
 const rows=await observe(wrapper,lock);
 if(contractDigest(fingerprints(rows))!==contractDigest(record.observations))fail('migration.observation-drift');
 for(const candidate of [record.supply.snapshotPath,record.supply.objectsPath]){
  const root=absoluteRoot(candidate);
  if(nested(wrapper,root)||nested(root,wrapper))fail('migration.preparation-location');
  if(!(await inspectDirectory(root)).exists)fail('migration.preparation-missing');
 }
 const expected=prepareLegacyUnityDeactivation([{provider:'codex',bytes:rows[0].bytes},{provider:'claude',bytes:rows[1].bytes}]);
 if(contractDigest(expected)!==contractDigest(record.deactivation))fail('migration.preflight-binding');
 const verified=await verifyPreparedSnapshot({...record.supply,manifest:{id:'unity-sdd',version:record.supply.version}});
 return {observed:true,pipeline:verified.manifest.id,runtime:'not-run',authorized:false};
}
