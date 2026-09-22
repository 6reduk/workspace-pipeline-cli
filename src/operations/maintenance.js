import {prepareRepairPlan,validateRepairRecord} from './repair.js';
import {prepareRemoval,validateRemovalRecord} from './remove.js';
import {applyRepair,applyRemoval} from './apply.js';
import {acquireWorkspaceLock} from './lock.js';
import {inspectHistory} from './history.js';
import {requestShape} from './ownership.js';
import {absoluteRoot,resolveChild} from '../workspace/paths.js';
import {ContractError,fail} from '../contracts/parse.js';

function guard(input,registry,apply=false) {
  requestShape(input,apply?['command','wrapper','prepared','approval']:['command','wrapper'],apply?[]:['providers','bundles'],'maintenance.input');
  if(!['repair','remove'].includes(input.command) || (input.command==='repair' && (input.providers!==undefined || input.bundles!==undefined)))fail('maintenance.command');
  requestShape(registry,['adapters','sharedAdapter'],[],'provider.interface');
  return absoluteRoot(input.wrapper);
}
async function historyGuard(workspace) {
  const history=await inspectHistory(workspace);
  if(!history.complete || history.diagnostics.length)fail('maintenance.history');
}

// Installed-snapshot operations only: no source acquisition or manifest rebind.
export async function prepareMaintenance(input,registry) {
  const workspace=guard(input,registry);await historyGuard(workspace);
  return input.command==='repair'?prepareRepairPlan(workspace,registry):
    prepareRemoval(workspace,registry,{...(input.providers===undefined?{}:{providers:input.providers}),
      ...(input.bundles===undefined?{}:{bundles:input.bundles})});
}

export async function applyMaintenance(input,registry,{report=async()=>{}}={}) {
  const workspace=guard(input,registry,true);
  if(typeof report!=='function')fail('maintenance.reporter');
  const result={command:input.command,workspace,status:'failed',journal:null,recovery:null,
    error:null,lockRelease:'not-acquired',runtime:'not-run'};
  const emit=async event=>{try{await report(structuredClone(event));}catch{fail('maintenance.report');}};
  let lock;
  try {
    const prepared=(input.command==='repair'?validateRepairRecord:validateRemovalRecord)(input.prepared,input.approval);
    if(prepared.preview?.plan?.workspace!==workspace || prepared.preview.plan.command!==input.command)fail('maintenance.prepared-binding');
    lock=await acquireWorkspaceLock(workspace);result.lockRelease='pending';await historyGuard(workspace);
    const applied=await (input.command==='repair'?applyRepair:applyRemoval)(lock,prepared,input.approval,registry,{
      onJournal:async location=>{
        const runId=location.relative.split('/').at(-1);
        result.journal={runId,path:location.directory,status:location.status};
        result.recovery={path:resolveChild(workspace,'.pipeline/transactions/'+runId+'/recovery.json'),status:'not-created'};
        await emit({kind:'journal-location',...result.journal,recovery:result.recovery});
      },
      ioBoundary:async detail=>{
        if(detail.purpose==='recovery' && ['opened','readback'].includes(detail.phase)) {
          result.recovery.status=detail.phase==='opened'?'created-unverified':'verified';
          await emit({kind:'recovery-location',...result.recovery});
        }
      }
    });
    result.status=applied.status;
  }catch(error){result.error=error instanceof ContractError?error.code:'maintenance.io';}
  finally {
    if(lock)try{await lock.release();result.lockRelease='released';}
    catch(error){result.lockRelease='failed';result.releaseError=error instanceof ContractError?error.code:'lock.release';}
  }
  try{await emit({kind:'operation-result',...result});}catch{result.outputError='maintenance.report';}
  return result;
}
