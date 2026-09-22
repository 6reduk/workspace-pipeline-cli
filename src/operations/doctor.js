import {readConfigField} from './config-fields.js';
import { absoluteRoot, resolveChild, inspectDirectory } from '../workspace/paths.js';
import { inspectRepositoryPending } from './repository-pending.js';
import { readRecord, readState, observeTargets, verifyInstalledSnapshot } from './state.js';
import { ContractError, fail } from '../contracts/parse.js';
import { contractDigest } from '../contracts/semantic.js';
import { sha256 } from '../source/inventory.js';
import { inspectRecovery } from './apply.js';
import { requestShape } from './ownership.js';
import { inspectHistory } from './history.js';
import {inspectPendingSwitch} from './switch-inspect.js';
import {inspectActivatedSwitch} from './switch-activate.js';
import {inspectSwitchContinuation} from './switch-continuation-runtime.js';

async function inspectDoctorRecovery(workspace,relative,options={}) {
  const record=await readRecord(resolveChild(workspace,relative));
  if(record.value?.kind==='switch-continuation-recovery') {
    const state=await readState(resolveChild(workspace,'.pipeline/state.json')),pending=state.value.pending!==null;
    const checked=await inspectSwitchContinuation(workspace,relative,{active:!pending});
    if(checked.recoveryHash!==record.digest)fail('doctor.observation-drift');
    return {status:checked.status,statePhase:pending?'pending':'active',journal:record.value.journal,
      recoveryHash:record.digest,comparisonScope:'switch-exact-projection',fieldProjections:[],
      diagnostics:pending?['doctor.switch-pending',...(checked.conflicts.length?['doctor.switch-target-drift']:[])]:[]};
  }
  if(record.value?.kind!=='switch-recovery')return inspectRecovery(workspace,relative,options);
  const state=await readState(resolveChild(workspace,'.pipeline/state.json'));
  const pending=state.value.pending!==null;
  const checked=pending?await inspectPendingSwitch(workspace,relative):await inspectActivatedSwitch(workspace,relative);
  if(checked.recoveryHash!==record.digest)fail('doctor.observation-drift');
  return {status:checked.status,statePhase:pending?'pending':'active',journal:record.value.journal,
    recoveryHash:record.digest,comparisonScope:'switch-exact-projection',fieldProjections:[],
    diagnostics:pending?['doctor.switch-pending',...(checked.conflicts.length?['doctor.switch-target-drift']:[])]:[]};
}

