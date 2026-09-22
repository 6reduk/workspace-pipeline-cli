import path from 'node:path';
import {validateSwitchRecord} from './switch-records.js';
import {assertLockHeld} from './lock.js';
import {prepareRemoval} from './remove.js';
import {readState,observeTargets,resolveOrigin,verifyPreparedSnapshot} from './state.js';
import {absoluteRoot,inspectDirectory,resolveChild} from '../workspace/paths.js';
import {planLayout} from '../workspace/resolve.js';
import {composePlan,assertRequestScope} from './plan.js';
import {contractDigest} from '../contracts/semantic.js';
import {fail} from '../contracts/parse.js';
import {sha256,cap,LIMITS} from '../source/inventory.js';

// Read-only locked preflight. No Git/network, persistence, provider writes or
// activation. A future executor must repeat relevant checks at write boundaries.
export async function verifySwitchApproval(lock,prepared,approval,registry,previous) {
  const bound=validateSwitchRecord(prepared,approval,previous),copy=bound.prepared;
  await assertLockHeld(lock);
  if(copy.preview.workspace!==lock.workspace)fail('switch-preflight.workspace');
  const workspace=lock.workspace,plan=copy.preview.phases[1].preview.plan;
  const snapshot={snapshotPath:copy.preparation.snapshot,manifest:{id:plan.desired.pipelineId,version:plan.desired.version},
    digest:plan.source.digest,inventoryDigest:plan.source.inventoryDigest};
  const options={wrapper:workspace,previous:null,manifestPath:plan.source.origin.path,command:'setup'};
  const nested=r=>!r || (!path.isAbsolute(r) && r!=='..' && !r.startsWith('..'+path.sep));
  async function verify() {
    await assertLockHeld(lock);
    for(const candidate of Object.values(copy.preparation)) {
      const root=absoluteRoot(candidate);
      if(nested(path.relative(workspace,root)) || nested(path.relative(root,workspace)))fail('switch-preflight.preparation-location');
      if(!(await inspectDirectory(root)).exists)fail('switch-preflight.preparation-missing');
    }
    const record=await readState(resolveChild(workspace,'.pipeline/state.json'));
    if(record.digest!==copy.stateFileHash || contractDigest(record.value)!==contractDigest(bound.previous))fail('switch-preflight.state-drift');
    // Full old-package replay also verifies installed snapshot and backup bytes.
    if(contractDigest(await prepareRemoval(workspace,registry))!==contractDigest(copy.removal))fail('switch-preflight.removal-drift');
    const origin=await resolveOrigin(options);
    if(contractDigest(origin.origin)!==contractDigest(plan.source.origin) ||
        contractDigest(origin.manifest.pipeline)!==contractDigest(plan.source.source))fail('switch-preflight.origin-drift');
    const verified=await verifyPreparedSnapshot(snapshot);
    const observations=await observeTargets(workspace,copy.preview.observations.map(o=>o.path));
    for(const o of observations) {
      const expected=copy.preview.observations.find(v=>v.path===o.path);
      if((o.bytes===null?null:sha256(o.bytes))!==expected.hash || (o.bytes===null?null:o.bytes.toString('base64'))!==expected.bytes)fail('switch-preflight.observation-drift');
    }
    if((await readState(resolveChild(workspace,'.pipeline/state.json'))).digest!==copy.stateFileHash)fail('switch-preflight.state-drift');
    await assertLockHeld(lock);
    return {origin,verified};
  }
  const {origin,verified}=await verify(),{adapters,sharedAdapter}=registry;
  const layout=planLayout(verified.manifest,origin.manifest,workspace,{adapters});
  const context=()=>({pipeline:structuredClone(verified.manifest),workspace:structuredClone(origin.manifest),layout:structuredClone(layout),snapshot:structuredClone(plan.source),
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
      requests.push(request.kind==='file'?{...request,bytes:Buffer.isBuffer(request.bytes)?Buffer.from(request.bytes):request.bytes}:structuredClone(request));
    }
  }
  const incoming=copy.preview.phases[1].preview;
  const observations=incoming.observations.map(o=>({path:o.path,bytes:o.bytes===null?null:Buffer.from(o.bytes,'base64')}));
  const rendered=composePlan({pipeline:verified.manifest,workspace:origin.manifest,wrapper:workspace,previous:null,
    snapshot:plan.source,adapters,requests,observations});
  if(contractDigest(rendered)!==contractDigest(incoming) || requests.length!==observations.length ||
      observations.some(o=>!requests.some(r=>r.path===o.path)))fail('switch-preflight.adapter-drift');
  // Async adapters may have changed dependencies: repeat the observations.
  await verify();
  return {...bound,snapshot,applySupported:false,runtime:'not-run'};
}
