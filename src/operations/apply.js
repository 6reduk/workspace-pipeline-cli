import path from 'node:path';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fail, parse, ContractError } from '../contracts/parse.js';
import { contractDigest, validateState, validateTransition } from '../contracts/semantic.js';
import { resolveChild, absoluteRoot, inspectDirectory } from '../workspace/paths.js';
import { readRecord, readState, observeTargets, resolveOrigin, resolveApprovedRebind, verifyPreparedSnapshot, verifyInstalledSnapshot } from './state.js';
import { checkPreview, composePlan } from './plan.js';
import { assertLockHeld } from './lock.js';
import { requestShape } from './ownership.js';
import {planObservationPaths,retiredBundleOwnership} from './bundle-update.js';
import {readConfigField} from './config-fields.js';
import { planLayout } from '../workspace/resolve.js';
import { cap, LIMITS, sha256 } from '../source/inventory.js';
import { copySnapshot, saveBackup, verifyBackup } from './backup.js';
import { createJournal, readJournal } from './journal.js';
import {verifyRepairApproval,validateRepairRecord} from './repair.js';
import {verifyContinuationApproval,validateContinuationRecord,continuationTargetAction,continuationCommand} from './reconciliation.js';
import {createLineageGuard} from './lineage-guard.js';
import {verifyRemovalApproval,validateRemovalRecord} from './remove.js';

const fileHash=bytes=>bytes===null?null:sha256(bytes);
const recordBytes=value=>{
  const text=JSON.stringify(value)+'\n';
  // Use the same size/complexity limits as the recovery reader. Reject before
  // pending/target writes rather than persist evidence we cannot read back.
  parse(text,'json');return Buffer.from(text);
};
const scratchName=relative=>path.posix.join(path.posix.dirname(relative),'.wpc-'+randomUUID()+'.tmp');

async function ensureParent(lock,relative) {
  const filename=resolveChild(lock.workspace,relative);
  let directory=lock.workspace;
  for(const segment of relative.split('/').slice(0,-1)) {
    directory=path.join(directory,segment);await assertLockHeld(lock);
    try{await mkdir(directory);}catch(error){if(error.code!=='EEXIST')throw error;}
    await inspectDirectory(directory);
  }
  return filename;
}
async function currentHash(lock,relative) {
  return fileHash((await observeTargets(lock.workspace,[relative]))[0].bytes);
}

