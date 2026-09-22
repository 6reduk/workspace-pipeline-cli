// Full rendered proposal only: never pass setup directly to generic apply.
// It observes the virtual post-deactivation configuration, not current bytes.
import {fail,parse} from '../contracts/parse.js';
import {requestShape} from '../operations/ownership.js';
import {contractDigest} from '../contracts/semantic.js';
import {sha256} from '../source/inventory.js';
import {absoluteRoot} from '../workspace/paths.js';
import {planLayout} from '../workspace/resolve.js';
import {resolveOrigin,observeTargets,verifyPreparedSnapshot} from '../operations/state.js';
import {composePlan,assertRequestScope} from '../operations/plan.js';
import {providerRegistry} from '../providers/registry.js';
import {prepareLegacyUnityPreflight,recheckLegacyUnityPreflight} from './legacy-unity-preflight.js';

export async function prepareLegacyUnityPreview({wrapper,manifestPath,tempRoot,network=false}){
 wrapper=absoluteRoot(wrapper);
 const origin=await resolveOrigin({wrapper,manifestPath,command:'setup'});
 if(origin.manifest.bundles || [...(origin.manifest.providers??[])].sort().join(',')!=='claude,codex')fail('migration.providers');
 const preflight=await prepareLegacyUnityPreflight({wrapper,source:origin.manifest.pipeline,manifestBase:origin.origin.base,tempRoot,network});
 return renderLegacyUnityPreview(wrapper,origin,preflight);
}

async function renderLegacyUnityPreview(wrapper,origin,preflight,lock){
 const manifestPath=origin.origin.path;
 const verified=await verifyPreparedSnapshot({...preflight.supply,manifest:{id:'unity-sdd',version:preflight.supply.version}});
 const {adapters,sharedAdapter}=providerRegistry;
 const layout=planLayout(verified.manifest,origin.manifest,wrapper,{adapters});
 const snapshot={source:structuredClone(preflight.supply.source),commit:preflight.supply.commit,
  path:'.pipeline/snapshots/'+preflight.supply.digest.slice(7),digest:preflight.supply.digest,
  inventoryDigest:preflight.supply.inventoryDigest,origin:structuredClone(origin.origin)};
 const context=()=>({pipeline:structuredClone(verified.manifest),workspace:structuredClone(origin.manifest),
  layout:structuredClone(layout),snapshot:structuredClone(snapshot),files:new Map([...verified.files].map(([p,b])=>[p,Buffer.from(b)]))});
 const requests=[];
 for(const [owner,adapter] of [['shared',sharedAdapter],['codex',adapters.codex],['claude',adapters.claude]]){
  if(owner!=='shared'&&(await adapter.validate(context()))?.valid===false)fail('provider.validation');
  for(const request of await adapter.plan(context())){
   if(request.owner!==owner)fail('plan.adapter-owner');
   assertRequestScope(request,origin.manifest.providers);requests.push(request);
  }
 }
 const observed=await observeTargets(wrapper,requests.map(r=>r.path));
 const entries=[];
 for(const request of requests){
  if(!['AGENTS.md','CLAUDE.md'].includes(request.path))continue;
  const before=observed.find(r=>r.path===request.path)?.bytes;
  if(!Buffer.isBuffer(before)||request.kind!=='file')fail('migration.entry');
  request.takeover={beforeHash:sha256(before),desiredHash:sha256(request.bytes)};
  // Exact original entry content retained in the private approval proposal.
  entries.push({path:request.path,before:before.toString('base64'),after:request.bytes.toString('base64'),...request.takeover});
 }
 if(entries.length!==2)fail('migration.entry');
 const projected=observed.map(item=>{
  const change=preflight.deactivation.targets.find(t=>t.path===item.path);
  if(!change)return item;
  if(item.bytes===null||sha256(item.bytes)!==change.beforeHash)fail('migration.observation-drift');
  return {path:item.path,bytes:Buffer.from(change.after,'base64')};
 });
 const setup=composePlan({pipeline:verified.manifest,workspace:origin.manifest,wrapper,snapshot,
  adapters,requests,observations:projected});
 // All output dependencies, not just the legacy six, must still be unchanged.
 const fresh=await observeTargets(wrapper,requests.map(r=>r.path));
 const hashes=items=>items.map(x=>({path:x.path,hash:x.bytes===null?null:sha256(x.bytes)}));
 if(contractDigest(hashes(fresh))!==contractDigest(hashes(observed)))fail('migration.observation-drift');
 await recheckLegacyUnityPreflight(preflight,wrapper,lock);
 if(contractDigest(await resolveOrigin({wrapper,manifestPath,command:'setup'}))!==contractDigest(origin))fail('migration.origin-drift');
 const body={schemaVersion:1,kind:'legacy-unity-preview',workspace:wrapper,preflight,
  origin:origin.origin,entries,initialObservations:hashes(observed),setup,
  phases:['deactivate-legacy','install-local-delivery'],runtime:'not-run'};
 return {...body,digest:contractDigest(body)};
}

// Genuine approval is supplied by the caller. It binds the complete proposal,
// not its embedded setup phase. Re-render trusted adapters without acquiring Git.
// Read-only, no lock or write capability returned; execution must recheck again.
export async function verifyLegacyUnityPreview(proposal,approval,wrapper,lock){
 requestShape(approval,['decision','previewDigest'],[],'migration.approval');
 requestShape(proposal,['schemaVersion','kind','workspace','preflight','origin','entries','initialObservations','setup','phases','runtime','digest'],[],'migration.preview');
 if(approval.decision!=='approve'||approval.previewDigest!==proposal.digest)fail('migration.approval');
 // Limit serializable proposal complexity and detach before asynchronous reads.
 const copy=parse(JSON.stringify(proposal),'json');
 const {digest,...body}=copy;
 wrapper=absoluteRoot(wrapper);
 if(copy.workspace!==wrapper||copy.schemaVersion!==1||copy.kind!=='legacy-unity-preview'||contractDigest(body)!==digest)fail('migration.preview-binding');
 const origin=await resolveOrigin({wrapper,manifestPath:copy.origin.path,command:'setup'});
 if(origin.manifest.bundles || [...(origin.manifest.providers??[])].sort().join(',')!=='claude,codex'||
  contractDigest(origin.origin)!==contractDigest(copy.origin)||
  contractDigest(origin.manifest.pipeline)!==contractDigest(copy.preflight.supply.source))fail('migration.origin-drift');
 await recheckLegacyUnityPreflight(copy.preflight,wrapper,lock);
 const rebuilt=await renderLegacyUnityPreview(wrapper,origin,copy.preflight,lock);
 if(contractDigest(rebuilt)!==contractDigest(copy))fail('migration.render-drift');
 return rebuilt;
}
