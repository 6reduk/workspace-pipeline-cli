import {checkPreview} from './plan.js';
import {contractDigest,validateState} from '../contracts/semantic.js';
import {requestShape} from './ownership.js';
import {fail,parse} from '../contracts/parse.js';

const decode=items=>items.map(o=>({path:o.path,bytes:o.bytes===null?null:Buffer.from(o.bytes,'base64')}));

// Pure phase composition, NOT a source verifier, write grant or executable plan.
// The caller must stage/verify the incoming Git package and replay both registries
// before obtaining an approval for any future switch executor.
export function composeSwitchPreview({previous,removal,replacement}) {
  validateState(previous);
  if(previous.status!=='ready' || !previous.active || previous.pending!==null)fail('switch.previous');
  requestShape(removal,['schemaVersion','plan','observations','outputs','digest'],[],'switch.preview');
  requestShape(replacement,['schemaVersion','plan','observations','outputs','digest'],[],'switch.preview');
  const old=checkPreview(removal,previous,decode(removal.observations));
  const incoming=checkPreview(replacement,null,decode(replacement.observations));
  if(old.plan.command!=='remove' || old.plan.desired!==null || old.plan.workspace!==previous.workspace ||
      contractDigest(old.plan.source)!==contractDigest(previous.active.snapshot))fail('switch.removal');
  if(incoming.plan.command!=='setup' || incoming.plan.workspace!==previous.workspace || !incoming.plan.desired)fail('switch.replacement');
  if(incoming.plan.desired.pipelineId===previous.active.pipelineId)fail('switch.same-pipeline');
  if(incoming.plan.source.digest===previous.active.snapshot.digest)fail('switch.source-identity');
  if(contractDigest(incoming.plan.desired.layout)!==contractDigest(previous.active.layout))fail('switch.layout-change');

  const initial=new Map(old.observations.map(o=>[o.path,o]));
  const removed=new Map(old.plan.targets.map(t=>[t.path,t.desiredHash]));
  const restored=new Map(old.outputs.map(o=>[o.path,o]));
  for(const observation of incoming.observations) {
    if([...initial.keys()].some(name=>name!==observation.path && name.toLowerCase()===observation.path.toLowerCase()))fail('switch.path-alias');
    if(initial.has(observation.path)) {
      const expected=removed.has(observation.path)?removed.get(observation.path):initial.get(observation.path).hash;
      if(observation.hash!==expected)fail('switch.projected-before');
      const expectedBytes=removed.has(observation.path)?restored.get(observation.path)?.bytes??null:initial.get(observation.path).bytes;
      if(observation.bytes!==expectedBytes)fail('switch.projected-before');
    }else initial.set(observation.path,observation);
  }
  // All old managed scope must have been observed even when the incoming package
  // no longer mentions it; its removal must never depend on new adapter coverage.
  if(previous.active.owned.some(o=>!old.observations.some(v=>v.path===o.path)))fail('switch.old-coverage');
  const final=new Map(initial);
  for(const phase of [old,incoming]) {
    const outputs=new Map(phase.outputs.map(o=>[o.path,o]));
    for(const t of phase.plan.targets)final.set(t.path,outputs.get(t.path)??{path:t.path,hash:null,bytes:null});
  }
  const body={kind:'switch-phase-preview',workspace:previous.workspace,beforeStateHash:contractDigest(previous),
    fromPipeline:previous.active.pipelineId,toPipeline:incoming.plan.desired.pipelineId,
    phases:[{name:'remove-old',preview:old},{name:'install-new',preview:incoming}],
    observations:[...initial.values()].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0),
    results:[...final.values()].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0),
    applySupported:false,requiresFreshApproval:true,sourceVerification:'not-verified',runtime:'not-run'};
  const copy=parse(JSON.stringify(body),'json');return {...copy,digest:contractDigest(copy)};
}