// Read-only recovery inspection: never acquires/clears a lock, contacts the
// original source, grants approval, promotes an uncertain receipt or writes state.
// Caller must select the exact recovery record; no guessed "latest" transaction.
export async function inspectRecovery(workspace,recoveryPath,options={}) {
  requestShape(options,[],['fieldOwnershipOnly','evidenceOnly'],'recovery.options');
  if(Object.hasOwn(options,'fieldOwnershipOnly') && typeof options.fieldOwnershipOnly!=='boolean')fail('recovery.options');
  if(Object.hasOwn(options,'evidenceOnly') && typeof options.evidenceOnly!=='boolean')fail('recovery.options');
  if(options.evidenceOnly && options.fieldOwnershipOnly)fail('recovery.options');
  workspace=absoluteRoot(workspace);
  const match=/^\.pipeline\/transactions\/([a-f0-9-]{36})\/recovery\.json$/.exec(recoveryPath);
  if(!match)fail('recovery.path');
  const filename=resolveChild(workspace,recoveryPath),record=await readRecord(filename),recovery=record.value;
  requestShape(recovery,['schemaVersion','prepared','approval','previous','backups'],[],'recovery.record');
  if(recovery.schemaVersion!==1 || !Array.isArray(recovery.backups))fail('recovery.record');
  const repair=recovery.prepared?.kind==='prepared-repair';
  const continuation=recovery.prepared?.kind==='prepared-continuation';
  const removal=recovery.prepared?.kind==='prepared-removal';
  const prepared=removal?validateRemovalRecord(recovery.prepared,recovery.approval):continuation?validateContinuationRecord(recovery.prepared,recovery.approval):repair?validateRepairRecord(recovery.prepared,recovery.approval):validatePreparedRecord(recovery.prepared,recovery.approval),previous=structuredClone(recovery.previous);
  const declared=prepared.preview.observations;
  if(!Array.isArray(declared))fail('recovery.record');
  const before=declared.map(o=>({path:o.path,bytes:o.bytes===null?null:Buffer.from(o.bytes,'base64')}));
  checkPreview(prepared.preview,previous,before);
  const plan=prepared.preview.plan;
  const removalFlow=removal || (continuation && plan.command==='remove');
  const deployment=removalFlow?previous?.active:plan.desired;
  if(plan.workspace!==workspace || !(removalFlow?['remove']:continuation?['repair','update']:repair?['repair']:['setup','update']).includes(plan.command) || !deployment || !plan.source ||
      contractDigest(plan.source)!==contractDigest(deployment.snapshot) ||
      plan.source.path!=='.pipeline/snapshots/'+plan.source.digest.slice(7))fail('recovery.binding');
  if(repair && (!previous?.active || contractDigest(plan.desired)!==contractDigest(previous.active) ||
      plan.targets.some(t=>!['create','edit-fields'].includes(t.action) || t.fields.some(f=>f.beforeHash!==null))))fail('recovery.binding');
  const lineage=continuation?await verifyContinuationLineage(workspace,prepared,previous):[];
  const expectedBackups=new Set(deployment.owned.filter(o=>o.backup!==null).map(o=>o.backup)),seen=new Set();
  for(const backup of recovery.backups) {
    requestShape(backup,['path','hash','existing'],[],'recovery.backup');
    if(!expectedBackups.has(backup.path) || seen.has(backup.path) || typeof backup.existing!=='boolean' ||
        !/^sha256:[a-f0-9]{64}$/.test(backup.hash))fail('recovery.backup');
    seen.add(backup.path);
  }
  if(seen.size!==expectedBackups.size)fail('recovery.backup');
  const journalPath='.pipeline/journals/'+match[1];
  const journal=await readJournal(workspace,journalPath,plan,previous);
  if(options.evidenceOnly) {
    // Historical completed readbacks, NOT current installation/activation proof.
    // Do not compare an old transaction's foreign/full bytes with today's config.
    if(journal.receipt?.status!=='completed')fail('recovery.evidence-unfinished');
    await verifyPreparedSnapshot({snapshotPath:resolveChild(workspace,plan.source.path),
      manifest:{id:deployment.pipelineId,version:deployment.version},digest:plan.source.digest,inventoryDigest:plan.source.inventoryDigest});
    for(const backup of recovery.backups)await verifyBackup(workspace,backup.path,backup.hash);
    if(continuation)await verifyContinuationLineage(workspace,prepared,previous);
    const final=await readJournal(workspace,journalPath,plan,previous);
    if((await readRecord(filename)).digest!==record.digest || contractDigest(final)!==contractDigest(journal))fail('recovery.observation-drift');
    return {status:'completed-evidence',recoveryHash:record.digest,journal:journalPath,
      journalHead:{sequence:journal.sequence,hash:journal.lastHash},runtime:'not-run',automaticActions:false,
      activation:'not-verified',currentTargets:'not-verified',lineage,
      resolves:continuation?{recovery:prepared.evidence.recoveryPath,recoveryHash:prepared.evidence.recoveryHash,
        journalHead:prepared.evidence.journalHead}:null};
  }
  const readCurrent=async()=>{
    try{return await readState(resolveChild(workspace,'.pipeline/state.json'));}
    catch(error){if(error.code==='record.missing')return null;throw error;}
  };
  const current=await readCurrent(),state=current?.value??null,diagnostics=[];
  let statePhase='unrelated';
  // A no-op update can have identical before/after state bytes. A completed
  // journal plus exact ready deployment establishes its outcome; byte equality
  // alone must neither hide that completion nor promote an unfinished journal.
  const completedStatus=plan.desired===null?'not-installed':'ready';
  if(state?.status===completedStatus && state.pending===null && journal.receipt?.status==='completed' &&
      contractDigest(state.active)===contractDigest(plan.desired))statePhase='active';
  else if((current?.digest??null)===prepared.stateFileHash && contractDigest(state)===contractDigest(previous))statePhase='before';
  else if(state?.status==='needs-reconciliation' && state.pending===contractDigest(plan) &&
      contractDigest(state.active)===contractDigest(previous?.active??null))statePhase='pending';
  else if(state?.status===completedStatus && state.pending===null && contractDigest(state.active)===contractDigest(plan.desired))statePhase='active';
  else diagnostics.push('recovery.state-binding');
  if(statePhase==='active' && state.activation &&
      (state.activation.recovery!==recoveryPath || state.activation.recoveryHash!==record.digest ||
       state.activation.journalHead.sequence!==journal.sequence || state.activation.journalHead.hash!==journal.lastHash))
    diagnostics.push('recovery.activation-binding');
  const observations=await observeTargets(workspace,declared.map(o=>o.path));
  const actual=new Map(observations.map(o=>[o.path,fileHash(o.bytes)]));
  const projected=new Set();
  // Doctor's configuration scope may ignore foreign JSON siblings, but only
  // after a completed journal and exact active deployment binding. Neither the
  // historical hashes nor raw current hashes are replaced in the report.
  if(options.fieldOwnershipOnly && statePhase==='active' && journal.receipt?.status==='completed') {
    const fieldHash=(name,bytes,pointer)=>{
      if(bytes===null)return null;
      const field=readConfigField(name,bytes,pointer);
      return field.present?contractDigest(field.value):null;
    };
    for(const observation of observations) {
      const owned=(plan.desired?.owned??[]).filter(o=>o.path===observation.path);
      const target=plan.targets.find(t=>t.path===observation.path);
      const historical=target?prepared.preview.outputs.find(o=>o.path===observation.path):declared.find(o=>o.path===observation.path);
      if(!historical || historical.bytes===null || actual.get(observation.path)===historical.hash ||
          !owned.length || owned.some(o=>o.kind!=='field'))continue;
      try {
        const expected=Buffer.from(historical.bytes,'base64');
        if(owned.every(o=>fieldHash(o.path,expected,o.pointer)===o.managedHash &&
            fieldHash(o.path,observation.bytes,o.pointer)===o.managedHash))projected.add(observation.path);
      }catch{/* Malformed JSON never qualifies for projection. */}
    }
  }
  const targets=plan.targets.map((target,index)=>{
    const observedHash=actual.get(target.path);
    const recorded=journal.receipt?.operations[index].status ?? (index<journal.nextIndex?'completed':index===journal.pending?'uncertain':'skipped');
    const position=observedHash===target.desiredHash || projected.has(target.path)?'desired':observedHash===target.beforeHash?'before':'other';
    if(position==='other' || (recorded==='completed' && position!=='desired') ||
        (recorded==='failed' && position!=='before') || (recorded==='skipped' && position!=='before'))diagnostics.push('recovery.target-drift');
    return {id:target.id,path:target.path,recorded,observedHash,position:projected.has(target.path)?'desired-owned-fields':position};
  });
  const changed=new Set(plan.targets.map(t=>t.path));
  for(const item of declared)if(!changed.has(item.path) && actual.get(item.path)!==item.hash && !projected.has(item.path))diagnostics.push('recovery.dependency-drift');
  try {
    await verifyPreparedSnapshot({snapshotPath:resolveChild(workspace,plan.source.path),manifest:{id:deployment.pipelineId,version:deployment.version},
      digest:plan.source.digest,inventoryDigest:plan.source.inventoryDigest});
  }catch(error){diagnostics.push(error instanceof ContractError?error.code:'recovery.snapshot');}
  if(statePhase!=='active' && previous?.active) {
    // Validate historical installed bytes without interpreting a continuation's
    // pending predecessor as an active/ready state transition.
    try{await verifyInstalledSnapshot({...previous,status:'ready',pending:null});}
    catch{diagnostics.push('recovery.previous-snapshot');}
  }
  for(const backup of recovery.backups) {
    try{await verifyBackup(workspace,backup.path,backup.hash);}
    catch(error){diagnostics.push(error instanceof ContractError?error.code:'recovery.backup');}
  }
  if(statePhase==='active' && (journal.receipt?.status!=='completed' || targets.some(t=>!['desired','desired-owned-fields'].includes(t.position))))diagnostics.push('recovery.activation-unproven');
  if(statePhase==='before' && (journal.nextIndex!==0 || journal.pending!==null || targets.some(t=>t.position!=='before')))diagnostics.push('recovery.before-state-unproven');
  // Detect an inconsistent mixed-time report. This is not a global filesystem
  // snapshot; noncooperative processes can still race after the final reads.
  const after=await readCurrent(),finalJournal=await readJournal(workspace,journalPath,plan,previous);
  if(continuation)await verifyContinuationLineage(workspace,prepared,previous);
  if((after?.digest??null)!==(current?.digest??null) || (await readRecord(filename)).digest!==record.digest ||
      contractDigest(finalJournal)!==contractDigest(journal))fail('recovery.observation-drift');
  for(const item of await observeTargets(workspace,declared.map(o=>o.path)))
    if(fileHash(item.bytes)!==actual.get(item.path))fail('recovery.observation-drift');
  const status=diagnostics.length?'needs-reconciliation':statePhase==='active'?'applied':
    statePhase==='before'?'before-state':'needs-reconciliation';
  return {status,statePhase,diagnostics:[...new Set(diagnostics)],targets,journal:journalPath,
    receipt:journal.receipt,recoveryHash:record.digest,journalHead:{sequence:journal.sequence,hash:journal.lastHash},lineage,runtime:'not-run',
    comparisonScope:options.fieldOwnershipOnly?'owned-configuration':'exact-bytes',fieldProjections:[...projected].sort(),
    requiresFreshPreview:true,automaticActions:false};
}

