import {preparePlan} from './plan.js';
import {applyPrepared,preflightApply} from './apply.js';
import {applyRetention} from './retention-apply.js';
import {readRetentionPolicy,retentionLimits} from './retention-policy.js';
import {scanRetention} from './retention-scan.js';
import {scanCombinedRetention} from './retention-combined-scan.js';
import {readState} from './state.js';
import {acquireWorkspaceLock} from './lock.js';
import {inspectHistory} from './history.js';
import {requestShape} from './ownership.js';
import {absoluteRoot,resolveChild} from '../workspace/paths.js';
import {ContractError,fail} from '../contracts/parse.js';

const commandGuard=command=>{if(!['setup','update'].includes(command))fail('lifecycle.command');};
function registryGuard(registry) {
  requestShape(registry,['adapters','sharedAdapter'],[],'provider.interface');
}
async function previousState(wrapper) {
  try{return (await readState(resolveChild(wrapper,'.pipeline/state.json'))).value;}
  catch(e){if(e.code==='record.missing')return null;throw e;}
}
function stateCommand(command,previous) {
  if (command!==(previous?.active?'update':'setup')) fail('lifecycle.command-state');
}
async function historyGuard(wrapper) {
  const history=await inspectHistory(wrapper);
  if (!history.complete || history.diagnostics.length) fail('lifecycle.history');
}

// Preview may acquire source into temporary storage outside the workspace.
// It never authorizes apply, edits provider files or manufactures user approval.
export async function prepareLifecycle(input,registry) {
  requestShape(input,['command','wrapper'],['manifestPath','network','tempRoot','rebind'],'lifecycle.input');
  commandGuard(input.command);registryGuard(registry);
  const wrapper=absoluteRoot(input.wrapper);
  stateCommand(input.command,await previousState(wrapper));await historyGuard(wrapper);
  const {command,...options}=input;
  const prepared=await preparePlan({...options,wrapper,...registry});
  if(prepared.preview.plan.command!==command)fail('lifecycle.command-drift');
  return prepared;
}

// Trusted caller supplies both provider registry and output transport. Neither
// callback nor executable adapters are accepted from pipeline package data.
// The returned report contains locations/status codes, never raw config values.
export async function applyLifecycle(input,registry,{report=async()=>{},retention=null}={}) {
  requestShape(input,['command','wrapper','prepared','approval'],[],'lifecycle.input');
  commandGuard(input.command);registryGuard(registry);
  if(typeof report!=='function')fail('lifecycle.reporter');
  // This is a separately approved exact cleanup, never a supplier policy or an
  // implied consequence of approving setup/update. Detach before asynchronous IO.
  if(retention!==null) {
    requestShape(retention,['preview','approval'],[],'lifecycle.retention');
    retention=structuredClone(retention);
  }
  requestShape(input.prepared,['kind','preview','stateFileHash','rebind','preparation','runtime','digest'],[],'lifecycle.prepared');
  requestShape(input.prepared.preview,['schemaVersion','plan','observations','outputs','digest'],[],'lifecycle.preview');
  requestShape(input.prepared.preview.plan,['schemaVersion','kind','workspace','command','beforeStateHash','source','desired','targets'],[],'lifecycle.plan');
  const wrapper=absoluteRoot(input.wrapper),result={command:input.command,workspace:wrapper,status:'failed',
    journal:null,recovery:null,error:null,lockRelease:'not-acquired',runtime:'not-run'};
  let lock;
  const emit=async event=>{try{await report(structuredClone(event));}catch{fail('lifecycle.report');}};
  try {
    // Reject wrong verb/root before acquiring a lock or creating metadata.
    if(input.prepared?.preview?.plan?.command!==input.command || input.prepared?.preview?.plan?.workspace!==wrapper)
      fail('lifecycle.prepared-binding');
    lock=await acquireWorkspaceLock(wrapper);result.lockRelease='pending';
    const previous=await previousState(wrapper);stateCommand(input.command,previous);
    await historyGuard(wrapper);
    const localPolicy=await readRetentionPolicy(wrapper);
    if(localPolicy.mode==='automatic' && retention!==null)fail('lifecycle.retention-conflict');
    if(localPolicy.mode==='automatic') {
      await preflightApply(lock,input.prepared,input.approval,registry,previous);
      retention={preview:await (localPolicy.policy.schemaVersion===2?scanCombinedRetention:scanRetention)(wrapper,{policy:retentionLimits(localPolicy.policy),now:Date.now()}),
        approval:{decision:'workspace-policy',policyHash:localPolicy.hash}};
    }
    if(retention!==null) {
      // No cleanup for a stale/unapproved main operation. Preflight is read-only.
      await preflightApply(lock,input.prepared,input.approval,registry,previous);
      result.cleanup={status:'not-started'};
      try {
        let announced=false;
        result.cleanup=await applyRetention(lock,retention.preview,retention.approval,{report:async event=>{
          if(!announced) {
            announced=true;
            await emit({kind:'startup-retention',previewDigest:retention.preview.digest,
              policy:retention.preview.retention.policy,policyPath:localPolicy.path,policyHash:localPolicy.hash,
              authorization:retention.approval.decision,totals:retention.preview.retention.totals,
              protectedCount:retention.preview.retention.protected.length});
          }
          await emit(event);
        }});
      }catch(e) {
        result.cleanup={status:'failed',error:e instanceof ContractError?e.code:'retention-apply.io'};
      }
      // Cleanup failure blocks new target writes. Keep its outcome separate:
      // partial cleanup must not be described as a failed setup execution.
      if(result.cleanup.status!=='completed' || result.cleanup.outputError) {
        result.status='not-started';fail('lifecycle.retention');
      }
      await historyGuard(wrapper);
    }
    // Fresh preflight inside applyPrepared rechecks the main operation after
    // cleanup. Its new journal does not exist during startup cleanup.
    const applied=await applyPrepared(lock,input.prepared,input.approval,registry,previous,{
      onJournal:async location=>{
        const runId=location.relative.split('/').at(-1);
        result.journal={runId,path:location.directory,status:location.status};
        result.recovery={path:resolveChild(wrapper,'.pipeline/transactions/'+runId+'/recovery.json'),status:'not-created'};
        await emit({kind:'journal-location',...result.journal,recovery:result.recovery});
      },
      ioBoundary:async detail=>{
        if(detail.purpose==='recovery' && detail.phase==='opened') {
          result.recovery.status='created-unverified';await emit({kind:'recovery-location',...result.recovery});
        }
        if(detail.purpose==='recovery' && detail.phase==='readback') {
          result.recovery.status='verified';await emit({kind:'recovery-location',...result.recovery});
        }
      }
    });
    result.status=applied.status;
  } catch(e) {result.error=e instanceof ContractError?e.code:'lifecycle.io';}
  finally {
    if(lock) {
      try{await lock.release();result.lockRelease='released';}
      catch(e){result.lockRelease='failed';result.releaseError=e instanceof ContractError?e.code:'lock.release';}
    }
  }
  // Output failure after a committed installation must not rewrite its outcome.
  try{await emit({kind:'operation-result',...result});}
  catch{result.outputError='lifecycle.report';}
  return result;
}
