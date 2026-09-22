import {parse,fail} from '../contracts/parse.js';
import {requestShape} from './ownership.js';
import {contractDigest} from '../contracts/semantic.js';
import {absoluteRoot} from '../workspace/paths.js';
import {createSwitchContinuationCursor} from './switch-continuation-journal.js';

const hash=v=>typeof v==='string' && /^sha256:[a-f0-9]{64}(?![\s\S])/.test(v);
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const journalPath=new RegExp('^\\.pipeline/journals/'+uuid+'(?![\\s\\S])');
const recoveryPath=new RegExp('^\\.pipeline/transactions/('+uuid+')/recovery.json(?![\\s\\S])');
const detach=v=>parse(JSON.stringify(v),'json');

// Structural envelope only. Durable validation must also check the predecessor.
export function createSwitchContinuationRecoveryRecord({preview,approval,journal}) {
  const p=detach(preview),a=detach(approval);
  requestShape(p,['kind','workspace','recoveryPath','recoveryHash','predecessor','stateFileHash','observations','uncertain','remaining',
    'requiresFreshApproval','applySupported','runtime','digest'],[],'switch-continuation-record.preview');
  requestShape(a,['decision','previewDigest'],[],'switch-continuation-record.approval');
  requestShape(p.predecessor,['pending','journal','sequence','head','lastFileHash'],[],'switch-continuation-record.predecessor');
  if(p.uncertain!==null)requestShape(p.uncertain,['phase','operationId','path','beforeHash','desiredHash','observedHash','resolution'],[],
    'switch-continuation-record.uncertain');
  absoluteRoot(p.workspace);createSwitchContinuationCursor(p);
  const source=typeof p.recoveryPath==='string' && recoveryPath.exec(p.recoveryPath);
  if(!source || p.predecessor.journal!=='.pipeline/journals/'+source[1] ||
      ![p.recoveryHash,p.stateFileHash,p.predecessor.pending,p.predecessor.head,p.predecessor.lastFileHash].every(hash) ||
      !Number.isSafeInteger(p.predecessor.sequence) || p.predecessor.sequence<(p.uncertain===null?1:2))fail('switch-continuation-record.predecessor');
  if(a.decision!=='approve' || a.previewDigest!==p.digest)fail('switch-continuation-record.approval');
  if(typeof journal!=='string' || !journalPath.test(journal) || journal===p.predecessor.journal)fail('switch-continuation-record.journal');
  const body={schemaVersion:1,kind:'switch-continuation-recovery',preview:p,approval:a,journal,
    activationSupported:false,runtime:'not-run'};
  return detach({...body,digest:contractDigest(body)});
}

export function validateSwitchContinuationRecoveryRecord(value) {
  const record=detach(value);
  requestShape(record,['schemaVersion','kind','preview','approval','journal','activationSupported','runtime','digest'],[],
    'switch-continuation-record.recovery');
  const fresh=createSwitchContinuationRecoveryRecord(record);
  if(contractDigest(record)!==contractDigest(fresh))fail('switch-continuation-record.recovery');
  return fresh;
}