// Existing files use a same-directory temp + rename; no unlink-then-rename
// fallback. New files use exclusive creation (not an atomic publication); a
// crash may leave a partial file and the pending journal marks it uncertain.
// Same-user hostile OS races cannot be excluded with portable Node filesystem APIs.
export async function writeCheckedFile(lock,relative,beforeHash,bytes,scratch=scratchName(relative),ioBoundary=async()=>{}) {
  await assertLockHeld(lock);
  if(await currentHash(lock,relative)!==beforeHash)fail('apply.target-drift');
  const filename=await ensureParent(lock,relative);
  const staged=beforeHash===null?filename:resolveChild(lock.workspace,scratch);
  const detail={path:relative,stagedPath:beforeHash===null?relative:scratch};
  let handle;
  try {
    handle=await open(staged,'wx',0o600);
    try{
      await ioBoundary('opened',detail);
      await handle.writeFile(bytes);await ioBoundary('written',detail);
      await handle.sync();await ioBoundary('synced',detail);
    }finally{await handle.close();handle=null;}
    if(beforeHash!==null) {
      await ioBoundary('before-rename',detail);
      await assertLockHeld(lock);await inspectDirectory(path.dirname(filename));
      if(await currentHash(lock,relative)!==beforeHash)fail('apply.target-drift');
      const [temp]=await observeTargets(lock.workspace,[scratch]);
      if(fileHash(temp.bytes)!==sha256(bytes))fail('apply.staging-drift');
      await rename(staged,filename);
      await ioBoundary('renamed',detail);
    }
    if(await currentHash(lock,relative)!==sha256(bytes))fail('apply.readback');
    await ioBoundary('readback',detail);
    return sha256(bytes);
  }catch(error){throw error instanceof ContractError?error:new ContractError('apply.write');}
}

