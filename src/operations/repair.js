import {readState,verifyInstalledSnapshot,observeTargets} from './state.js';
import {absoluteRoot,resolveChild} from '../workspace/paths.js';
import {planLayout} from '../workspace/resolve.js';
import {assertRequestScope,bindPreview} from './plan.js';
import {assertLockHeld} from './lock.js';
import {requestShape,reconcileFields} from './ownership.js';
import {readConfigField,reconcileConfigFields} from './config-fields.js';
import {contractDigest} from '../contracts/semantic.js';
import {fail,parse} from '../contracts/parse.js';
import {sha256,cap,LIMITS} from '../source/inventory.js';
import {installedSelection} from '../providers/bundles.js';

const hash=bytes=>bytes===null?null:sha256(bytes);
const key=(name,pointer)=>JSON.stringify([name,pointer]);
function at(root,pointer) {
  let node=root;
  for(const part of pointer.slice(1).split('/').map(p=>p.replace(/~1/g,'/').replace(/~0/g,'~'))) {
    if(node===null || typeof node!=='object' || Array.isArray(node))fail('repair.field-ancestor');
    if(!Object.hasOwn(node,part))return {present:false};
    node=node[part];
  }
  return {present:true,value:node};
}

// Read-only inspection, NOT a prepared repair/apply envelope. All requests are
// replayed from installed bytes by trusted adapters; owned value hashes must
// match state. User changes become conflicts, never rewritten ownership records.
async function observeRepair(workspace,registry) {
  requestShape(registry,['adapters','sharedAdapter'],[],'provider.interface');
  if(!registry.adapters || typeof registry.adapters!=='object' || Array.isArray(registry.adapters) ||
      typeof registry.sharedAdapter?.plan!=='function')fail('provider.interface');
  workspace=absoluteRoot(workspace);
  const filename=resolveChild(workspace,'.pipeline/state.json'),record=await readState(filename),state=record.value;
  if(state.workspace!==workspace || !state.active)fail('repair.state');
  if(state.pending!==null)fail('repair.pending');
  const active=state.active,installed=await verifyInstalledSnapshot(state);
  const manifest={schemaVersion:1,pipeline:structuredClone(active.snapshot.source),
    ...installedSelection(active),layout:structuredClone(active.layout),
    ...(active.agentsDocument?{agentsDocument:structuredClone(active.agentsDocument)}:{})};
  const layout=planLayout(installed.manifest,manifest,workspace,{adapters:registry.adapters});
  const context=()=>({pipeline:structuredClone(installed.manifest),workspace:structuredClone(manifest),
    installedAdapterVersions:structuredClone(active.adapterVersions),
    layout:structuredClone(layout),snapshot:structuredClone(active.snapshot),
    files:new Map([...installed.files].map(([name,bytes])=>[name,Buffer.from(bytes)]))});
  const desired=new Map(),requests=[];let totalBytes=0;
  for(const [owner,adapter] of [['shared',registry.sharedAdapter],...active.providers.map(id=>[id,registry.adapters[id]])]) {
    if(owner!=='shared' && (await adapter.validate(context()))?.valid===false)fail('provider.validation');
    const batch=await adapter.plan(context());
    if(!Array.isArray(batch))fail('plan.adapter-output');
    cap(requests.length+batch.length,LIMITS.files,'plan.count');
    for(const request of batch) {
      assertRequestScope(request,active.providers);
      if(request.owner!==owner)fail('plan.adapter-owner');
      if(requests.some(r=>r.path===request.path))fail('plan.overlap');
      requests.push(request);
      const add=(pointer,desiredHash,value)=>{
        const id=key(request.path,pointer);if(desired.has(id))fail('repair.duplicate');
        desired.set(id,{owner,hash:desiredHash,value});
      };
      if(request.kind==='file') {
        if(!Buffer.isBuffer(request.bytes))fail('plan.bytes');
        cap(request.bytes.length,LIMITS.blob,'preview.size');totalBytes+=request.bytes.length;
        add(null,sha256(request.bytes),Buffer.from(request.bytes));
      } else {
        // Historical takeover decisions are not fresh authority. Inspection only
        // reconstructs desired values, without reusing those decisions.
        const fields=request.fields.map(f=>f.present?{pointer:f.pointer,present:true,value:f.value}:{pointer:f.pointer,present:false});
        const reconciled=reconcileFields({},fields);
        totalBytes+=Buffer.byteLength(JSON.stringify(reconciled.value));
        for(const decision of reconciled.decisions) add(decision.pointer,decision.desiredHash,at(reconciled.value,decision.pointer).value);
      }
      cap(totalBytes,LIMITS.total,'preview.total');
    }
  }
  planLayout(installed.manifest,manifest,workspace,{adapters:registry.adapters,managedPaths:requests.map(r=>r.path)});
  const names=[...new Set(active.owned.map(o=>o.path))],observations=await observeTargets(workspace,names);
  const current=new Map(observations.map(o=>[o.path,o.bytes])),entries=[];
  for(const owned of active.owned) {
    const expected=desired.get(key(owned.path,owned.pointer));
    if(!expected || expected.owner!==owned.owner || expected.hash!==owned.managedHash)fail('repair.replay-mismatch');
    const bytes=current.get(owned.path);let currentHash=null,malformed=false;
    if(bytes!==null) {
      if(owned.kind==='file')currentHash=sha256(bytes);
      else {
        try{const field=readConfigField(owned.path,bytes,owned.pointer);if(field.present)currentHash=contractDigest(field.value);}
        catch{malformed=true;}
      }
    }
    entries.push({path:owned.path,owner:owned.owner,kind:owned.kind,pointer:owned.pointer,
      managedHash:owned.managedHash,currentHash,fileHash:hash(bytes),
      disposition:malformed?'conflict':currentHash===owned.managedHash?'intact':currentHash===null?'missing':'conflict'});
  }
  if((await readState(filename)).digest!==record.digest)fail('repair.observation-drift');
  await verifyInstalledSnapshot(state);
  for(const observation of await observeTargets(workspace,names))
    if(hash(observation.bytes)!==hash(current.get(observation.path)))fail('repair.observation-drift');
  const body={kind:'repair-inspection',workspace,stateHash:record.digest,snapshot:active.snapshot.digest,entries,
    runtime:'not-run',automaticActions:false,applySupported:false,requiresFreshApproval:true};
  return {inspection:{...body,digest:contractDigest(body)},current,desired};
}

