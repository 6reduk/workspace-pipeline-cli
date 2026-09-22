import {prepareContinuation,validateContinuationRecord} from './reconciliation.js';
import {applyContinuation} from './apply.js';
import {prepareSwitchContinuation,verifySwitchContinuationApproval} from './switch-continuation.js';
import {persistSwitchContinuationRecovery} from './switch-continuation-recovery.js';
import {markSwitchContinuationPending} from './switch-continuation-pending.js';
import {executeSwitchContinuationPhase,activateSwitchContinuation} from './switch-continuation-runtime.js';
import {readRecord} from './state.js';
import {acquireWorkspaceLock} from './lock.js';
import {requestShape} from './ownership.js';
import {absoluteRoot,resolveChild} from '../workspace/paths.js';
import {ContractError,fail} from '../contracts/parse.js';

function guard(input,registry,apply=false) {
  requestShape(input,apply?['command','wrapper','prepared','approval']:['command','wrapper','recoveryPath'],[],'continuation.input');
  if(input.command!=='continue')fail('continuation.command');
  requestShape(registry,['adapters','sharedAdapter'],[],'provider.interface');
  return absoluteRoot(input.wrapper);
}
export async function prepareContinuationLifecycle(input,registry) {
  const workspace=guard(input,registry);
  if(typeof input.recoveryPath!=='string' || !/^\.pipeline\/transactions\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/recovery\.json$(?![\s\S])/.test(input.recoveryPath))fail('recovery.path');
  const record=await readRecord(resolveChild(workspace,input.recoveryPath));
  return ['switch-recovery','switch-continuation-recovery'].includes(record.value.kind)?
    prepareSwitchContinuation(workspace,input.recoveryPath):prepareContinuation(workspace,input.recoveryPath);
}

// Fresh exact approval, fresh journal, preserved ancestry. Native readers validate
// pending state/lineage; the ordinary clean-history guard would reject that state.
export async function applyContinuationLifecycle(input,registry,{report=async()=>{}}={}) {
  const workspace=guard(input,registry,true);
  if(typeof report!=='function')fail('continuation.reporter');
  const result={command:'continue',workspace,status:'failed',journal:null,recovery:null,error:null,lockRelease:'not-acquired',runtime:'not-run'};
  const emit=async event=>{try{await report(structuredClone(event));}catch{fail('continuation.report');}};
  const onJournal=async location=>{
    const runId=location.relative.split('/').at(-1);
    result.journal={runId,path:location.directory,status:location.status};
    result.recovery={path:resolveChild(workspace,'.pipeline/transactions/'+runId+'/recovery.json'),status:'not-created'};
    await emit({kind:'journal-location',...result.journal,recovery:result.recovery});
  };
  let lock;
  try {
    const switching=input.prepared?.kind==='switch-continuation-preview';
    const prepared=switching?structuredClone(input.prepared):validateContinuationRecord(input.prepared,input.approval);
    if((switching?prepared.workspace:prepared.evidence?.workspace)!==workspace)fail('continuation.prepared-binding');
    lock=await acquireWorkspaceLock(workspace);result.lockRelease='pending';
    if(switching) {
      const approval={decision:input.approval.decision,previewDigest:input.approval.preparedDigest};
      requestShape(input.approval,['decision','preparedDigest'],[],'continuation.approval');
      await verifySwitchContinuationApproval(lock,prepared,approval);
      const saved=await persistSwitchContinuationRecovery(lock,prepared,approval,{onJournal,boundary:async stage=>{
        if(stage==='recovery-written'){result.recovery.status='created-unverified';await emit({kind:'recovery-location',...result.recovery});}
      }});
      result.recovery={path:resolveChild(workspace,saved.recoveryPath),status:'verified',hash:saved.recoveryHash};
      await emit({kind:'recovery-location',...result.recovery});
      await markSwitchContinuationPending(lock,saved.recoveryPath,saved.recoveryHash,approval);
      for(const {phase} of prepared.remaining) {
        await emit({kind:'phase-start',phase});
        await executeSwitchContinuationPhase(lock,saved.recoveryPath,saved.recoveryHash,approval,phase);
        await emit({kind:'phase-completed',phase});
      }
      await activateSwitchContinuation(lock,saved.recoveryPath,saved.recoveryHash,approval);result.status='ready';
    } else {
      const applied=await applyContinuation(lock,prepared,input.approval,{onJournal,ioBoundary:async detail=>{
        if(detail.purpose==='recovery' && ['opened','readback'].includes(detail.phase)) {
          result.recovery.status=detail.phase==='opened'?'created-unverified':'verified';
          await emit({kind:'recovery-location',...result.recovery});
        }
      }});result.status=applied.status;
    }
  }catch(error){result.error=error instanceof ContractError?error.code:'continuation.io';}
  finally {
    if(lock)try{await lock.release();result.lockRelease='released';}
    catch(error){result.lockRelease='failed';result.releaseError=error instanceof ContractError?error.code:'lock.release';}
  }
  try{await emit({kind:'operation-result',...result});}catch{result.outputError='continuation.report';}
  return result;
}