// Internal setup/update coordinator. CLI command wiring is later lifecycle work.
// Caller owns lock acquisition/release and genuine user approval. The optional
// boundary callback is a trusted test fault seam, never pipeline-supplied code.
export async function applyPrepared(lock,prepared,approval,registry,previous=null,{boundary=async()=>{},ioBoundary=async()=>{},onJournal=async()=>{}}={}) {
  const checked=await preflightApply(lock,prepared,approval,registry,previous);
  return executeChecked(lock,checked,approval,()=>verifyPreparedApproval(lock,checked.prepared,approval,checked.previous),{boundary,ioBoundary,onJournal});
}

// Installed-snapshot repair has its own replay/approval entrypoint. The shared
// private transaction engine cannot be invoked with a caller-invented preflight.
export async function applyRemoval(lock,prepared,approval,registry,options={}) {
  const copy=await verifyRemovalApproval(lock,prepared,approval,registry);
  approval=structuredClone(approval);
  const previous=(await readState(resolveChild(lock.workspace,'.pipeline/state.json'))).value;
  await preflightPreview(lock,copy.preview,previous,copy.stateFileHash);
  const active=previous.active,source=active.snapshot;
  const snapshot={snapshotPath:resolveChild(lock.workspace,source.path),manifest:{id:active.pipelineId,version:active.version},
    digest:source.digest,inventoryDigest:source.inventoryDigest};
  // Retain and authenticate original backups, including surviving providers.
  const backups=await planBackups(lock,{plan:{desired:active}},previous);
  return executeChecked(lock,{prepared:copy,previous,snapshot,backups},approval,
    ()=>verifyRemovalApproval(lock,copy,approval,registry),options);
}

export async function applyRepair(lock,prepared,approval,registry,options={}) {
  const copy=await verifyRepairApproval(lock,prepared,approval,registry);
  approval=structuredClone(approval);
  const previous=(await readState(resolveChild(lock.workspace,'.pipeline/state.json'))).value;
  await preflightPreview(lock,copy.preview,previous,copy.stateFileHash);
  const source=previous.active.snapshot;
  const snapshot={snapshotPath:resolveChild(lock.workspace,source.path),
    manifest:{id:previous.active.pipelineId,version:previous.active.version},
    digest:source.digest,inventoryDigest:source.inventoryDigest};
  const backups=await planBackups(lock,copy.preview,previous);
  return executeChecked(lock,{prepared:copy,previous:structuredClone(previous),snapshot,backups},approval,
    ()=>verifyRepairApproval(lock,copy,approval,registry),options);
}

// A new transaction records readback outcomes without changing the old journal.
// Source/adapter replay was authorized by the original immutable operation;
// current bytes and exact old evidence require a separate fresh approval here.
export async function applyContinuation(lock,prepared,approval,options={}) {
  const copy=await verifyContinuationApproval(lock,prepared,approval);
  approval=structuredClone(approval);
  let previous=null;
  try { previous=structuredClone((await readState(resolveChild(lock.workspace,'.pipeline/state.json'))).value); }
  catch(error) { if(copy.evidence.statePhase!=='before' || copy.stateFileHash!==null || error.code!=='record.missing')throw error; }
  const old=await readRecord(resolveChild(lock.workspace,copy.evidence.recoveryPath));
  const backups=[];
  for(const backup of old.value.backups) {
    await verifyBackup(lock.workspace,backup.path,backup.hash);
    const [{bytes}]=await observeTargets(lock.workspace,[backup.path]);
    backups.push({...backup,bytes,existing:true});
  }
  const deployment=copy.preview.plan.command==='remove'?previous.active:copy.desired;
  const source=copy.preview.plan.source,snapshot={snapshotPath:resolveChild(lock.workspace,source.path),
    manifest:{id:deployment.pipelineId,version:deployment.version},digest:source.digest,inventoryDigest:source.inventoryDigest};
  return executeChecked(lock,{prepared:copy,previous,snapshot,backups},approval,
    ()=>verifyContinuationApproval(lock,copy,approval),options,
    new Set(copy.actions.filter(a=>a.action==='verify-readback').map(a=>a.path)),
    ()=>verifyContinuationLineage(lock.workspace,copy,previous));
}

