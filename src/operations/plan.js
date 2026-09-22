import path from 'node:path';
import { tmpdir } from 'node:os';
import { fail, parse, ContractError } from '../contracts/parse.js';
import { validateOperation, validateState, contractDigest, portablePath } from '../contracts/semantic.js';
import { sha256, LIMITS, cap } from '../source/inventory.js';
import { planLayout } from '../workspace/resolve.js';
import { resolveChild, absoluteRoot, inspectDirectory } from '../workspace/paths.js';
import { overlaps } from '../workspace/reserved.js';
import { reconcileOwnership, requestShape } from './ownership.js';
import {reconcileConfigFields} from './config-fields.js';
import { acquire } from '../source/git.js';
import { readState, resolveOrigin, resolveApprovedRebind, verifyPreparedSnapshot, observeTargets } from './state.js';
import { commonEntryPath, commonEntryText, needsCommonEntry } from '../providers/common-entry.js';
import {planObservationPaths,retiredBundleOwnership,restoreRetired} from './bundle-update.js';

// Trusted CLI destination policy, not a claim about tested harness discovery.
const roots = {shared:['AGENTS.md','CLAUDE.md'],codex:['.codex/','.agents/skills/'],
  claude:['.claude/','CLAUDE.md','CLAUDE.local.md','.mcp.json'],kimi:['.kimi-code/'],grok:['.grok/']};

export function assertRequestScope(request, providers) {
  assertRequestShape(request);
  const {path:name,owner,kind}=request;
  portablePath(name);
  if (owner==='shared' && name===commonEntryPath &&
      (kind!=='file' || !needsCommonEntry(providers))) fail('plan.scope');
  if (!['file','json-fields','toml-fields'].includes(kind) || !(owner==='shared' || providers.includes(owner)) ||
      !roots[owner]?.some(root=>root.endsWith('/') ? name.startsWith(root) : name===root)) fail('plan.scope');
  // Project MCP config is shared with user-defined servers. Own only individual
  // named server entries, never the complete file or mcpServers parent object.
  if(['.mcp.json','.kimi-code/mcp.json'].includes(name) && (kind!=='json-fields' || request.fields.some(field=>
      !/^\/mcpServers\/[a-z][a-z0-9_-]{0,99}$/.test(field.pointer)))) fail('plan.scope');
  if(name==='.grok/config.toml' && (kind!=='toml-fields' || request.fields.some(field=>
      !/^\/mcp_servers\/[a-z][a-z0-9_-]{0,99}$/.test(field.pointer))))fail('plan.scope');
  if(kind==='toml-fields' && !((owner==='codex' && name==='.codex/config.toml') ||
      (owner==='grok' && name==='.grok/config.toml')))fail('plan.scope');
  if(kind==='json-fields' && ['.codex/config.toml','.grok/config.toml'].includes(name))fail('plan.scope');
}

function assertRequestShape(request) {
  requestShape(request, ['path','owner','kind'], ['bytes','takeover','fields'], 'plan.request');
  if (request.kind === 'file') requestShape(request, ['path','owner','kind','bytes'], ['takeover'], 'plan.request');
  else if (['json-fields','toml-fields'].includes(request.kind)) {
    requestShape(request, ['path','owner','kind','fields'], [], 'plan.request');
    if (!Array.isArray(request.fields) || !request.fields.length) fail('plan.fields');
    for (const field of request.fields) requestShape(field, ['pointer','present'], ['value','takeover'], 'plan.fields');
  }
}