export async function inspectRepair(workspace,registry) {
  return (await observeRepair(workspace,registry)).inspection;
}

// Private preview payloads can include foreign configuration siblings. Do not
// print/publish this envelope as a diagnostic. No write/approval happens here.
export async function prepareRepairPreview(workspace,registry) {
  const {inspection,current,desired}=await observeRepair(workspace,registry);
  const blockers=inspection.entries.filter(e=>e.disposition==='conflict'),targets=[],outputs=[];
  // Whole-preview fail closed: no partial execution when another target conflicts.
  if(!blockers.length) {
    for(const name of [...new Set(inspection.entries.filter(e=>e.disposition==='missing').map(e=>e.path))].sort()) {
      const entries=inspection.entries.filter(e=>e.path===name && e.disposition==='missing');
      const before=current.get(name);let bytes;
      if(entries[0].kind==='file')bytes=desired.get(key(name,null)).value;
      else {
        const fields=entries.map(e=>({pointer:e.pointer,present:true,value:desired.get(key(name,e.pointer)).value}));
        bytes=reconcileConfigFields(name,before,fields).bytes;
      }
      targets.push({path:name,action:before===null?'create':'edit-fields',beforeHash:hash(before),desiredHash:sha256(bytes),
        fields:entries.filter(e=>e.pointer!==null).map(e=>({pointer:e.pointer,desiredHash:e.managedHash}))});
      outputs.push({path:name,bytes:bytes.toString('base64')});
    }
  }
  const body={kind:'repair-preview',inspection,targets,outputs,blockers,
    requiresFreshApproval:true,applySupported:false,automaticActions:false,runtime:'not-run'};
  parse(JSON.stringify(body),'json');
  return {...body,digest:contractDigest(body)};
}

