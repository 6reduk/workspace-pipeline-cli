import {composeSwitchPreview} from './switch.js';
import {contractDigest} from '../contracts/semantic.js';
import {parse,fail} from '../contracts/parse.js';
import {requestShape} from './ownership.js';

// Pure event interpretation only. Hash assertions do not replace filesystem
// readback, trusted preparation, approval, locking, or durable journal storage.
export function inspectSwitchEvents(preview,previous,events) {
  if(!Array.isArray(events))fail('switch-journal.count');
  const cursor=createSwitchEventCursor(preview,previous);
  for(const event of parse(JSON.stringify(events),'json'))cursor.append(event);
  return cursor.inspect();
}

// Internal incremental cursor. A failed append poisons it; durable writers must
// never continue a cursor whose disk append/readback failed either.
export function createSwitchEventCursor(preview,previous) {
  const copy=parse(JSON.stringify(preview),'json');
  if(!Array.isArray(copy.phases) || copy.phases.length!==2)fail('switch-journal.preview');
  const fresh=composeSwitchPreview({previous,removal:copy.phases[0].preview,replacement:copy.phases[1].preview});
  if(contractDigest(copy)!==contractDigest(fresh))fail('switch-journal.preview');
  const maxEvents=3+2*fresh.phases.reduce((n,p)=>n+p.preview.plan.targets.length,0);
  const projected=new Map(fresh.observations.map(o=>[o.path,o.hash]));
  const projectionDigest=()=>contractDigest([...projected].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([path,hash])=>({path,hash})));
  let head=null,phaseIndex=0,nextIndex=0,pending=null,stopped=null,started=false,sequence=0,broken=false;
  function append(value) {
    if(broken)fail('switch-journal.unavailable');
    try {
    if(sequence>=maxEvents)fail('switch-journal.count');
    const event=parse(JSON.stringify(value),'json'),seq=sequence;
    requestShape(event,['schemaVersion','seq','previous','previewDigest','kind','payload'],[],'switch-journal.event');
    if(event.schemaVersion!==1 || event.seq!==seq || event.previous!==head || event.previewDigest!==fresh.digest)fail('switch-journal.binding');
    if(seq===0) {
      if(event.kind!=='start' || event.payload!==null)fail('switch-journal.sequence');
      started=true;
    }else {
      if(stopped!==null || phaseIndex===2)fail('switch-journal.sequence');
      const phase=fresh.phases[phaseIndex],targets=phase.preview.plan.targets,target=targets[nextIndex];
      if(event.kind==='intent') {
        requestShape(event.payload,['phase','operationId'],[],'switch-journal.payload');
        if(pending!==null || !target || event.payload.phase!==phase.name || event.payload.operationId!==target.id)fail('switch-journal.sequence');
        pending={phase:phase.name,operationId:target.id};
      }else if(event.kind==='outcome') {
        requestShape(event.payload,['phase','operationId','status','observedHash'],[],'switch-journal.payload');
        const p=event.payload;
        if(pending===null || p.phase!==pending.phase || p.operationId!==pending.operationId)fail('switch-journal.sequence');
        if(!['completed','failed','uncertain'].includes(p.status) ||
            (p.observedHash!==null && !/^sha256:[a-f0-9]{64}(?![\s\S])/.test(p.observedHash)) ||
            (p.status==='completed' && p.observedHash!==target.desiredHash) ||
            (p.status==='failed' && p.observedHash!==target.beforeHash))fail('switch-journal.outcome');
        if(p.status==='completed')projected.set(target.path,target.desiredHash);
        else stopped=p.status;
        nextIndex++;pending=null;
      }else if(event.kind==='phase-checked') {
        requestShape(event.payload,['phase','projectionDigest'],[],'switch-journal.payload');
        if(pending!==null || nextIndex!==targets.length || event.payload.phase!==phase.name ||
            event.payload.projectionDigest!==projectionDigest())fail('switch-journal.phase-check');
        phaseIndex++;nextIndex=0;
      }else fail('switch-journal.sequence');
    }
    head=contractDigest(event);
    sequence++;
    return position();
    }catch(error){broken=true;throw error;}
  }
  function position(){return {kind:'switch-event-inspection',previewDigest:fresh.digest,sequence,head,
    status:!started?'not-started':stopped??(pending!==null?'uncertain':phaseIndex===2?'completed':'open'),
    phase:phaseIndex===2?null:fresh.phases[phaseIndex].name,nextIndex,pending:pending?{...pending}:null,
    verifiedPhases:phaseIndex,activationSupported:false,runtime:'not-run'};}
  return Object.freeze({maxEvents,append,inspect:()=>({...position(),pending:pending?{...pending}:null,expectedProjectionDigest:projectionDigest()})});
}