// Source/setup/update preparation. Registry functions are trusted CLI code, never
// loaded from the source. Temporary acquisition must remain outside workspace.
// No harness/MCP launch, config write, trust grant or apply approval happens here.
export async function preparePlan({wrapper,manifestPath,adapters,sharedAdapter,network=false,tempRoot=tmpdir(),rebind}) {
  wrapper=absoluteRoot(wrapper);
  await inspectDirectory(wrapper);
  const temporary=(await inspectDirectory(absoluteRoot(tempRoot))).path;
  const rel=path.relative(wrapper,temporary);
  if(!rel || (!rel.startsWith('..'+path.sep) && rel!=='..' && !path.isAbsolute(rel))) fail('plan.preparation-location');
  if(!adapters || typeof adapters!=='object' || Array.isArray(adapters))fail('provider.interface');
  const statePath=resolveChild(wrapper,'.pipeline/state.json');
  async function currentState() {
    try{return await readState(statePath);}catch(error){if(error.code==='record.missing')return null;throw error;}
  }
  const before=await currentState(), previous=before?.value ?? null;
  if(previous!==null && previous.pending!==null) fail('state.pending');
  const options={wrapper,previous,manifestPath,command:previous?.active?'update':'setup'};
  const rebindOptions=()=>({...options,proposal:rebind?.proposal,approval:rebind?.approval});
  const origin=rebind ? await resolveApprovedRebind(rebindOptions()) : await resolveOrigin(options);
  const acquired=await acquire(origin.manifest.pipeline,{manifestBase:origin.origin.base,tempRoot:temporary,network});
  if(acquired.resolvedSource!==origin.origin.resolvedSource) fail('source-rebind-required');
  const verified=await verifyPreparedSnapshot(acquired);
  const layout=planLayout(verified.manifest,origin.manifest,wrapper,{adapters});
  if(!sharedAdapter || typeof sharedAdapter.plan!=='function') fail('plan.shared-adapter');
  const snapshot={source:structuredClone(acquired.source),commit:acquired.commit,path:'.pipeline/snapshots/'+acquired.digest.slice(7),
    digest:acquired.digest,inventoryDigest:acquired.inventoryDigest,origin:structuredClone(origin.origin)};
  const requests=[];
  const context=()=>({pipeline:structuredClone(verified.manifest),workspace:structuredClone(origin.manifest),
    layout:structuredClone(layout),snapshot:structuredClone(snapshot),
    files:new Map([...verified.files].map(([name,bytes])=>[name,Buffer.from(bytes)]))});
  for(const [owner,adapter] of [['shared',sharedAdapter],...layout.providers.map(id=>[id,adapters[id]])]) {
    if(owner!=='shared') {
      const validation=await adapter.validate(context());
      if(validation?.valid===false) fail('provider.validation');
    }
    const batch=await adapter.plan(context());
    if(!Array.isArray(batch)) fail('plan.adapter-output');
    for(const request of batch) {
      assertRequestShape(request);
      if(request.owner!==owner) fail('plan.adapter-owner');
      assertRequestScope(request,layout.providers);requests.push(request);
    }
    cap(requests.length,LIMITS.files,'plan.count');
  }
  planLayout(verified.manifest,origin.manifest,wrapper,{adapters,managedPaths:requests.map(r=>r.path)});
  const observations=await observeTargets(wrapper,planObservationPaths(requests,previous,layout));
  const preview=composePlan({pipeline:verified.manifest,workspace:origin.manifest,wrapper,previous,snapshot,adapters,requests,observations});
  const after=await currentState();
  if((after?.digest ?? null)!==(before?.digest ?? null)) fail('plan.state-drift');
  const finalOrigin=rebind ? await resolveApprovedRebind(rebindOptions()) : await resolveOrigin(options);
  if(contractDigest(finalOrigin)!==contractDigest(origin)) fail('plan.origin-drift');
  const body={kind:'prepared-plan',preview,stateFileHash:before?.digest ?? null,
    rebind:origin.rebind ?? null,preparation:{objects:acquired.preparation,snapshot:acquired.snapshotPath},runtime:'not-run'};
  const prepared={...body,digest:contractDigest(body)};
  assertRecoveryBudget(prepared,previous);
  return prepared;
}

