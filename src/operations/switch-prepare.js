import path from 'node:path';
import {tmpdir} from 'node:os';
import {prepareRemoval} from './remove.js';
import {composeSwitchPreview} from './switch.js';
import {composePlan,assertRequestScope} from './plan.js';
import {readState,resolveOrigin,verifyPreparedSnapshot,observeTargets} from './state.js';
import {absoluteRoot,inspectDirectory,resolveChild} from '../workspace/paths.js';
import {planLayout} from '../workspace/resolve.js';
import {acquire} from '../source/git.js';
import {contractDigest} from '../contracts/semantic.js';
import {fail,parse} from '../contracts/parse.js';
import {requestShape} from './ownership.js';
import {cap,LIMITS} from '../source/inventory.js';

// Staging only: never calls an executor or writes workspace/provider files.
// Registry is trusted CLI code; the Git package supplies data, not executable code.
export async function prepareSwitch({wrapper,manifestPath,network=false,tempRoot=tmpdir()},registry) {
  requestShape(registry,['adapters','sharedAdapter'],[],'provider.interface');
  wrapper=absoluteRoot(wrapper);
  await inspectDirectory(wrapper);
  const temporary=(await inspectDirectory(absoluteRoot(tempRoot))).path;
  const rel=path.relative(wrapper,temporary);
  if(!rel || (!rel.startsWith('..'+path.sep) && rel!=='..' && !path.isAbsolute(rel)))fail('plan.preparation-location');
  if(typeof manifestPath!=='string' || !manifestPath.length)fail('switch.manifest-required');
  const removal=await prepareRemoval(wrapper,registry);
  const statePath=resolveChild(wrapper,'.pipeline/state.json'),record=await readState(statePath);
  if(record.digest!==removal.stateFileHash)fail('switch.state-drift');
  const options={wrapper,previous:null,manifestPath,command:'setup'};
  const origin=await resolveOrigin(options);
  const acquired=await acquire(origin.manifest.pipeline,{manifestBase:origin.origin.base,tempRoot:temporary,network});
  if(acquired.resolvedSource!==origin.origin.resolvedSource)fail('source-rebind-required');
  const verified=await verifyPreparedSnapshot(acquired);
  const {adapters,sharedAdapter}=registry;
  const layout=planLayout(verified.manifest,origin.manifest,wrapper,{adapters});
  const snapshot={source:structuredClone(acquired.source),commit:acquired.commit,
    path:'.pipeline/snapshots/'+acquired.digest.slice(7),digest:acquired.digest,
    inventoryDigest:acquired.inventoryDigest,origin:structuredClone(origin.origin)};
  const context=()=>({pipeline:structuredClone(verified.manifest),workspace:structuredClone(origin.manifest),
    layout:structuredClone(layout),snapshot:structuredClone(snapshot),
    files:new Map([...verified.files].map(([name,bytes])=>[name,Buffer.from(bytes)]))});
  const requests=[];
  for(const [owner,adapter] of [['shared',sharedAdapter],...layout.providers.map(id=>[id,adapters[id]])]) {
    if(owner!=='shared' && (await adapter.validate(context()))?.valid===false)fail('provider.validation');
    const batch=await adapter.plan(context());
    if(!Array.isArray(batch))fail('plan.adapter-output');
    cap(requests.length+batch.length,LIMITS.files,'plan.count');
    for(const request of batch) {
      assertRequestScope(request,layout.providers);
      if(request.owner!==owner)fail('plan.adapter-owner');
      // Detach buffers/fields from asynchronous adapter-owned values.
      requests.push(request.kind==='file'?{...request,bytes:Buffer.isBuffer(request.bytes)?Buffer.from(request.bytes):request.bytes}:structuredClone(request));
    }
  }
  planLayout(verified.manifest,origin.manifest,wrapper,{adapters,managedPaths:requests.map(r=>r.path)});
  const observations=await observeTargets(wrapper,requests.map(r=>r.path));
  const removed=new Set(removal.preview.plan.targets.map(t=>t.path));
  const restored=new Map(removal.preview.outputs.map(o=>[o.path,Buffer.from(o.bytes,'base64')]));
  const projected=observations.map(o=>({path:o.path,bytes:removed.has(o.path)?restored.get(o.path)??null:o.bytes}));
  const replacement=composePlan({pipeline:verified.manifest,workspace:origin.manifest,wrapper,
    previous:null,snapshot,adapters,requests,observations:projected});
  const preview=composeSwitchPreview({previous:record.value,removal:removal.preview,replacement});
  // Recheck after all asynchronous adapter work. This is not an atomic read or
  // fresh apply approval; a future locked executor must repeat its preflight.
  if((await prepareRemoval(wrapper,registry)).digest!==removal.digest)fail('switch.removal-drift');
  if(contractDigest(await resolveOrigin(options))!==contractDigest(origin))fail('plan.origin-drift');
  await verifyPreparedSnapshot(acquired);
  const after=await observeTargets(wrapper,observations.map(o=>o.path));
  if(contractDigest(after)!==contractDigest(observations))fail('switch.observation-drift');
  if((await readState(statePath)).digest!==record.digest)fail('switch.state-drift');
  const body={kind:'prepared-switch',preview,removal,stateFileHash:record.digest,
    preparation:{objects:acquired.preparation,snapshot:acquired.snapshotPath},
    sourceVerification:'verified-at-preparation',applySupported:false,requiresFreshApproval:true,runtime:'not-run'};
  const copy=parse(JSON.stringify(body),'json');
  return {...copy,digest:contractDigest(copy)};
}