async function verifyContinuationLineage(workspace,prepared,previous) {
  const guard=createLineageGuard(),lineage=[];
  while(prepared.kind==='prepared-continuation') {
  const evidence=prepared.evidence;
  guard.visit(evidence.recoveryPath);
  const old=await readRecord(resolveChild(workspace,evidence.recoveryPath));
  if(old.digest!==evidence.recoveryHash)fail('reconciliation.lineage');
  const original=old.value.prepared?.kind==='prepared-removal'?validateRemovalRecord(old.value.prepared,old.value.approval):old.value.prepared?.kind==='prepared-continuation'?validateContinuationRecord(old.value.prepared,old.value.approval):old.value.prepared?.kind==='prepared-repair'?validateRepairRecord(old.value.prepared,old.value.approval):validatePreparedRecord(old.value.prepared,old.value.approval);
  const plan=original.preview.plan;
  if(prepared.preview.plan.command!==continuationCommand(plan) ||
      contractDigest(prepared.preview.plan.source)!==contractDigest(plan.source))fail('reconciliation.lineage');
  checkPreview(original.preview,old.value.previous,original.preview.observations.map(o=>({path:o.path,bytes:o.bytes===null?null:Buffer.from(o.bytes,'base64')})));
  const beforeSetup=evidence.statePhase==='before';
  if(beforeSetup ? (previous!==null || old.value.previous!==null || evidence.stateHash!==null ||
      original.kind!=='prepared-plan' || original.stateFileHash!==null || plan.command!=='setup') :
      (previous?.pending!==contractDigest(plan) || contractDigest(previous?.active)!==contractDigest(old.value.previous?.active??null)))fail('reconciliation.lineage');
  if(contractDigest(prepared.desired)!==contractDigest(plan.desired))fail('reconciliation.lineage');
  const expectedJournal=evidence.recoveryPath.replace('/transactions/','/journals/').replace('/recovery.json','');
  if(evidence.journal!==expectedJournal)fail('reconciliation.lineage');
  const head=await readJournal(workspace,expectedJournal,plan,old.value.previous);
  if(beforeSetup && (head.nextIndex!==0 || head.pending!==null || head.receipt!==null ||
      prepared.actions.some(a=>a.action!=='write-desired' || a.recorded!=='skipped')))fail('reconciliation.lineage');
  if(head.sequence!==evidence.journalHead.sequence || head.lastHash!==evidence.journalHead.hash)fail('reconciliation.lineage');
  if(prepared.stateFileHash!==evidence.stateHash || evidence.workspace!==workspace ||
      contractDigest(prepared.preview.plan.desired)!==contractDigest(plan.desired) ||
      prepared.actions.length!==plan.targets.length || prepared.preview.plan.targets.length!==plan.targets.length)fail('reconciliation.lineage');
  for(let i=0;i<plan.targets.length;i++) {
    const oldTarget=plan.targets[i],action=prepared.actions[i],target=prepared.preview.plan.targets[i];
    const output=original.preview.outputs.find(o=>o.path===oldTarget.path);
    if(action.id!==oldTarget.id || action.path!==oldTarget.path || action.owner!==oldTarget.owner ||
        action.desiredHash!==oldTarget.desiredHash || action.bytes!==(output?.bytes??null) ||
        !['verify-readback','write-desired'].includes(action.action) ||
        action.beforeHash!==(action.action==='verify-readback'?oldTarget.desiredHash:oldTarget.beforeHash) ||
        contractDigest(target)!==contractDigest({id:action.id,path:action.path,owner:action.owner,
          action:continuationTargetAction(action),beforeHash:action.beforeHash,desiredHash:action.desiredHash,fields:[]}))fail('reconciliation.lineage');
  }
  const expectedObservations=original.preview.observations.map(o=>{
    const action=prepared.actions.find(a=>a.path===o.path);
    return action?.action==='verify-readback'?{path:o.path,hash:action.desiredHash,bytes:action.bytes}:o;
  });
  if(contractDigest(expectedObservations)!==contractDigest(prepared.preview.observations) ||
      contractDigest(original.preview.outputs)!==contractDigest(prepared.preview.outputs) ||
      contractDigest(prepared.dependencies)!==contractDigest(original.preview.observations.filter(o=>!plan.targets.some(t=>t.path===o.path))))fail('reconciliation.lineage');
  lineage.push({recovery:evidence.recoveryPath,recoveryHash:evidence.recoveryHash,journalHead:evidence.journalHead});
  prepared=original;previous=old.value.previous;
  }
  return lineage;
}

