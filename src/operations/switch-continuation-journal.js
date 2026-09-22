import {contractDigest,portablePath} from '../contracts/semantic.js';
import {parse,fail} from '../contracts/parse.js';
import {requestShape} from './ownership.js';

const hash=v=>typeof v==='string' && /^sha256:[a-f0-9]{64}(?![\s\S])/.test(v);
const nullableHash=v=>v===null || hash(v);
const detach=v=>parse(JSON.stringify(v),'json');

// Pure interpretation of an already verified continuation preview. This does
// not establish source provenance, approval, locking or actual disk readback.
// The future durable executor must verifySwitchContinuationApproval first.
export function createSwitchContinuationCursor(preview) {
  const p=detach(preview),{digest,...body}=p;
  if(p.kind!=='switch-continuation-preview' || !hash(digest) || contractDigest(body)!==digest ||
      p.applySupported!==false || p.requiresFreshApproval!==true || p.runtime!=='not-run' ||
      !Array.isArray(p.observations) || !Array.isArray(p.remaining) || (p.uncertain!==null && !p.remaining.length) || p.remaining.length>2)
    fail('switch-continuation-journal.preview');
  const projected=new Map();
  for(const o of p.observations) {
    requestShape(o,['path','hash'],[],'switch-continuation-journal.observation');portablePath(o.path);
    if(projected.has(o.path) || !nullableHash(o.hash))fail('switch-continuation-journal.observation');
    projected.set(o.path,o.hash);
  }
  let count=0;
  for(let i=0;i<p.remaining.length;i++) {
    const phase=p.remaining[i],seen=new Set();
    requestShape(phase,['phase','operations','phaseCheckRequired'],[],'switch-continuation-journal.phase');
    if(phase.phase!==(p.remaining.length===2 && i===0?'remove-old':'install-new') ||
        phase.phaseCheckRequired!==true || !Array.isArray(phase.operations))fail('switch-continuation-journal.phase');
    for(let j=0;j<phase.operations.length;j++) {
      const t=phase.operations[j];
      requestShape(t,['operationId','path','resolution','beforeHash','desiredHash'],[],'switch-continuation-journal.target');
      if(typeof t.operationId!=='string' || !t.operationId || seen.has(t.operationId) ||
          !projected.has(t.path) || !nullableHash(t.beforeHash) || !nullableHash(t.desiredHash) ||
          !(i===0 && j===0?(p.uncertain===null?['verify-desired','apply-approved-target']:['verify-desired','retry-approved-target']):['apply-approved-target']).includes(t.resolution))
        fail('switch-continuation-journal.target');
      seen.add(t.operationId);count++;
    }
  }
  const first=p.remaining[0]?.operations[0];
  if((p.uncertain!==null && !first) || (first && projected.get(first.path)!==(first.resolution==='verify-desired'?first.desiredHash:first.beforeHash)))
    fail('switch-continuation-journal.observation');
  const projectionDigest=()=>contractDigest([...projected].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([path,hash])=>({path,hash})));
  const maxEvents=1+p.remaining.length+2*count;
  let sequence=0,head=null,phaseIndex=0,nextIndex=0,pending=null,stopped=null,broken=false;
  const inspect=()=>({kind:'switch-continuation-event-inspection',previewDigest:digest,sequence,head,
    status:sequence===0?'not-started':stopped??(pending?'uncertain':phaseIndex===p.remaining.length?'completed':'open'),
    phase:phaseIndex===p.remaining.length?null:p.remaining[phaseIndex].phase,nextIndex,
    pending:pending?{...pending}:null,verifiedPhases:phaseIndex,expectedProjectionDigest:projectionDigest(),
    activationSupported:false,runtime:'not-run'});
  function append(value) {
    if(broken)fail('switch-continuation-journal.unavailable');
    try {
      const e=detach(value);
      requestShape(e,['schemaVersion','seq','previous','previewDigest','kind','payload'],[],'switch-continuation-journal.event');
      if(sequence>=maxEvents || e.schemaVersion!==1 || e.seq!==sequence || e.previous!==head || e.previewDigest!==digest)
        fail('switch-continuation-journal.binding');
      if(sequence===0) {
        if(e.kind!=='start' || contractDigest(e.payload)!==contractDigest(p.predecessor))fail('switch-continuation-journal.start');
      }else {
        if(stopped || phaseIndex===p.remaining.length)fail('switch-continuation-journal.sequence');
        const phase=p.remaining[phaseIndex],t=phase.operations[nextIndex];
        if(e.kind==='phase-checked') {
          requestShape(e.payload,['phase','projectionDigest'],[],'switch-continuation-journal.payload');
          if(pending || t || e.payload.phase!==phase.phase || e.payload.projectionDigest!==projectionDigest())
            fail('switch-continuation-journal.phase-check');
          phaseIndex++;nextIndex=0;
        }else {
          const intent=e.kind==='intent',readback=e.kind==='readback';
          requestShape(e.payload,intent?['phase','operationId']:['phase','operationId','status','observedHash'],[],
            'switch-continuation-journal.payload');
          const v=e.payload;
          if(!t || v.phase!==phase.phase || v.operationId!==t.operationId)fail('switch-continuation-journal.sequence');
          if(intent) {
            if(pending || t.resolution==='verify-desired' || projected.get(t.path)!==t.beforeHash)
              fail('switch-continuation-journal.sequence');
            pending={phase:phase.phase,operationId:t.operationId};
          }else {
            if(readback?pending || t.resolution!=='verify-desired':e.kind!=='outcome' || !pending)
              fail('switch-continuation-journal.sequence');
            if(!['completed','failed','uncertain'].includes(v.status) || !nullableHash(v.observedHash) ||
                (v.status==='completed' && v.observedHash!==t.desiredHash) ||
                (v.status==='failed' && v.observedHash!==(readback?t.desiredHash:t.beforeHash)))
              fail('switch-continuation-journal.outcome');
            if(v.status==='completed')projected.set(t.path,t.desiredHash);else stopped=v.status;
            nextIndex++;pending=null;
          }
        }
      }
      head=contractDigest(e);sequence++;return inspect();
    }catch(error){broken=true;throw error;}
  }
  return Object.freeze({append,inspect,maxEvents});
}