// Configuration readiness only: never runtime, acceptance, cleanup eligibility
// or authority to repair. Active transactions are matched by content binding,
// never timestamps. Repeated no-op applications can corroborate the same state;
// all matching records are checked, not hidden behind one explicit selection.
export async function inspectInstallation(workspace, options = {}) {
  requestShape(options,[],['recoveryPath'],'doctor.options');
  if (Object.hasOwn(options,'recoveryPath') && (typeof options.recoveryPath!=='string' ||
      !/^\.pipeline\/transactions\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/recovery\.json$/.test(options.recoveryPath))) fail('recovery.path');
  workspace = absoluteRoot(workspace);
  const diagnostics = [], targets = [];
  const result = {workspace, status:'incomplete', configuration:'not-verified',
    diagnostics, targets, transactionEvidence:'not-verified', runtime:'not-run',
    automaticActions:false, ready:false,fieldProjections:[]};
  const issue = (error, subject) => diagnostics.push({code:error instanceof ContractError ? error.code : 'doctor.io',subject});
  let selectedPath=options.recoveryPath;
  const inspectSelectedRecovery = async () => {
    if (selectedPath===undefined) return;
    try {
      const recovery=await inspectDoctorRecovery(workspace,selectedPath,{fieldOwnershipOnly:true});
      for(const path of recovery.fieldProjections)result.fieldProjections.push({recovery:selectedPath,path});
      result.recovery={path:selectedPath,status:recovery.status,statePhase:recovery.statePhase,
        journal:recovery.journal,hash:recovery.recoveryHash,comparisonScope:recovery.comparisonScope,fieldProjections:recovery.fieldProjections};
      result.transactionEvidence=recovery.status==='applied'?'pass':'fail';
      for (const code of recovery.diagnostics) diagnostics.push({code,subject:selectedPath});
      if (recovery.status!=='applied') diagnostics.push({code:'doctor.transaction-not-applied',subject:selectedPath});
    } catch (error) {
      result.transactionEvidence='fail';issue(error,'selected-recovery');
    }
  };
  let record;
  try {
    const repositories=await inspectRepositoryPending(workspace);
    if(repositories.blocked){
      diagnostics.push(...repositories.blockers);
      if(repositories.blockers.some(b=>b.code==='migration.pending'))result.status='needs-reconciliation';
      return result;
    }
    if (!(await inspectDirectory(workspace)).exists) {
      diagnostics.push({code:'doctor.workspace-missing',subject:workspace});return result;
    }
    result.history=await inspectHistory(workspace);
    diagnostics.push(...result.history.diagnostics);
    if ((await inspectDirectory(resolveChild(workspace,'.pipeline/lock'))).exists)
      diagnostics.push({code:'doctor.lock-present',subject:'.pipeline/lock'});
    record = await readState(resolveChild(workspace,'.pipeline/state.json'));
  } catch (error) {
    issue(error,'.pipeline/state.json');
    if (error.code==='record.missing' && diagnostics.length===1 &&
        !(await inspectDirectory(resolveChild(workspace,'.pipeline'))).exists) result.status='not-installed';
    return result;
  }
  const state = record.value;
  if (absoluteRoot(state.workspace) !== workspace) {
    diagnostics.push({code:'doctor.workspace-binding',subject:'.pipeline/state.json'});return result;
  }
  result.recordedStatus = state.status;
  if (state.pending !== null) {
    result.status='needs-reconciliation';
    diagnostics.push({code:'doctor.pending',subject:'.pipeline/state.json'});
    if(selectedPath===undefined) {
      const matches=result.history.entries.filter(e=>['switch','switch-continuation'].includes(e.kind) && e.pendingDigest===state.pending);
      if(matches.length===1)selectedPath=matches[0].recovery;
      else if(matches.length>1)diagnostics.push({code:'doctor.switch-pending-binding',subject:'history'});
    }
    await inspectSelectedRecovery();return result;
  }
  const matchingTransactions=()=>{
    if(!state.activation)return result.history.entries.filter(item=>item.status==='journal-completed' && item.desiredHash===contractDigest(state.active));
    const anchor=state.activation,item=result.history.entries.find(e=>e.recovery===anchor.recovery);
    if(!item || item.status!=='journal-completed' || item.recoveryHash!==anchor.recoveryHash ||
        item.journalHash!==anchor.journalHead.hash || item.journalSequence!==anchor.journalHead.sequence ||
        item.desiredHash!==contractDigest(state.active)) {
      diagnostics.push({code:'doctor.activation-binding',subject:'.pipeline/state.json'});return [];
    }
    if(selectedPath!==undefined && selectedPath!==anchor.recovery)
      diagnostics.push({code:'doctor.activation-selection',subject:selectedPath});
    return [item];
  };
  if (!state.active) {
    const matches=matchingTransactions();
    result.matchingTransactions=matches.map(item=>item.recovery);
    // Absence of an active deployment alone is not proof of completed removal.
    // Check every matching transaction, never choose one by timestamp or allow
    // explicit selection to hide another invalid matching record.
    if(result.history.entries.length && !matches.length)
      diagnostics.push({code:'doctor.transaction-missing',subject:'history'});
    if(selectedPath===undefined && matches.length)selectedPath=matches[0].recovery;
    await inspectSelectedRecovery();
    for(const match of matches)if(match.recovery!==selectedPath) {
      try {
        const checked=await inspectDoctorRecovery(workspace,match.recovery);
        if(checked.status!=='applied')diagnostics.push({code:'doctor.transaction-not-applied',subject:match.recovery});
        for(const code of checked.diagnostics)diagnostics.push({code,subject:match.recovery});
      }catch(error){issue(error,match.recovery);}
    }
    try {
      if(contractDigest(await inspectHistory(workspace))!==contractDigest(result.history))
        diagnostics.push({code:'doctor.observation-drift',subject:'history'});
      if((await readState(resolveChild(workspace,'.pipeline/state.json'))).digest!==record.digest)
        diagnostics.push({code:'doctor.observation-drift',subject:'.pipeline/state.json'});
      if((await inspectDirectory(resolveChild(workspace,'.pipeline/lock'))).exists &&
          !diagnostics.some(d=>d.code==='doctor.lock-present'))
        diagnostics.push({code:'doctor.lock-present',subject:'.pipeline/lock'});
    }catch(error){issue(error,'readback');}
    const verified=state.status==='not-installed' && diagnostics.length===0 && result.history.complete &&
      (!result.history.entries.length || result.transactionEvidence==='pass');
    result.status=verified?'not-installed':'needs-reconciliation';
    result.configuration=verified?'not-installed':'fail';
    if(diagnostics.length && selectedPath!==undefined)result.transactionEvidence='fail';
    // ready remains false: successful removal is not an installed pipeline.
    return result;
  }
  const matches=matchingTransactions();
  if (matches.length===0) diagnostics.push({code:'doctor.transaction-missing',subject:'history'});
  else if (selectedPath===undefined) selectedPath=matches[0].recovery;
  result.matchingTransactions=matches.map(item=>item.recovery);
  result.pipeline = {id:state.active.pipelineId,version:state.active.version,providers:[...state.active.providers]};
  if(state.active.bundles) result.pipeline.bundles=Object.entries(state.active.bundles).map(([id,b])=>({id,
    suppliedProviders:[...b.providers],installedProviders:b.providers.filter(p=>state.active.providers.includes(p)),
    entry:b.entry.target,runtime:'not-run'}));
  try { await verifyInstalledSnapshot(state); }
  catch (error) { issue(error,'snapshot'); }
  const names = [...new Set(state.active.owned.map(item=>item.path))];
  let observations;
  try { observations = await observeTargets(workspace,names); }
  catch (error) { issue(error,'targets');return result; }
  const bytes = new Map(observations.map(item=>[item.path,item.bytes]));
  for (const owned of state.active.owned) {
    let actual = null;
    try {
      const value = bytes.get(owned.path);
      if (value !== null && owned.kind === 'file') actual=sha256(value);
      if (value !== null && owned.kind === 'field') {
        const field=readConfigField(owned.path,value,owned.pointer);
        if (field.present) actual=contractDigest(field.value);
      }
      if (actual!==owned.managedHash) diagnostics.push({code:'doctor.owned-drift',subject:owned.path,pointer:owned.pointer});
    } catch (error) {issue(error,owned.path);}
    targets.push({path:owned.path,pointer:owned.pointer,expectedHash:owned.managedHash,observedHash:actual});
  }
  // Bind the selected historical record to the current active deployment, not
  // merely a valid old journal. inspectRecovery validates that relationship.
  result.configuration=diagnostics.length?'fail':'pass';
  await inspectSelectedRecovery();
  for(const match of matches) if(match.recovery!==selectedPath) {
    try {
      const checked=await inspectDoctorRecovery(workspace,match.recovery,{fieldOwnershipOnly:true});
      for(const path of checked.fieldProjections)result.fieldProjections.push({recovery:match.recovery,path});
      if(checked.status!=='applied') {
        result.transactionEvidence='fail';
        diagnostics.push({code:'doctor.transaction-not-applied',subject:match.recovery});
      }
      for(const code of checked.diagnostics) diagnostics.push({code,subject:match.recovery});
    }catch(error){result.transactionEvidence='fail';issue(error,match.recovery);}
  }
  try {
    const finalHistory=await inspectHistory(workspace);
    if (contractDigest(finalHistory)!==contractDigest(result.history))
      diagnostics.push({code:'doctor.observation-drift',subject:'history'});
    if ((await inspectDirectory(resolveChild(workspace,'.pipeline/lock'))).exists &&
        !diagnostics.some(d=>d.code==='doctor.lock-present'))
      diagnostics.push({code:'doctor.lock-present',subject:'.pipeline/lock'});
    if ((await readState(resolveChild(workspace,'.pipeline/state.json'))).digest!==record.digest)
      diagnostics.push({code:'doctor.observation-drift',subject:'.pipeline/state.json'});
    for (const item of await observeTargets(workspace,names)) {
      const before=bytes.get(item.path);
      if ((before===null?null:sha256(before))!==(item.bytes===null?null:sha256(item.bytes)))
        diagnostics.push({code:'doctor.observation-drift',subject:item.path});
    }
  } catch (error) {issue(error,'readback');}
  if (diagnostics.some(d=>d.code==='doctor.observation-drift' || d.subject==='readback'))
    result.transactionEvidence=selectedPath===undefined?'not-verified':'fail';
  if (!result.history.complete || result.history.diagnostics.length)
    result.transactionEvidence='fail';
  if (state.status!=='ready') diagnostics.push({code:'doctor.state-not-ready',subject:'.pipeline/state.json'});
  result.configuration=diagnostics.length?'fail':'pass';
  result.ready=diagnostics.length===0 && result.history.complete && result.transactionEvidence==='pass';
  result.status=result.ready?'ready':diagnostics.some(d=>d.code==='doctor.owned-drift')?'drift':'needs-reconciliation';
  return result;
}