async function executeChecked(lock,checked,approval,recheck,{boundary=async()=>{},ioBoundary=async()=>{},onJournal=async()=>{}}={},readbackOnly=new Set(),verifyLineage=async()=>{}) {
  let prepared,previous;
  prepared=checked.prepared;previous=checked.previous;approval=structuredClone(approval);
  const plan=prepared.preview.plan,digest=contractDigest(plan);
  const retired=new Set(plan.command==='update'?retiredBundleOwnership(previous,plan.desired).map(o=>o.path):[]);
  if(plan.targets.some(t=>!['create','replace','edit-fields',...((plan.command==='remove' || retired.has(t.path))?['delete','verify-absent']:[])].includes(t.action)))fail('apply.unsupported-action');
  if(plan.targets.some(t=>t.action==='verify-absent' && !readbackOnly.has(t.path)))fail('apply.unsupported-action');
  const pending={schemaVersion:1,workspace:lock.workspace,status:'needs-reconciliation',runtime:'not-run',
    active:previous?.active??null,pending:digest,...(previous?.activation?{activation:structuredClone(previous.activation)}:{})};
  validateState(pending);
  const pendingBytes=recordBytes(pending),ready={...pending,status:plan.desired===null?'not-installed':'ready',active:plan.desired,pending:null};
  validateState(ready);
  // Reserve the complete bounded final-state envelope before any writes.
  recordBytes({...ready,activation:{recovery:'.pipeline/transactions/00000000-0000-0000-0000-000000000000/recovery.json',
    recoveryHash:'sha256:'+'0'.repeat(64),journalHead:{sequence:20001,hash:'sha256:'+'0'.repeat(64)}}});
  const outputs=new Map(prepared.preview.outputs.map(o=>[o.path,Buffer.from(o.bytes,'base64')]));
  const scratch=new Map(plan.targets.map(t=>[t.path,scratchName(t.path)])),stateScratch=scratchName('.pipeline/state.json');
  for(const name of [...scratch.values(),stateScratch])resolveChild(lock.workspace,name);
  const recovery={schemaVersion:1,prepared,approval,previous,backups:checked.backups.map(({path,hash,existing})=>({path,hash,existing}))};
  // Record parsing limits are explicit. Large recovery envelopes fail closed
  // here; split-record storage can extend this later without changing approvals.
  const recoveryBytes=recordBytes(recovery);
  // Fault instrumentation is trusted caller code only, not a package hook.
  // No contents, secrets or open file handles are passed to it.
  const io=purpose=>(phase,detail)=>ioBoundary({phase,purpose,...detail});
  await boundary('preflight');
  await copySnapshot(lock,checked.snapshot);
  for(const backup of checked.backups)await saveBackup(lock,backup.path,backup.bytes,backup.hash);
  await boundary('backups');
  const journal=await createJournal(lock,plan,previous,{ioBoundary:io('journal'),onLocation:onJournal});
  const recoveryPath='.pipeline/transactions/'+journal.relative.split('/').at(-1)+'/recovery.json';
  await writeCheckedFile(lock,recoveryPath,null,recoveryBytes,undefined,io('recovery'));
  await boundary('recovery');
  // Nothing above has changed a provider target or active state. Recheck after
  // staging and before publishing pending, including unchanged dependencies.
  await recheck();
  await verifyPreparedSnapshot({...checked.snapshot,snapshotPath:resolveChild(lock.workspace,plan.source.path)});
  if(await currentHash(lock,recoveryPath)!==sha256(recoveryBytes))fail('apply.recovery-drift');
  for(const backup of checked.backups)await verifyBackup(lock.workspace,backup.path,backup.hash);
  await writeCheckedFile(lock,'.pipeline/state.json',prepared.stateFileHash,pendingBytes,stateScratch,io('pending'));
  await boundary('pending');
  for(let index=0;index<plan.targets.length;index++) {
    const target=plan.targets[index];
    await journal.intent(target.id);await boundary('intent',index);
    let error=null;
    try {
      if(await currentHash(lock,'.pipeline/state.json')!==sha256(pendingBytes))fail('apply.state-drift');
      if(readbackOnly.has(target.path)) {
        await assertLockHeld(lock);
        if(await currentHash(lock,target.path)!==target.desiredHash)fail('apply.target-drift');
      } else if(target.action==='delete')await deleteCheckedFile(lock,target.path,target.beforeHash,io('target'));
      else await writeCheckedFile(lock,target.path,target.beforeHash,outputs.get(target.path),scratch.get(target.path),io('target'));
    }catch(caught){error=caught;}
    // A thrown fault here simulates process death: intent remains uncertain.
    await boundary('write',index);
    let observedHash=null,observed=false;
    try{observedHash=await currentHash(lock,target.path);observed=true;}catch{}
    const status=!error && observed && observedHash===target.desiredHash?'completed':
      observed && observedHash===target.beforeHash?'failed':'uncertain';
    const result=await journal.outcome(status,observedHash);await boundary('outcome',index);
    if(status!=='completed') {
      validateTransition(previous,pending,plan,result.receipt);
      return {status:'needs-reconciliation',receipt:result.receipt,journal:journal.relative,recoveryPath,runtime:'not-run'};
    }
  }
  await boundary('before-active');
  const final=await readJournal(lock.workspace,journal.relative,plan,previous);
  if(final.receipt?.status!=='completed')fail('apply.journal-incomplete');
  const expected=new Map(prepared.preview.observations.map(o=>[o.path,o.hash]));
  for(const target of plan.targets)expected.set(target.path,target.desiredHash);
  for(const observation of await observeTargets(lock.workspace,[...expected.keys()]))
    if(fileHash(observation.bytes)!==expected.get(observation.path))fail('apply.final-drift');
  await verifyPreparedSnapshot({...checked.snapshot,snapshotPath:resolveChild(lock.workspace,plan.source.path)});
  if(await currentHash(lock,recoveryPath)!==sha256(recoveryBytes))fail('apply.recovery-drift');
  for(const backup of checked.backups)await verifyBackup(lock.workspace,backup.path,backup.hash);
  await verifyLineage();
  ready.activation={recovery:recoveryPath,recoveryHash:sha256(recoveryBytes),journalHead:{sequence:final.sequence,hash:final.lastHash}};
  const readyBytes=recordBytes(ready);
  validateTransition(previous,ready,plan,final.receipt);
  await writeCheckedFile(lock,'.pipeline/state.json',sha256(pendingBytes),readyBytes,stateScratch,io('active'));
  await boundary('active');
  return {status:ready.status,state:ready,receipt:final.receipt,journal:journal.relative,recoveryPath,runtime:'not-run'};
}

