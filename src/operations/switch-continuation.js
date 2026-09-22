import {inspectPendingSwitch} from './switch-inspect.js';
import {readSwitchLineage} from './switch-continuation-recovery.js';
import {inspectSwitchContinuation} from './switch-continuation-runtime.js';
import {assertSwitchContinuationPredecessor,boundaryRemaining} from './switch-continuation-records.js';
import {readState} from './state.js';
import {absoluteRoot,resolveChild} from '../workspace/paths.js';
import {contractDigest} from '../contracts/semantic.js';
import {parse,fail} from '../contracts/parse.js';
import {requestShape} from './ownership.js';
import {assertLockHeld} from './lock.js';
import {assertContinuationCapacity} from './lineage-guard.js';

// Exact approval is checked against a freshly reconstructed preview under lock.
// This remains read-only and does not authorize an old journal to be amended.
export async function verifySwitchContinuationApproval(lock,preview,approval) {
  const copy=parse(JSON.stringify(preview),'json'),decision=parse(JSON.stringify(approval),'json');
  requestShape(copy,['kind','workspace','recoveryPath','recoveryHash','predecessor','stateFileHash','observations','uncertain','remaining',
    'requiresFreshApproval','applySupported','runtime','digest'],[],'switch-continuation.preview');
  requestShape(decision,['decision','previewDigest'],[],'switch-continuation.approval');
  const {digest,...body}=copy;
  if(copy.kind!=='switch-continuation-preview' || copy.requiresFreshApproval!==true || copy.applySupported!==false ||
      copy.runtime!=='not-run' || contractDigest(body)!==digest)fail('switch-continuation.preview');
  if(decision.decision!=='approve' || decision.previewDigest!==digest)fail('switch-continuation.approval');
  await assertLockHeld(lock);
  if(copy.workspace!==lock.workspace)fail('switch-continuation.workspace');
  const fresh=await prepareSwitchContinuation(lock.workspace,copy.recoveryPath);
  if(contractDigest(fresh)!==contractDigest(copy))fail('switch-continuation.plan-drift');
  await assertLockHeld(lock);
  return {preview:fresh,approval:decision,applySupported:false,runtime:'not-run'};
}

// Read-only proposal for a NEW continuation, never an amendment to the old
// uncertain journal. A future executor needs separate approval and evidence.
export async function prepareSwitchContinuation(workspace,recoveryPath) {
  workspace=absoluteRoot(workspace);
  const evidence=await readSwitchLineage(workspace,recoveryPath),record=evidence.record;
  assertContinuationCapacity(evidence.ancestors.length);
  const continuation=record.kind==='switch-continuation-recovery';
  const inspect=async()=>{
    if(!continuation)return inspectPendingSwitch(workspace,recoveryPath);
    const result=await inspectSwitchContinuation(workspace,recoveryPath);
    return {...result,targets:result.observations};
  };
  const inspection=await inspect();
  if(inspection.conflicts.length || !(inspection.uncertain?['uncertain']:['open','completed']).includes(inspection.journalStatus))fail('switch-continuation.state');
  if(evidence.fileHash!==inspection.recoveryHash)fail('switch-continuation.drift');
  const state=await readState(resolveChild(workspace,'.pipeline/state.json'));
  const expected={...evidence.root.record.previous,status:'needs-reconciliation',pending:record.digest,runtime:'not-run'};
  if(contractDigest(state.value)!==contractDigest(expected))fail('switch-continuation.binding');
  const {phase,operationId,path,beforeHash,desiredHash}=inspection.uncertain??{};
  const uncertain={phase,operationId,path,beforeHash,desiredHash},observed=inspection.targets.find(t=>t.path===uncertain.path);
  // Equal before/desired bytes need readback only, not an unnecessary write.
  const resolution=observed?.hash===uncertain.desiredHash?'verify-desired':'retry-approved-target';
  const phases=continuation?record.preview.remaining.map(p=>({name:p.phase,preview:{plan:{targets:
    p.operations.map(t=>({...t,id:t.operationId}))}}})):record.prepared.preview.phases;
  const phaseIndex=phases.findIndex(p=>p.name===uncertain.phase);
  if(inspection.uncertain && phaseIndex<0)fail('switch-continuation.target');
  const targetIndex=inspection.uncertain?phases[phaseIndex].preview.plan.targets.findIndex(t=>t.id===uncertain.operationId):0;
  if(inspection.uncertain && targetIndex<0)fail('switch-continuation.target');
  const remaining=!inspection.uncertain?boundaryRemaining(phases,evidence.journal):phases.slice(phaseIndex).map((phase,index)=>({phase:phase.name,
    operations:phase.preview.plan.targets.slice(index===0?targetIndex:0).map((t,i)=>({operationId:t.id,path:t.path,
      resolution:index===0 && i===0?resolution:'apply-approved-target',beforeHash:t.beforeHash,desiredHash:t.desiredHash})),
    phaseCheckRequired:true}));
  const body={kind:'switch-continuation-preview',workspace,recoveryPath,recoveryHash:evidence.fileHash,
    predecessor:{pending:record.digest,journal:record.journal,sequence:evidence.journal.sequence,
      head:evidence.journal.head,lastFileHash:evidence.journal.lastFileHash},
    stateFileHash:state.digest,observations:inspection.targets.map(t=>({path:t.path,hash:t.hash})),
    uncertain:inspection.uncertain?{...uncertain,observedHash:observed.hash,resolution}:null,remaining,
    requiresFreshApproval:true,applySupported:false,runtime:'not-run'};
  assertSwitchContinuationPredecessor(body,evidence);
  const repeated=await inspect(),after=await readSwitchLineage(workspace,recoveryPath);
  if(contractDigest(repeated)!==contractDigest(inspection) || after.fileHash!==evidence.fileHash ||
      contractDigest(after.journal)!==contractDigest(evidence.journal) ||
      (await readState(resolveChild(workspace,'.pipeline/state.json'))).digest!==state.digest)fail('switch-continuation.drift');
  const copy=parse(JSON.stringify(body),'json');return {...copy,digest:contractDigest(copy)};
}