// Conservative bound for the exact inline recovery format used by S5. Fixed-size
// hashes and false (longer than true) bound backup descriptors without reading or
// creating backup files. No approval is granted by this sizing-only placeholder.
export function assertRecoveryBudget(prepared,previous=null) {
  requestShape(prepared,['kind','preview','stateFileHash','rebind','preparation','runtime','digest'],[],'plan.recovery-input');
  requestShape(prepared.preview,['schemaVersion','plan','observations','outputs','digest'],[],'plan.recovery-input');
  validateOperation(prepared.preview.plan,previous);
  if(prepared.preview.plan.kind!=='plan' || !prepared.preview.plan.desired)fail('plan.recovery-input');
  const plan=prepared.preview.plan,paths=new Set(plan.desired.owned.map(o=>o.backup).filter(p=>p!==null));
  const hash='sha256:'+'0'.repeat(64);
  const backups=[...paths].map(path=>({path,hash,existing:false}));
  const pending={schemaVersion:1,workspace:plan.workspace,status:'needs-reconciliation',runtime:'not-run',
    active:previous?.active??null,pending:contractDigest(plan),...(previous?.activation?{activation:previous.activation}:{})};
  const activation={recovery:'.pipeline/transactions/00000000-0000-0000-0000-000000000000/recovery.json',
    recoveryHash:hash,journalHead:{sequence:20001,hash}};
  try {
    for(const value of [{schemaVersion:1,prepared,approval:{decision:'approve',preparedDigest:prepared.digest},previous,backups},
      pending,{...pending,status:'ready',active:plan.desired,pending:null,activation}])parse(JSON.stringify(value)+'\n','json');
  }catch(error){
    if(error instanceof ContractError && ['parse.size','parse.complexity'].includes(error.code))fail('plan.recovery-budget');
    throw error;
  }
}

