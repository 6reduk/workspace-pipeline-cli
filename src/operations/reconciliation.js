import {inspectRecovery} from './apply.js';
import {readState,readRecord} from './state.js';
import {absoluteRoot,resolveChild} from '../workspace/paths.js';
import {contractDigest} from '../contracts/semantic.js';
import {fail,parse} from '../contracts/parse.js';
import {requestShape} from './ownership.js';
import {assertLockHeld} from './lock.js';
import {bindPreview} from './plan.js';
import {assertContinuationCapacity} from './lineage-guard.js';
import {retiredBundleOwnership} from './bundle-update.js';
import {retiredSkillOwnership} from './skill-retirement.js';
import {assertResetTreeScope} from './reset-scope.js';

export const continuationCommand=plan=>['remove','reset'].includes(plan.command)?plan.command:
  plan.command==='update' && plan.targets.some(t=>t.desiredHash===null)?'update':'repair';

// Current evidence and decisions still required, never a runnable retry/rollback.
export async function previewReconciliation(workspace,recoveryPath) {
  workspace=absoluteRoot(workspace);
  if(typeof recoveryPath!=='string' || !/^\.pipeline\/transactions\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/recovery\.json$/.test(recoveryPath))fail('recovery.path');
  const stateHash=async()=>{
    try{return (await readState(resolveChild(workspace,'.pipeline/state.json'))).digest;}
    catch(e){if(e.code==='record.missing')return null;throw e;}
  };
  const before=await stateHash(),recovery=await inspectRecovery(workspace,recoveryPath);
  if(await stateHash()!==before || (await readRecord(resolveChild(workspace,recoveryPath))).digest!==recovery.recoveryHash)
    fail('recovery.observation-drift');
  const body={kind:'reconciliation-preview',workspace,stateHash:before,recoveryPath,recoveryHash:recovery.recoveryHash,
    status:recovery.status,statePhase:recovery.statePhase,diagnostics:recovery.diagnostics,targets:recovery.targets,
    journal:recovery.journal,journalHead:recovery.journalHead,lineage:recovery.lineage,requiresDecision:recovery.status!=='applied',requiresFreshApproval:true,
    applySupported:false,automaticActions:false,runtime:'not-run'};
  parse(JSON.stringify(body),'json');
  return {...body,digest:contractDigest(body)};
}