// Exact owned file only; never recurse, remove directories or follow a link.
// Portable Node APIs cannot exclude hostile same-user races after the last check.
export async function deleteCheckedFile(lock,relative,beforeHash,ioBoundary) {
  if(beforeHash===null)fail('apply.delete-missing');
  const filename=resolveChild(lock.workspace,relative),detail={path:relative};
  await ioBoundary('before-delete',detail);
  await assertLockHeld(lock);
  if(await currentHash(lock,relative)!==beforeHash)fail('apply.target-drift');
  try {
    await unlink(filename);await ioBoundary('deleted',detail);
    if(await currentHash(lock,relative)!==null)fail('apply.readback');
    await ioBoundary('readback',detail);
  }catch(error){throw error instanceof ContractError?error:new ContractError('apply.delete');}
}

// Registry functions are trusted installer code supplied by the caller. They are
// never imported/evaluated from a pipeline package or serialized approval record.
// Re-rendering is mandatory: even a self-consistent envelope is not a path grant.
export async function preflightApply(lock, prepared, approval, registry, previous=null) {
  if(!registry || typeof registry!=='object' || Array.isArray(registry))fail('provider.interface');
  const {adapters,sharedAdapter}=registry;
  if(!adapters || typeof adapters!=='object' || Array.isArray(adapters))fail('provider.interface');
  previous=structuredClone(previous);
  const checked=await verifyPreparedApproval(lock,prepared,approval,previous);
  const copy=checked.prepared,plan=copy.preview.plan;
  for(const candidate of Object.values(copy.preparation)) {
    const root=absoluteRoot(candidate),relative=path.relative(lock.workspace,root),reverse=path.relative(root,lock.workspace);
    const nested=r=>!r || (!path.isAbsolute(r) && r!=='..' && !r.startsWith('..'+path.sep));
    if(nested(relative)||nested(reverse))fail('apply.preparation-location');
    if(!(await inspectDirectory(root)).exists)fail('apply.preparation-missing');
  }
  const options={wrapper:lock.workspace,previous,manifestPath:plan.source.origin.path,command:plan.command};
  const origin=copy.rebind===null?await resolveOrigin(options):await resolveApprovedRebind({...options,...copy.rebind});
  if(contractDigest(origin.origin)!==contractDigest(plan.source.origin))fail('apply.origin-drift');
  const verified=await verifyPreparedSnapshot(checked.snapshot);
  const layout=planLayout(verified.manifest,origin.manifest,lock.workspace,{adapters});
  if(!sharedAdapter || typeof sharedAdapter.plan!=='function')fail('plan.shared-adapter');
  const context=()=>({pipeline:structuredClone(verified.manifest),workspace:structuredClone(origin.manifest),
    layout:structuredClone(layout),snapshot:structuredClone(plan.source),
    files:new Map([...verified.files].map(([name,bytes])=>[name,Buffer.from(bytes)]))});
  const requests=[];
  for(const [owner,adapter] of [['shared',sharedAdapter],...layout.providers.map(id=>[id,adapters[id]])]) {
    if(owner!=='shared' && (await adapter.validate(context()))?.valid===false)fail('provider.validation');
    const batch=await adapter.plan(context());
    if(!Array.isArray(batch))fail('plan.adapter-output');
    for(const request of batch) {
      requestShape(request,['path','owner','kind'],['bytes','fields','takeover'],'plan.request');
      if(request.owner!==owner)fail('plan.adapter-owner');
      requests.push(request);
    }
    cap(requests.length,LIMITS.files,'plan.count');
  }
  // Use a validated envelope's observations. composePlan independently enforces
  // provider roots, ownership/takeover, repository overlap and exact field edits.
  const observations=copy.preview.observations.map(item=>({path:item.path,bytes:item.bytes===null?null:Buffer.from(item.bytes,'base64')}));
  const rendered=composePlan({pipeline:verified.manifest,workspace:origin.manifest,wrapper:lock.workspace,previous,
    snapshot:plan.source,adapters,requests,observations});
  if(contractDigest(rendered)!==contractDigest(copy.preview))fail('apply.adapter-drift');
  const expectedPaths=planObservationPaths(requests,previous,layout);
  if(expectedPaths.length!==observations.length || observations.some(o=>!expectedPaths.includes(o.path)))fail('apply.observation-scope');
  // Adapters may await: repeat all source/state/target observations afterwards.
  await verifyPreparedApproval(lock,copy,approval,previous);
  const backups=await planBackups(lock,rendered,previous);
  return {...checked,previous,backups};
}