// Compare to verified immutable predecessor evidence, not current target bytes.
export function assertSwitchContinuationPredecessor(preview,evidence) {
  const {record,journal}=evidence,p=preview;
  // The caller must first verify the predecessor envelope, journal and ancestry.
  // This pure check accepts either kind but grants no filesystem authority.
  const continuation=record.kind==='switch-continuation-recovery';
  if(!continuation && record.kind!=='switch-recovery')fail('switch-continuation-record.lineage');
  const base=continuation?{
    observations:record.preview.observations,
    phases:record.preview.remaining.map(phase=>({name:phase.phase,preview:{plan:{targets:
      phase.operations.map(t=>({...t,id:t.operationId}))}}}))
  }:record.prepared.preview;
  const workspace=continuation?record.preview.workspace:record.previous.workspace;
  const expectedParent={pending:record.digest,journal:record.journal,sequence:journal.sequence,
    head:journal.head,lastFileHash:journal.lastFileHash};
  if(!(p.uncertain===null?['open','completed']:['uncertain']).includes(journal.status) || evidence.fileHash!==p.recoveryHash || workspace!==p.workspace ||
      contractDigest(expectedParent)!==contractDigest(p.predecessor))fail('switch-continuation-record.lineage');
  if(p.uncertain===null) {
    if(journal.pending)fail('switch-continuation-record.lineage');
    const expected=new Map(base.observations.map(o=>[o.path,o.hash]));
    for(let i=0;i<base.phases.length;i++) {
      const targets=base.phases[i].preview.plan.targets;
      const count=i<journal.verifiedPhases?targets.length:i===journal.verifiedPhases?journal.nextIndex:0;
      for(let j=0;j<count;j++)expected.set(targets[j].path,targets[j].desiredHash);
    }
    const observations=[...expected].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([path,hash])=>({path,hash}));
    const remaining=boundaryRemaining(base.phases,journal);
    if(contractDigest(observations)!==contractDigest(p.observations))fail('switch-continuation-record.observations');
    if(contractDigest(remaining)!==contractDigest(p.remaining))fail('switch-continuation-record.plan');
    return;
  }
  const phaseIndex=journal.verifiedPhases,phase=base.phases[phaseIndex];
  const targetIndex=journal.pending?journal.nextIndex:journal.nextIndex-1;
  const target=phase?.preview.plan.targets[targetIndex];
  if(!target)fail('switch-continuation-record.lineage');
  const expected=new Map(base.observations.map(o=>[o.path,o.hash]));
  for(let i=0;i<=phaseIndex;i++) {
    const targets=base.phases[i].preview.plan.targets,count=i<phaseIndex?targets.length:targetIndex;
    for(let j=0;j<count;j++)expected.set(targets[j].path,targets[j].desiredHash);
  }
  const observed=p.observations.find(o=>o.path===target.path)?.hash;
  if(observed!==target.beforeHash && observed!==target.desiredHash)fail('switch-continuation-record.observations');
  // A previous readback-only approval cannot be widened into a write retry.
  if(continuation && target.resolution==='verify-desired' && observed!==target.desiredHash)
    fail('switch-continuation-record.observations');
  expected.set(target.path,observed);
  if(contractDigest(p.observations)!==contractDigest([...expected].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([path,hash])=>({path,hash}))))
    fail('switch-continuation-record.observations');
  const resolution=observed===target.desiredHash?'verify-desired':'retry-approved-target';
  const uncertain={phase:phase.name,operationId:target.id,path:target.path,beforeHash:target.beforeHash,
    desiredHash:target.desiredHash,observedHash:observed,resolution};
  const remaining=base.phases.slice(phaseIndex).map((phase,index)=>({phase:phase.name,
    operations:phase.preview.plan.targets.slice(index===0?targetIndex:0).map((t,i)=>({operationId:t.id,path:t.path,
      resolution:index===0 && i===0?resolution:'apply-approved-target',beforeHash:t.beforeHash,desiredHash:t.desiredHash})),
    phaseCheckRequired:true}));
  if(contractDigest(uncertain)!==contractDigest(p.uncertain) || contractDigest(remaining)!==contractDigest(p.remaining))
    fail('switch-continuation-record.plan');
}

// Completed outcomes are skipped; unrecorded phase checks remain mandatory.
// Empty remaining means both phase checks already exist, not inferred success.
export function boundaryRemaining(phases,journal) {
  return phases.slice(journal.verifiedPhases).map((phase,index)=>({phase:phase.name,
    operations:phase.preview.plan.targets.slice(index===0?journal.nextIndex:0).map(t=>({operationId:t.id,path:t.path,
      resolution:t.resolution==='verify-desired'?'verify-desired':'apply-approved-target',beforeHash:t.beforeHash,desiredHash:t.desiredHash})),
    phaseCheckRequired:true}));
}