// Fresh continuation proposal only: do not resume an old writer or manufacture
// its missing outcome. Exact desired bytes require a new readback, not rewriting.
// Payloads and observations may contain secrets; keep this envelope local.
export async function prepareContinuation(workspace,recoveryPath) {
  const evidence=await previewReconciliation(workspace,recoveryPath);
  if(!['pending','before'].includes(evidence.statePhase))fail('reconciliation.not-pending');
  if(evidence.diagnostics.length)fail('reconciliation.conflict');
  const record=await readRecord(resolveChild(evidence.workspace,recoveryPath));
  if(record.digest!==evidence.recoveryHash)fail('recovery.observation-drift');
  const previousPlan=record.value.prepared.preview,actions=[];
  const beforeSetup=evidence.statePhase==='before';
  const beforeReset=beforeSetup && record.value.prepared.kind==='prepared-reset' && previousPlan.plan.command==='reset' &&
    record.value.previous?.active && record.value.previous.pending===null && record.value.prepared.stateFileHash===evidence.stateHash;
  if(beforeSetup && !beforeReset && (evidence.stateHash!==null || record.value.previous!==null ||
      record.value.prepared.kind!=='prepared-plan' || record.value.prepared.stateFileHash!==null ||
      previousPlan.plan.command!=='setup'))fail('reconciliation.not-pending');
  if(beforeSetup && ((!beforeReset || previousPlan.plan.targets.length>0) && (await inspectRecovery(workspace,recoveryPath)).receipt!==null ||
      evidence.targets.some(t=>t.position!=='before' || t.recorded!=='skipped')))fail('reconciliation.conflict');
  const removal=['remove','reset'].includes(previousPlan.plan.command);
  if(previousPlan.plan.command==='reset')await assertResetTreeScope(workspace,record.value.prepared.reset,previousPlan.plan);
  const retired=new Set([...retiredBundleOwnership(record.value.previous,previousPlan.plan.desired??{}),
    ...(previousPlan.plan.command==='update'?retiredSkillOwnership(record.value.previous,previousPlan.plan.desired):[])].map(o=>o.path));
  assertContinuationCapacity(evidence.lineage.length);
  for(const target of previousPlan.plan.targets) {
    const observed=evidence.targets.find(t=>t.id===target.id);
    if(!observed || !['before','desired'].includes(observed.position))fail('reconciliation.conflict');
    if(!['create','replace','edit-fields',...((removal || retired.has(target.path))?['delete','verify-absent']:[])].includes(target.action))fail('reconciliation.unsupported');
    const output=previousPlan.outputs.find(o=>o.path===target.path);
    if(target.desiredHash===null?!!output:!output || output.hash!==target.desiredHash)fail('reconciliation.payload');
    actions.push({id:target.id,path:target.path,owner:target.owner,
      action:observed.position==='desired'?'verify-readback':'write-desired',
      recorded:observed.recorded,beforeHash:observed.observedHash,
      desiredHash:target.desiredHash,bytes:output?.bytes??null});
  }
  // Include unchanged dependencies, not just the remaining writes. The fresh
  // evidence binding prevents an unchanged target list hiding a new journal head.
  let state=null;
  try { state=await readState(resolveChild(evidence.workspace,'.pipeline/state.json')); }
  catch(error) { if(!beforeSetup || error.code!=='record.missing')throw error; }
  if((state?.digest??null)!==evidence.stateHash)fail('recovery.observation-drift');
  const outputs=actions.filter(a=>a.bytes!==null).map(a=>({path:a.path,bytes:Buffer.from(a.bytes,'base64')}));
  const observations=previousPlan.observations.map(o=>{
    const action=actions.find(a=>a.path===o.path);
    return {path:o.path,bytes:action?.action==='verify-readback'?(action.bytes===null?null:Buffer.from(action.bytes,'base64')):o.bytes===null?null:Buffer.from(o.bytes,'base64')};
  });
  const plan={schemaVersion:1,kind:'plan',workspace:evidence.workspace,command:continuationCommand(previousPlan.plan),
    beforeStateHash:state===null?null:contractDigest(state.value),source:structuredClone(previousPlan.plan.source),
    desired:structuredClone(previousPlan.plan.desired),targets:actions.map(a=>({id:a.id,path:a.path,owner:a.owner,
      action:continuationTargetAction(a),beforeHash:a.beforeHash,desiredHash:a.desiredHash,fields:[]}))};
  const preview=bindPreview(plan,state?.value??null,{observations,outputs});
  const body={kind:'prepared-continuation',evidence,actions,preview,stateFileHash:evidence.stateHash,
    ...(previousPlan.plan.command==='reset'?{reset:structuredClone(record.value.prepared.reset)}:{}),
    dependencies:previousPlan.observations.filter(o=>!actions.some(a=>a.path===o.path)),
    desired:structuredClone(previousPlan.plan.desired),
    applySupported:true,requiresFreshApproval:true,automaticActions:false,runtime:'not-run'};
  parse(JSON.stringify(body),'json');
  if((await previewReconciliation(evidence.workspace,recoveryPath)).digest!==evidence.digest)fail('recovery.observation-drift');
  return {...body,digest:contractDigest(body)};
}

export function continuationTargetAction(action) {
  return action.desiredHash===null?(action.beforeHash===null?'verify-absent':'delete'):action.beforeHash===null?'create':'replace';
}

export function validateContinuationRecord(prepared,approval) {
  requestShape(prepared,['kind','evidence','actions','preview','stateFileHash','dependencies','desired','applySupported','requiresFreshApproval','automaticActions','runtime','digest'],['reset'],'reconciliation.prepared');
  requestShape(approval,['decision','preparedDigest'],[],'reconciliation.approval');
  const copy=structuredClone(parse(JSON.stringify(prepared),'json')),decision=structuredClone(approval);
  const {digest,...body}=copy;
  if(copy.kind!=='prepared-continuation' || copy.applySupported!==true || copy.requiresFreshApproval!==true ||
      copy.automaticActions!==false || copy.runtime!=='not-run' || contractDigest(body)!==digest)fail('reconciliation.prepared');
  if(decision.decision!=='approve' || decision.preparedDigest!==digest)fail('reconciliation.approval');
  if((copy.preview?.plan?.command==='reset')!==Object.hasOwn(copy,'reset'))fail('reconciliation.prepared');
  return copy;
}

export async function verifyContinuationApproval(lock,prepared,approval) {
  const copy=validateContinuationRecord(prepared,approval);
  await assertLockHeld(lock);
  if(copy.evidence?.workspace!==lock.workspace)fail('reconciliation.workspace');
  const fresh=await prepareContinuation(lock.workspace,copy.evidence.recoveryPath);
  if(contractDigest(fresh)!==contractDigest(copy))fail('reconciliation.plan-drift');
  await assertLockHeld(lock);
  return fresh;
}