// Backup hashes always refer to complete byte files. For historical field-owned
// backups, state authenticates only the owned field value, not foreign siblings.
// Capture their current whole-file hash for this transaction; removal must never
// restore the entire historical file for a field-owned entry.
async function planBackups(lock,preview,previous) {
  const backups=new Map();
  for(const item of preview.plan.desired.owned) {
    if(item.backup===null)continue;
    const old=previous?.active?.owned.find(r=>r.path===item.path && r.kind===item.kind && r.pointer===item.pointer);
    let bytes,existing=false;
    if(old) {
      if(old.backup!==item.backup || old.beforeHash!==item.beforeHash)fail('apply.backup-lineage');
      [{bytes}]=await observeTargets(lock.workspace,[item.backup]);existing=true;
    } else {
      const observation=preview.observations.find(o=>o.path===item.path);
      bytes=observation?.bytes===null || !observation?null:Buffer.from(observation.bytes,'base64');
    }
    if(bytes===null)fail('apply.backup-missing');
    const hash=sha256(bytes);
    if(item.kind==='file') {if(hash!==item.beforeHash)fail('apply.backup-lineage');}
    else {
      const field=readConfigField(item.path,bytes,item.pointer);
      if(!field.present || contractDigest(field.value)!==item.beforeHash)fail('apply.backup-lineage');
    }
    const [stored]=await observeTargets(lock.workspace,[item.backup]);
    if(stored.bytes!==null && sha256(stored.bytes)!==hash)fail('apply.backup-conflict');
    if(backups.has(item.backup) && backups.get(item.backup).hash!==hash)fail('apply.backup-conflict');
    backups.set(item.backup,{path:item.backup,hash,bytes:Buffer.from(bytes),existing});
  }
  return [...backups.values()];
}

// Binds an explicit caller decision to the exact prepared envelope. The caller
// must obtain this decision from the user, not manufacture it from a digest.
// Internal only: no target authorization, state activation, Git or network I/O.
export async function verifyPreparedApproval(lock, prepared, approval, previous=null) {
  const copy=validatePreparedRecord(prepared,approval);previous=structuredClone(previous);
  await preflightPreview(lock,copy.preview,previous,copy.stateFileHash);
  const plan=copy.preview.plan,source=plan.source;
  if(!['setup','update'].includes(plan.command) || !source || !plan.desired ||
      contractDigest(source)!==contractDigest(plan.desired.snapshot))fail('apply.source');
  const options={wrapper:lock.workspace,previous,manifestPath:source.origin.path,command:plan.command};
  const origin=copy.rebind===null ? await resolveOrigin(options) :
    await resolveApprovedRebind({...options,...copy.rebind});
  if(contractDigest(origin.origin)!==contractDigest(source.origin) ||
      contractDigest(origin.manifest.pipeline)!==contractDigest(source.source) ||
      contractDigest(origin.rebind??null)!==contractDigest(copy.rebind))fail('apply.origin-drift');
  const snapshot={snapshotPath:copy.preparation.snapshot,manifest:{id:plan.desired.pipelineId,version:plan.desired.version},
    digest:source.digest,inventoryDigest:source.inventoryDigest};
  if(source.path!=='.pipeline/snapshots/'+source.digest.slice(7))fail('apply.source');
  await verifyPreparedSnapshot(snapshot);
  if(previous?.active)await verifyInstalledSnapshot(previous);
  await preflightPreview(lock,copy.preview,previous,copy.stateFileHash);
  return {prepared:copy,snapshot,runtime:'not-run'};
}

function validatePreparedRecord(prepared,approval) {
  requestShape(prepared,['kind','preview','stateFileHash','rebind','preparation','runtime','digest'],[],'apply.prepared');
  requestShape(approval,['decision','preparedDigest'],[],'apply.approval');
  requestShape(prepared.preparation,['objects','snapshot'],[],'apply.prepared');
  if(prepared.rebind!==null)requestShape(prepared.rebind,['proposal','approval'],[],'apply.prepared');
  const {digest,...body}=prepared;
  if(prepared.kind!=='prepared-plan' || prepared.runtime!=='not-run' || contractDigest(body)!==digest)fail('apply.prepared');
  if(approval.decision!=='approve' || approval.preparedDigest!==digest)fail('apply.approval');
  // Detach before the first await so later caller mutation cannot change inputs.
  return structuredClone(prepared);
}

// Internal read-only preflight primitive, NOT an apply entrypoint or path grant.
// The coordinator must first establish trusted adapter/source/approval binding.
// Checks unchanged dependencies too; a conflict anywhere causes zero target writes.
// The lock is advisory: every target still needs an immediate pre-write recheck.
export async function preflightPreview(lock, envelope, previous, stateFileHash) {
  await assertLockHeld(lock);
  if (envelope?.plan?.workspace !== lock.workspace) fail('apply.workspace');
  const filename=resolveChild(lock.workspace,'.pipeline/state.json');
  async function checkState() {
    let current;
    try { current=await readState(filename); }
    catch(error) { if(error.code!=='record.missing')throw error;current=null; }
    if ((current?.digest ?? null)!==stateFileHash ||
        (current===null)!==(previous===null) ||
        (current!==null && contractDigest(current.value)!==contractDigest(previous))) fail('apply.state-drift');
    if(current?.value.pending!==null && current!==null)fail('state.pending');
  }
  await checkState();
  if(!Array.isArray(envelope.observations))fail('preview.envelope');
  const observations=await observeTargets(lock.workspace,envelope.observations.map(item=>item.path));
  const checked=checkPreview(envelope,previous,observations);
  await checkState();await assertLockHeld(lock);
  return checked;
}
