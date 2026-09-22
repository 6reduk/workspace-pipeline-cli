import {prepareSwitch} from './switch-prepare.js';
import {persistSwitchRecovery} from './switch-recovery-store.js';
import {markSwitchPending} from './switch-pending.js';
import {executeSwitchPhase} from './switch-execute.js';
import {activateSwitch} from './switch-activate.js';
import {validateSwitchRecord} from './switch-records.js';
import {acquireWorkspaceLock} from './lock.js';
import {inspectHistory} from './history.js';
import {readState} from './state.js';
import {requestShape} from './ownership.js';
import {absoluteRoot,resolveChild} from '../workspace/paths.js';
import {ContractError,fail} from '../contracts/parse.js';

function guard(input,registry,apply=false) {
  requestShape(input,apply?['command','wrapper','prepared','approval']:['command','wrapper','manifestPath'],apply?[]:['network'],'switch-lifecycle.input');
  if(input.command!=='switch')fail('switch-lifecycle.command');
  requestShape(registry,['adapters','sharedAdapter'],[],'provider.interface');
  return absoluteRoot(input.wrapper);
}
async function historyGuard(workspace) {
  const history=await inspectHistory(workspace);
  if(!history.complete || history.diagnostics.length)fail('switch-lifecycle.history');
}
export async function prepareSwitchLifecycle(input,registry) {
  const wrapper=guard(input,registry);await historyGuard(wrapper);
  const {command,...options}=input;return prepareSwitch({...options,wrapper},registry);
}

// One approved transaction, two checked phases. No resume, rollback, source
// reacquisition, provider code loading or automatic history cleanup here.
export async function applySwitchLifecycle(input,registry,{report=async()=>{}}={}) {
  const workspace=guard(input,registry,true);
  if(typeof report!=='function')fail('switch-lifecycle.reporter');
  const result={command:'switch',workspace,status:'failed',journal:null,recovery:null,
    completedPhases:[],error:null,lockRelease:'not-acquired',runtime:'not-run'};
  const emit=async event=>{try{await report(structuredClone(event));}catch{fail('switch-lifecycle.report');}};
  let lock;
  try {
    if(input.prepared?.preview?.workspace!==workspace)fail('switch-lifecycle.prepared-binding');
    const previous=(await readState(resolveChild(workspace,'.pipeline/state.json'))).value;
    const {prepared,approval}=validateSwitchRecord(input.prepared,input.approval,previous);
    lock=await acquireWorkspaceLock(workspace);result.lockRelease='pending';await historyGuard(workspace);
    const saved=await persistSwitchRecovery(lock,prepared,approval,registry,previous,{
      onJournal:async location=>{
        const runId=location.relative.split('/').at(-1);
        result.journal={runId,path:location.directory,status:location.status};
        result.recovery={path:resolveChild(workspace,'.pipeline/transactions/'+runId+'/recovery.json'),status:'not-created'};
        await emit({kind:'journal-location',...result.journal,recovery:result.recovery});
      },
      boundary:async stage=>{
        if(stage==='recovery-written') {
          result.recovery.status='created-unverified';await emit({kind:'recovery-location',...result.recovery});
        }
      }
    });
    result.recovery={path:resolveChild(workspace,saved.recoveryPath),status:'verified',hash:saved.recoveryHash};
    await emit({kind:'recovery-location',...result.recovery});
    await markSwitchPending(lock,saved.recoveryPath,saved.recoveryHash,approval,registry);
    for(const phase of ['remove-old','install-new']) {
      await emit({kind:'phase-start',phase});
      await executeSwitchPhase(lock,saved.recoveryPath,saved.recoveryHash,approval,phase);
      result.completedPhases.push(phase);await emit({kind:'phase-completed',phase});
    }
    await activateSwitch(lock,saved.recoveryPath,saved.recoveryHash,approval);result.status='ready';
  }catch(error){result.error=error instanceof ContractError?error.code:'switch-lifecycle.io';}
  finally {
    if(lock)try{await lock.release();result.lockRelease='released';}
    catch(error){result.lockRelease='failed';result.releaseError=error instanceof ContractError?error.code:'lock.release';}
  }
  try{await emit({kind:'operation-result',...result});}catch{result.outputError='switch-lifecycle.report';}
  return result;
}