// Pure setup/update composition. Requests must come from trusted CLI adapters,
// never executable source-package code. Source verification and filesystem
// observations must be coordinated by the outer planner before any apply.
export function composePlan({pipeline, workspace, wrapper, previous = null, snapshot, adapters, requests, observations}) {
  if (previous !== null) {
    validateState(previous);
    if (previous.pending !== null || previous.workspace !== wrapper) fail('plan.previous');
    if (previous.active && previous.active.pipelineId !== pipeline.id) fail('plan.switch-required');
  }
  if (!Array.isArray(requests) || !Array.isArray(observations)) fail('plan.input');
  cap(requests.length,LIMITS.files,'plan.count');
  for (const request of requests) assertRequestShape(request);
  const ordered = [...requests].sort((a,b)=>a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const layout = planLayout(pipeline,workspace,wrapper,{adapters,managedPaths:ordered.map(r=>r.path)});
  const observed = new Map(), used = new Set(), owned = [], targets = [], outputs = [];
  for (const observation of observations) {
    portablePath(observation.path);
    if (observed.has(observation.path)) fail('preview.duplicate');
    observed.set(observation.path,observation.bytes);
  }
  for (const request of ordered) {
    const {path: name,owner,kind} = request;
    resolveChild(layout.wrapper,name);
    assertRequestScope(request, layout.providers);
    if ([...used].some(prior=>overlaps(prior,name))) fail('plan.overlap');
    used.add(name);
    if (!observed.has(name)) fail('preview.before');
    const bytes = observed.get(name);
    if (bytes!==null && !Buffer.isBuffer(bytes)) fail('preview.bytes');
    const beforeHash = bytes===null ? null : sha256(bytes);
    const prior = previous?.active?.owned.filter(r=>r.path.toLowerCase()===name.toLowerCase()) ?? [];
    const entryMigration = name===commonEntryPath && owner==='shared' && kind==='file' &&
      prior.length===1 && prior[0].path===name && prior[0].owner==='claude' && prior[0].kind==='file' &&
      previous.active.adapterVersions.claude==='1' && layout.providers.includes('claude') &&
      adapters.claude?.version==='2' && Buffer.isBuffer(request.bytes) &&
      (layout.bundles || request.bytes.equals(Buffer.from(commonEntryText)));
    if (prior.some(r=>r.path!==name || (!entryMigration && r.owner!==owner) || r.kind!==(kind==='file'?'file':'field'))) fail('plan.ownership-kind');
    const retain = (old,pointer,currentHash,managedHash) => {
      if (old) return {...structuredClone(old),owner,managedHash};
      return {path:name,kind:pointer===null?'file':'field',pointer,owner,beforeHash:currentHash,managedHash,
        backup:currentHash===null ? null : '.pipeline/backups/'+contractDigest({name,pointer,beforeHash}).slice(7)+'.bin'};
    };
    let result, action, fields=[];
    if (kind==='file') {
      if (!Buffer.isBuffer(request.bytes)) fail('plan.bytes');
      const desiredHash=sha256(request.bytes);
      const decision=reconcileOwnership({currentHash:beforeHash,desiredHash,managedHash:prior[0]?.managedHash ?? null,takeover:request.takeover ?? null});
      if(decision.owned) owned.push(retain(prior[0],null,beforeHash,desiredHash));
      action=decision.action;result=request.bytes;
    } else {
      if (!Array.isArray(request.fields) || !request.fields.length || request.fields.some(f=>Object.hasOwn(f,'managedHash'))) fail('plan.fields');
      if (prior.some(p=>!request.fields.some(f=>f.pointer===p.pointer))) fail('plan.ownership-coverage');
      const reconciled=reconcileConfigFields(name,bytes,request.fields.map(f=>({...f,managedHash:prior.find(p=>p.pointer===f.pointer)?.managedHash ?? null})));
      for(const d of reconciled.decisions) if(d.owned) owned.push(retain(prior.find(p=>p.pointer===d.pointer),d.pointer,d.currentHash,d.desiredHash));
      fields=reconciled.decisions.filter(d=>d.action!=='preserve').map(d=>({pointer:d.pointer,beforeHash:d.currentHash,desiredHash:d.desiredHash}));
      action=fields.length ? (bytes===null?'create':'edit-fields') : 'preserve';
      result=action==='preserve' ? bytes : reconciled.bytes;
      if(action==='create') fields=[];
    }
    if(action!=='preserve') {
      targets.push({id:'target-'+String(targets.length+1),path:name,owner,action,beforeHash,desiredHash:sha256(result),fields});
      outputs.push({path:name,bytes:result});
    }
  }
  // Removal/provider switch is S7. Never silently abandon existing ownership.
  for(const restored of restoreRetired(retiredBundleOwnership(previous,layout),observed)) {
    if([...used].some(name=>overlaps(name,restored.path)))fail('plan.overlap');
    // Retirement cannot reach a newly selected repository destination.
    planLayout(pipeline,workspace,wrapper,{adapters,managedPaths:[...used,restored.path]});
    used.add(restored.path);
    if(restored.beforeHash!==restored.desiredHash) {
      const {bytes,...target}=restored;
      targets.push({id:'target-'+String(targets.length+1),...target});
      if(bytes!==null)outputs.push({path:restored.path,bytes});
    }
  }
  if(previous?.active?.owned.some(r=>!used.has(r.path))) fail('plan.ownership-coverage');
  const providers=layout.providers;
  const bundleState=layout.bundles?{bundles:structuredClone(layout.bundles)}:{};
  const agentsDocument=structuredClone(layout.agentsDocument);
  const desired={id:'deployment-'+contractDigest({snapshot,layout:layout.layout,agentsDocument,providers,owned,...bundleState}).slice(7),
    pipelineId:pipeline.id,version:pipeline.version,snapshot:structuredClone(snapshot),layout:layout.layout,
    agentsDocument,providers,adapterVersions:Object.fromEntries(providers.map(id=>[id,adapters[id].version])),owned,...bundleState};
  const plan={schemaVersion:1,kind:'plan',workspace:layout.wrapper,command:previous?.active?'update':'setup',
    beforeStateHash:previous===null?null:contractDigest(previous),source:structuredClone(snapshot),desired,targets};
  return bindPreview(plan,previous,{observations,outputs});
}

// A local preview envelope supplements the S1 operation contract with exact
// payload bytes and observations (including unchanged targets). Not an approval,
// path grant, snapshot verification or S5 transaction. Never publish this envelope:
// observed/output bytes can contain user configuration secrets.
export function bindPreview(plan, previous, { observations, outputs }) {
  validateOperation(plan, previous);
  if (plan.kind !== 'plan' || !Array.isArray(observations) || !Array.isArray(outputs)) fail('preview.input');
  cap(observations.length, LIMITS.files, 'preview.count');
  cap(outputs.length, LIMITS.files, 'preview.count');
  const seen = new Set();
  let total = 0;
  const encode = (items, allowAbsent) => items.map(item => {
    portablePath(item.path);
    if (seen.has(item.path.toLowerCase())) fail('preview.duplicate');
    seen.add(item.path.toLowerCase());
    if (item.bytes === null && allowAbsent) return {path:item.path,hash:null,bytes:null};
    if (!Buffer.isBuffer(item.bytes)) fail('preview.bytes');
    cap(item.bytes.length, LIMITS.blob, 'preview.size');
    total += item.bytes.length;cap(total, LIMITS.total, 'preview.total');
    return {path:item.path,hash:sha256(item.bytes),bytes:item.bytes.toString('base64')};
  }).sort((a,b)=>a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const observed = encode(observations, true);seen.clear();
  const payloads = encode(outputs, false);
  const before = new Map(observed.map(item=>[item.path,item]));
  const after = new Map(payloads.map(item=>[item.path,item]));
  for (const target of plan.targets) {
    if (!before.has(target.path) || before.get(target.path).hash !== target.beforeHash) fail('preview.before');
    if (target.desiredHash === null) {
      if (after.has(target.path)) fail('preview.output');
    } else if (!after.has(target.path) || after.get(target.path).hash !== target.desiredHash) fail('preview.output');
  }
  if (payloads.length !== plan.targets.filter(target=>target.desiredHash !== null).length) fail('preview.output');
  const body = {schemaVersion:1,plan:structuredClone(plan),observations:observed,outputs:payloads};
  return {...body,digest:contractDigest(body)};
}

// Reconstruct and revalidate, rather than trusting caller-provided digest strings.
// Fresh observations must include unchanged dependencies as well as write targets.
export function checkPreview(envelope, previous, observations) {
  if (!envelope || Object.keys(envelope).sort().join(',') !== 'digest,observations,outputs,plan,schemaVersion' || envelope.schemaVersion !== 1) fail('preview.envelope');
  const decode = items => {
    if (!Array.isArray(items)) fail('preview.envelope');
    return items.map(item=>{
      if (!item || Object.keys(item).sort().join(',') !== 'bytes,hash,path') fail('preview.envelope');
      if (item.bytes === null) {
        if (item.hash !== null) fail('preview.envelope');
        return {path:item.path,bytes:null};
      }
      if (typeof item.bytes !== 'string' || item.bytes.length > Math.ceil(LIMITS.blob/3)*4) fail('preview.bytes');
      const bytes = Buffer.from(item.bytes,'base64');
      if (bytes.toString('base64') !== item.bytes || sha256(bytes) !== item.hash) fail('preview.bytes');
      return {path:item.path,bytes};
    });
  };
  const rebound = bindPreview(envelope.plan, previous, {observations:decode(envelope.observations),outputs:decode(envelope.outputs)});
  if (contractDigest(rebound) !== contractDigest(envelope)) fail('preview.binding');
  const fresh = bindPreview(envelope.plan, previous, {observations,outputs:decode(envelope.outputs)});
  if (fresh.digest !== rebound.digest) fail('preview.drift');
  return rebound;
}