// Native operation contract, deliberately distinct from a source-based prepared
// setup/update. Preserve deployment identity and
// original backup lineage; repair never converts observed drift into ownership.
export async function prepareRepairPlan(workspace,registry) {
  const candidate=await prepareRepairPreview(workspace,registry);
  if(candidate.blockers.length)fail('repair.conflict');
  workspace=candidate.inspection.workspace;
  const record=await readState(resolveChild(workspace,'.pipeline/state.json'));
  if(record.digest!==candidate.inspection.stateHash)fail('repair.observation-drift');
  const previous=record.value;
  const names=[...new Set(candidate.inspection.entries.map(e=>e.path))];
  const observations=await observeTargets(workspace,names);
  for(const observation of observations) {
    const expected=candidate.inspection.entries.find(e=>e.path===observation.path);
    if(hash(observation.bytes)!==expected.fileHash)fail('repair.observation-drift');
  }
  const targets=candidate.targets.map((t,i)=>({id:'target-'+String(i+1),path:t.path,
    owner:candidate.inspection.entries.find(e=>e.path===t.path).owner,
    action:t.action,beforeHash:t.beforeHash,desiredHash:t.desiredHash,
    fields:t.action==='edit-fields'?t.fields.map(f=>({...f,beforeHash:null})):[]}));
  const plan={schemaVersion:1,kind:'plan',workspace,command:'repair',
    beforeStateHash:contractDigest(previous),source:structuredClone(previous.active.snapshot),
    desired:structuredClone(previous.active),targets};
  const preview=bindPreview(plan,previous,{observations,
    outputs:candidate.outputs.map(o=>({path:o.path,bytes:Buffer.from(o.bytes,'base64')}))});
  await verifyInstalledSnapshot(previous);
  if((await readState(resolveChild(workspace,'.pipeline/state.json'))).digest!==record.digest)fail('repair.observation-drift');
  const body={kind:'prepared-repair',preview,stateFileHash:record.digest,
    runtime:'not-run',applySupported:true,requiresFreshApproval:true};
  parse(JSON.stringify(body),'json');
  return {...body,digest:contractDigest(body)};
}

// Read-only approval/preflight, not authority for a caller-provided payload.
// Replay the entire plan under the caller's live lock, including unchanged
// dependencies. No original source/manifest lookup and no old approval reuse.
export function validateRepairRecord(prepared,approval) {
  requestShape(prepared,['kind','preview','stateFileHash','runtime','applySupported','requiresFreshApproval','digest'],[],'repair.prepared');
  requestShape(approval,['decision','preparedDigest'],[],'repair.approval');
  const copy=parse(JSON.stringify(prepared),'json'),decision=structuredClone(approval);
  const {digest,...body}=copy;
  if(copy.kind!=='prepared-repair' || copy.runtime!=='not-run' || copy.applySupported!==true ||
      copy.requiresFreshApproval!==true || contractDigest(body)!==digest)fail('repair.prepared');
  if(decision.decision!=='approve' || decision.preparedDigest!==digest)fail('repair.approval');
  if(copy.preview?.plan?.command!=='repair')fail('repair.prepared');
  return structuredClone(copy);
}

export async function verifyRepairApproval(lock,prepared,approval,registry) {
  const copy=validateRepairRecord(prepared,approval);
  await assertLockHeld(lock);
  if(copy.preview?.plan?.workspace!==lock.workspace)fail('repair.workspace');
  const fresh=await prepareRepairPlan(lock.workspace,registry);
  if(contractDigest(fresh)!==contractDigest(copy))fail('repair.plan-drift');
  await assertLockHeld(lock);
  return fresh;
}
