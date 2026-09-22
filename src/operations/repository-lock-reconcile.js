import path from 'node:path';
import { hostname } from 'node:os';
import { lstat,mkdir,open,rename,readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fail } from '../contracts/parse.js';
import { contractDigest } from '../contracts/semantic.js';
import { absoluteRoot,inspectDirectory,resolveChild } from '../workspace/paths.js';
import { sha256 } from '../source/inventory.js';
import { inventoryRepository } from '../workspace/repository-inventory.js';
import { readRecord } from './state.js';
import { bootstrapLockDirectory } from './bootstrap-lock.js';
import { inspectRepositoryReconciliation,verifyRepositoryCompletion } from './repository-reconcile.js';
import { withRecoveryLease,assertRecoveryLeaseHeld } from './recovery-lease.js';
import {readResumptionApprovals,persistResumptionApproval} from './repository-resumption-approvals.js';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
async function absent(filename) {
  try{await lstat(filename);return false;}catch(e){if(e.code==='ENOENT')return true;throw e;}
}
function liveness(owner) {
  if(owner.host!==hostname())return 'unknown-host';
  try{process.kill(owner.pid,0);return 'live-or-reused-pid';}
  catch(e){return e.code==='ESRCH'?'local-pid-absent':'unknown';}
}
async function observeLock(directory,wrapper) {
  const inventory=await inventoryRepository(directory);
  if(inventory.entries.length!==2 || !inventory.entries.some(e=>e.path==='owner.json' && e.type==='file'))
    fail('repository-lock.foreign-entry');
  const record=await readRecord(path.join(directory,'owner.json')),owner=record.value;
  if(!owner || Object.keys(owner).sort().join(',')!=='createdAt,host,pid,schemaVersion,token,workspace' ||
    owner.schemaVersion!==1 || owner.workspace!==wrapper || !uuid.test(owner.token??'') ||
    !Number.isSafeInteger(owner.pid) || owner.pid<=0 || typeof owner.host!=='string' ||
    typeof owner.createdAt!=='string' || !Number.isFinite(Date.parse(owner.createdAt)))fail('repository-lock.owner');
  return {directory,inventory,ownerDigest:record.digest,owner};
}

// A read-only subject for subsequent explicit recovery approval, never an unlock
// capability. PID absence is observed, not proof that a PID can never be reused.
export async function inspectRepositoryLocks(args) {return inspectLocks(args);}
async function inspectLocks({wrapper,previewText,previewDigest,journal,reconciliationDigest},checkGate) {
  wrapper=absoluteRoot(wrapper);
  const bootstrap=bootstrapLockDirectory(wrapper),gate=bootstrap+'.recovery';
  const guard=checkGate??(async()=>{if(!await absent(gate))fail('repository-lock.recovery-pending');});
  await guard();
  const marker=path.join(wrapper,'.pipeline/repository-operation.json');
  const completed=await absent(marker);
  const verify=async()=>{
    if(completed)return verifyRepositoryCompletion({wrapper,previewText,previewDigest,journal,reconciliationDigest});
    const result=await inspectRepositoryReconciliation(wrapper,previewText,previewDigest);
    if(!result.canFinalize || result.journal!==journal || result.digest!==reconciliationDigest)
      fail('repository-lock.subject');
    return result;
  };
  const subject=await verify();
  const directories=[bootstrap,path.join(wrapper,'.pipeline/lock')];
  const locks=[];for(const directory of directories)locks.push(await observeLock(directory,wrapper));
  if(locks[0].owner.pid!==locks[1].owner.pid || locks[0].owner.host!==locks[1].owner.host)
    fail('repository-lock.owner-mismatch');
  const ownerLiveness=liveness(locks[0].owner);
  if(contractDigest(await verify())!==contractDigest(subject))fail('repository-lock.drift');
  for(let i=0;i<directories.length;i++)
    if(contractDigest(await observeLock(directories[i],wrapper))!==contractDigest(locks[i]))fail('repository-lock.drift');
  await guard();
  if(await absent(marker)!==completed || liveness(locks[0].owner)!==ownerLiveness)
    fail('repository-lock.drift');
  const result={kind:'repository-lock-reconciliation',wrapper,previewDigest,journal,reconciliationDigest,
    phase:completed?'completion-recorded':'finalization-pending',subjectDigest:contractDigest(subject),locks,
    ownerLiveness,status:ownerLiveness==='local-pid-absent'?'stopped-owner-observed':'owner-unconfirmed',
    executionAuthorized:false,canReleaseLock:false};
  return {...result,digest:contractDigest(result)};
}

async function persist(filename,value) {
  const bytes=Buffer.from(JSON.stringify(value)+'\n'),handle=await open(filename,'wx',0o600);
  try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
  const digest=sha256(bytes);
  if((await readRecord(filename)).digest!==digest)fail('repository-lock.readback');
  return digest;
}
const identity=s=>String(s.dev)+':'+String(s.ino);

// Read-only checkpoint reconstruction for interrupted retirement. Historical
// approval is an input binding, not fresh permission to clear the recovery gate.
export async function inspectRepositoryLockRecovery(args) {
  return inspectRecovery(args,false);
}
async function inspectRecovery(args,archivedGate,resumptionHistory=false) {
  const wrapper=absoluteRoot(args.wrapper),{lockDigest}=args;
  if(!/^sha256:[a-f0-9]{64}$/.test(lockDigest??''))fail('repository-lock.recovery-subject');
  const archive=resolveChild(wrapper,'.pipeline/repository-lock-recoveries/'+lockDigest.slice(7));
  const gate=archivedGate?path.join(archive,'recovery-gate'):bootstrapLockDirectory(wrapper)+'.recovery';
  const observe=async()=>{
    const gateInventory=await inventoryRepository(gate),archiveInventory=await inventoryRepository(archive);
    if(gateInventory.entries.length!==2 || !gateInventory.entries.some(e=>e.path==='owner.json' && e.type==='file'))
      fail('repository-lock.gate-drift');
    const gateRecord=await readRecord(path.join(gate,'owner.json')),owner=gateRecord.value;
    if(!owner || Object.keys(owner).sort().join(',')!=='host,lockDigest,pid,schemaVersion,token,wrapper' ||
      owner.schemaVersion!==1 || owner.wrapper!==wrapper || owner.lockDigest!==lockDigest ||
      !uuid.test(owner.token??'') || !Number.isSafeInteger(owner.pid) || owner.pid<=0 || typeof owner.host!=='string')
      fail('repository-lock.recovery-owner');
    const request=await readRecord(path.join(archive,'request.json')),initial=request.value?.observation;
    if(!initial || typeof initial!=='object')fail('repository-lock.recovery-request');
    const {digest,...body}=initial;
    if(digest!==lockDigest || contractDigest(body)!==lockDigest || initial.wrapper!==wrapper ||
      initial.previewDigest!==args.previewDigest || initial.journal!==args.journal ||
      initial.reconciliationDigest!==args.reconciliationDigest || initial.status!=='stopped-owner-observed' ||
      initial.ownerLiveness!=='local-pid-absent' || initial.executionAuthorized!==false || initial.canReleaseLock!==false ||
      !['completion-recorded','finalization-pending'].includes(initial.phase) || !Array.isArray(initial.locks) || initial.locks.length!==2 ||
      contractDigest(request.value)!==contractDigest({schemaVersion:1,approval:{decision:'approve',lockDigest},observation:initial}))
      fail('repository-lock.recovery-request');
    const sources=[bootstrapLockDirectory(wrapper),path.join(wrapper,'.pipeline/lock')],locations=[];
    for(let i=0;i<2;i++) {
      const destination=path.join(archive,i===0?'bootstrap-lock':'workspace-lock'),original=initial.locks[i];
      if(original.directory!==sources[i])fail('repository-lock.recovery-request');
      const sourceAbsent=await absent(sources[i]),destinationAbsent=await absent(destination);
      if(sourceAbsent===destinationAbsent)fail('repository-lock.recovery-location');
      const current=await observeLock(sourceAbsent?destination:sources[i],wrapper);
      const oldRoot=original.inventory?.entries?.find(e=>e.path==='.')?.identity;
      const newRoot=current.inventory.entries.find(e=>e.path==='.').identity;
      if(!oldRoot || oldRoot.dev!==newRoot.dev || oldRoot.ino!==newRoot.ino || current.ownerDigest!==original.ownerDigest ||
        (!sourceAbsent && contractDigest(current)!==contractDigest(original)))fail('repository-lock.history-drift');
      locations.push({state:sourceAbsent?'archived':'original',observation:current,ownerLiveness:liveness(current.owner)});
    }
    // Executor always archives the workspace lock first.
    if(locations[0].state==='archived' && locations[1].state!=='archived')fail('repository-lock.recovery-order');
    const subject=initial.phase==='completion-recorded'?await verifyRepositoryCompletion(args):
      await inspectRepositoryReconciliation(wrapper,args.previewText,args.previewDigest);
    if(contractDigest(subject)!==initial.subjectDigest)fail('repository-lock.subject-drift');
    const receiptFile=path.join(archive,'receipt.json');let receiptDigest=null;
    if(!await absent(receiptFile)) {
      const receipt=await readRecord(receiptFile);receiptDigest=receipt.digest;
      if(locations.some(l=>l.state!=='archived') || contractDigest(receipt.value)!==contractDigest({schemaVersion:1,
        status:'repository-locks-retired',wrapper,lockDigest,requestDigest:request.digest,phase:initial.phase,
        repositoryEffectsPerformed:false,pipelineActivated:false}))fail('repository-lock.recovery-receipt');
    }
    const allowed=['.','request.json',...(receiptDigest?['receipt.json']:[]),
      ...(archivedGate?['recovery-gate','recovery-gate/owner.json']:[]),
      ...(resumptionHistory?['resumption','resumption/owner.json','resumption/approval.json']:[])];
    if(resumptionHistory) {
      const directory=path.join(archive,'resumption');
      const owner=await readRecord(path.join(directory,'owner.json')),approval=await readRecord(path.join(directory,'approval.json'));
      const continuations=await readResumptionApprovals(directory,{wrapper,lockDigest,
        recoveryDigest:owner.value.recoveryDigest,ownerDigest:owner.digest,approvalDigest:approval.digest});
      allowed.push(...continuations.map(r=>'resumption/'+r.name));
    }
    for(let i=0;i<2;i++)if(locations[i].state==='archived') {
      const name=i===0?'bootstrap-lock':'workspace-lock';allowed.push(name,name+'/owner.json');
    }
    if(archiveInventory.entries.some(e=>!allowed.includes(e.path)))fail('repository-lock.history-drift');
    const count=locations.filter(l=>l.state==='archived').length;
    return {kind:'repository-lock-recovery-observation',wrapper,gate,archive,lockDigest,
      status:receiptDigest?'receipt-recorded-gate-retained':count===2?'locks-archived-receipt-missing':
        count===1?'workspace-lock-archived':'intent-recorded',gateInventory,archiveInventory,
      gateDigest:gateRecord.digest,requestDigest:request.digest,receiptDigest,locations,
      recoveryOwnerLiveness:liveness(owner),executionAuthorized:false,canResume:false,canReleaseLock:false};
  };
  const first=await observe();
  if(contractDigest(await observe())!==contractDigest(first))fail('repository-lock.drift');
  return {...first,digest:contractDigest(first)};
}

// Verify the exact approved resumption, whether still blocked or already retained
// in history. No replay, lock release or new receipt; later operations may make
// the original repository subject stale and are not silently projected here.
export async function inspectRepositoryLockResumption(args) {
  const wrapper=absoluteRoot(args.wrapper),{lockDigest,recoveryDigest}=args;
  if(!/^sha256:[a-f0-9]{64}$/.test(lockDigest??'') || !/^sha256:[a-f0-9]{64}$/.test(recoveryDigest??''))
    fail('repository-lock.resumption-subject');
  const base=bootstrapLockDirectory(wrapper),archive=resolveChild(wrapper,'.pipeline/repository-lock-recoveries/'+lockDigest.slice(7));
  const active=base+'.recovery-resume',history=path.join(archive,'resumption');
  const rootId=inventory=>{const e=inventory?.entries?.find(e=>e.path==='.');return e?.identity?.dev+':'+e?.identity?.ino;};
  const observe=async()=>{
    const activeAbsent=await absent(active),historyAbsent=await absent(history);
    if(activeAbsent===historyAbsent)fail('repository-lock.resumption-location');
    const directory=activeAbsent?history:active,inventory=await inventoryRepository(directory);
    const owner=await readRecord(path.join(directory,'owner.json')),approval=await readRecord(path.join(directory,'approval.json'));
    const continuationApprovals=await readResumptionApprovals(directory,{wrapper,lockDigest,recoveryDigest,
      ownerDigest:owner.digest,approvalDigest:approval.digest});
    if(inventory.entries.map(e=>e.path).sort().join(',')!==
      ['.','approval.json','owner.json',...continuationApprovals.map(r=>r.name)].sort().join(','))
      fail('repository-lock.resumption-entries');
    const original=approval.value?.observation,record=owner.value;
    if(!original || typeof original!=='object')fail('repository-lock.resumption-approval');
    const {digest,...body}=original;
    if(digest!==recoveryDigest || contractDigest(body)!==recoveryDigest ||
      original.kind!=='repository-lock-recovery-observation' || original.wrapper!==wrapper || original.lockDigest!==lockDigest ||
      original.archive!==archive || original.gate!==base+'.recovery' ||
      original.executionAuthorized!==false || original.canResume!==false || original.canReleaseLock!==false ||
      original.recoveryOwnerLiveness!=='local-pid-absent' || !Array.isArray(original.locations) || original.locations.length!==2 ||
      original.locations.some(l=>l.ownerLiveness!=='local-pid-absent') ||
      contractDigest(approval.value)!==contractDigest({schemaVersion:1,approval:{decision:'approve',recoveryDigest},observation:original}))
      fail('repository-lock.resumption-approval');
    if(!record || Object.keys(record).sort().join(',')!=='host,pid,recoveryDigest,schemaVersion,token,wrapper' ||
      record.schemaVersion!==1 || record.wrapper!==wrapper || record.recoveryDigest!==recoveryDigest ||
      !Number.isSafeInteger(record.pid) || record.pid<=0 || typeof record.host!=='string' || !uuid.test(record.token??''))
      fail('repository-lock.resumption-owner');
    const gateAbsent=await absent(base+'.recovery'),archivedGateAbsent=await absent(path.join(archive,'recovery-gate'));
    if(gateAbsent===archivedGateAbsent || (activeAbsent && !gateAbsent))fail('repository-lock.resumption-gate');
    const current=await inspectRecovery(args,gateAbsent,activeAbsent);
    if(current.gateDigest!==original.gateDigest || current.requestDigest!==original.requestDigest ||
      (original.receiptDigest!==null && current.receiptDigest!==original.receiptDigest) ||
      rootId(current.gateInventory)!==rootId(original.gateInventory) ||
      rootId(current.archiveInventory)!==rootId(original.archiveInventory) || current.locations.some((l,i)=>
        l.observation.ownerDigest!==original.locations[i].observation.ownerDigest ||
        rootId(l.observation.inventory)!==rootId(original.locations[i].observation.inventory) ||
        (original.locations[i].state==='archived' && l.state!=='archived')) ||
      (gateAbsent && current.status!=='receipt-recorded-gate-retained'))fail('repository-lock.resumption-drift');
    return {kind:'repository-lock-resumption-observation',wrapper,lockDigest,recoveryDigest,
      status:activeAbsent?'resumption-complete':gateAbsent?'gate-archived-resumption-pending':'resumption-in-progress',
      directory,inventory,ownerDigest:owner.digest,approvalDigest:approval.digest,current,continuationApprovals,
      resumptionOwnerLiveness:liveness(record),executionAuthorized:false,canResume:false,canReleaseLock:false};
  };
  const first=await observe();
  if(contractDigest(await observe())!==contractDigest(first))fail('repository-lock.resumption-drift');
  return {...first,digest:contractDigest(first)};
}

// Resume only the remaining actions of a recorded retirement. A second exclusive guard
// prevents concurrent recovery attempts and stays visible to ordinary writers.
// Both guards are preserved by rename; no owner file or history is deleted.
export async function finishRepositoryLockRecovery(args) {
  return withRecoveryLease(args.wrapper,lease=>finishRecovery(args,lease));
}

// Shared effect engine for first retirement and continuation. Approval/guard
// creation and final guard handoff remain separate, but no path has its own
// lock-move or receipt-writing loop. Native observation verifies repository
// subjects and retained request/evidence before every remaining effect.
async function retireRemaining({initial,inspect,checkGuard,ownerLiveness,ioBoundary,movePhase,receiptPhase,details}) {
  const rootId=inventory=>{const e=inventory.entries.find(e=>e.path==='.');return e.identity.dev+':'+e.identity.ino;};
  const expectedLocations=initial.locations.map(l=>l.state);
  let expectedReceipt=initial.receiptDigest;
  const checkCurrent=async()=>{
    await checkGuard();const current=await inspect();
    if(current.requestDigest!==initial.requestDigest || current.gateDigest!==initial.gateDigest ||
      contractDigest(current.gateInventory)!==contractDigest(initial.gateInventory) ||
      rootId(current.archiveInventory)!==rootId(initial.archiveInventory) || current.receiptDigest!==expectedReceipt ||
      current.recoveryOwnerLiveness!==ownerLiveness || current.locations.some((l,i)=>
        l.state!==expectedLocations[i] || l.ownerLiveness!=='local-pid-absent' ||
        l.observation.ownerDigest!==initial.locations[i].observation.ownerDigest ||
        rootId(l.observation.inventory)!==rootId(initial.locations[i].observation.inventory)))
      fail('repository-lock.resume-drift');
    return current;
  };
  for(const index of [1,0]) {
    const current=await checkCurrent();if(expectedLocations[index]==='archived')continue;
    const target=path.join(initial.archive,index===0?'bootstrap-lock':'workspace-lock');
    if(!await absent(target))fail('repository-lock.history-exists');
    await checkGuard();await rename(current.locations[index].observation.directory,target);
    expectedLocations[index]='archived';
    await ioBoundary(movePhase,{...details,archive:initial.archive,index});
  }
  await checkCurrent();const receiptFile=path.join(initial.archive,'receipt.json');
  if(expectedReceipt===null) {
    const request=await readRecord(path.join(initial.archive,'request.json'));
    if(request.digest!==initial.requestDigest)fail('repository-lock.resume-drift');
    await checkGuard();
    expectedReceipt=await persist(receiptFile,{schemaVersion:1,status:'repository-locks-retired',
      wrapper:initial.wrapper,lockDigest:initial.lockDigest,requestDigest:initial.requestDigest,
      phase:request.value.observation.phase,repositoryEffectsPerformed:false,pipelineActivated:false});
    await ioBoundary(receiptPhase,{...details,archive:initial.archive,receiptFile});
  }
  return {observation:await checkCurrent(),receiptFile,receiptDigest:expectedReceipt};
}

async function finishRecovery(args,lease) {
  assertRecoveryLeaseHeld(lease);
  const {approval,ioBoundary=async()=>{}}=args;
  const repeated=approval && Object.keys(approval).sort().join(',')==='decision,resumptionDigest';
  if(!approval || (!repeated && Object.keys(approval).sort().join(',')!=='decision,recoveryDigest') || approval.decision!=='approve')
    fail('repository-lock.resume-approval');
  const prior=repeated?await inspectRepositoryLockResumption(args):null;
  if(prior && prior.digest!==approval.resumptionDigest)fail('repository-lock.resume-stale');
  if(prior?.status==='resumption-complete')return {status:'repository-lock-recovery-finished',
    archive:prior.current.archive,resumption:prior.directory,approvalDigest:prior.approvalDigest,
    pipelineActivated:false,repositoryEffectsPerformed:false};
  if(prior && prior.resumptionOwnerLiveness!=='local-pid-absent')fail('repository-lock.resume-owner');
  const initial=prior?.current??await inspectRepositoryLockRecovery(args);
  if(!prior && initial.digest!==approval.recoveryDigest)fail('repository-lock.resume-stale');
  if(!['intent-recorded','workspace-lock-archived','locks-archived-receipt-missing','receipt-recorded-gate-retained'].includes(initial.status))
    fail('repository-lock.resume-incomplete');
  if(initial.recoveryOwnerLiveness!=='local-pid-absent' || initial.locations.some(l=>l.ownerLiveness!=='local-pid-absent'))
    fail('repository-lock.resume-owner');
  const guard=bootstrapLockDirectory(initial.wrapper)+'.recovery-resume';
  const destination=path.join(initial.archive,'recovery-gate'),history=path.join(initial.archive,'resumption');
  let gateArchived=prior?.status==='gate-archived-resumption-pending';
  if((!gateArchived && !await absent(destination)) || !await absent(history))fail('repository-lock.history-exists');
  if(!prior)try{await mkdir(guard,{mode:0o700});}catch(e){if(e.code==='EEXIST')fail('repository-lock.resume-busy');throw e;}
  const guardId=identity(await lstat(guard,{bigint:true}));
  const ownerDigest=prior?.ownerDigest??await persist(path.join(guard,'owner.json'),{schemaVersion:1,wrapper:initial.wrapper,
    pid:process.pid,host:hostname(),token:randomUUID(),recoveryDigest:initial.digest});
  const approvalDigest=prior?.approvalDigest??await persist(path.join(guard,'approval.json'),{schemaVersion:1,approval,observation:initial});
  const binding={wrapper:initial.wrapper,lockDigest:initial.lockDigest,
    recoveryDigest:prior?.recoveryDigest??initial.digest,ownerDigest,approvalDigest};
  let expectedApprovals=prior?.continuationApprovals??[];
  const checkGuard=async(directory=guard)=>{
    assertRecoveryLeaseHeld(lease);
    await inspectDirectory(directory);
    if(identity(await lstat(directory,{bigint:true}))!==guardId ||
      (await readdir(directory)).sort().join(',')!==['approval.json','owner.json',...expectedApprovals.map(r=>r.name)].sort().join(',') ||
      (await readRecord(path.join(directory,'owner.json'))).digest!==ownerDigest ||
      (await readRecord(path.join(directory,'approval.json'))).digest!==approvalDigest)fail('repository-lock.resume-guard-drift');
    if(contractDigest(await readResumptionApprovals(directory,binding))!==contractDigest(expectedApprovals))
      fail('repository-lock.continuation-drift');
  };
  await ioBoundary('lock-recovery-resume-guard-created',{guard,archive:initial.archive});
  await checkGuard();
  if((await inspectRecovery(args,gateArchived)).digest!==initial.digest)fail('repository-lock.resume-drift');
  if(prior) {
    expectedApprovals=await persistResumptionApproval(guard,prior,approval,lease);
    await ioBoundary('lock-recovery-continuation-authorized',{guard,archive:initial.archive});
    await checkGuard();
  }
  const rootId=inventory=>{const e=inventory.entries.find(e=>e.path==='.');return e.identity.dev+':'+e.identity.ino;};
  const {observation:completed}=await retireRemaining({initial,inspect:()=>inspectRecovery(args,gateArchived),
    checkGuard,ownerLiveness:'local-pid-absent',ioBoundary,details:{guard},
    movePhase:'lock-recovery-resume-lock-archived',receiptPhase:'lock-recovery-resume-receipt-persisted'});
  if(!gateArchived) {
    if(!await absent(destination))fail('repository-lock.history-exists');
    await rename(initial.gate,destination);gateArchived=true;
    await ioBoundary('lock-recovery-gate-archived',{guard,archive:initial.archive});
  }
  await checkGuard();
  const moved=await inspectRecovery(args,true);
  if(!await absent(bootstrapLockDirectory(initial.wrapper)+'.recovery') || rootId(moved.gateInventory)!==rootId(initial.gateInventory) ||
    rootId(moved.archiveInventory)!==rootId(initial.archiveInventory) || moved.gateDigest!==initial.gateDigest ||
    moved.requestDigest!==initial.requestDigest || moved.receiptDigest!==completed.receiptDigest ||
    contractDigest(moved.locations)!==contractDigest(completed.locations) || moved.recoveryOwnerLiveness!=='local-pid-absent')
    fail('repository-lock.resume-drift');
  await checkGuard();
  if(!await absent(history))fail('repository-lock.history-exists');
  // Last state transition removes the exclusion guard by retaining it in history.
  await rename(guard,history);
  await ioBoundary('lock-recovery-resumption-archived',{archive:initial.archive,history});
  await checkGuard(history);
  return {status:'repository-lock-recovery-finished',archive:initial.archive,resumption:history,
    approvalDigest,pipelineActivated:false,repositoryEffectsPerformed:false};
}

// Exact stopped-owner recovery only. Original owner records are retained, not
// deleted. Any interrupted recovery leaves its gate blocking cooperative writers.
export async function recoverRepositoryLocks(args) {
  return withRecoveryLease(args.wrapper,lease=>recoverLocks(args,lease));
}
async function recoverLocks(args,lease) {
  assertRecoveryLeaseHeld(lease);
  const {approval,ioBoundary=async()=>{}}=args;
  if(!approval || Object.keys(approval).sort().join(',')!=='decision,lockDigest' || approval.decision!=='approve')
    fail('repository-lock.approval');
  const initial=await inspectRepositoryLocks(args);
  if(initial.digest!==approval.lockDigest)fail('repository-lock.stale-approval');
  if(initial.ownerLiveness!=='local-pid-absent')fail('repository-lock.owner-unconfirmed');
  const gate=bootstrapLockDirectory(initial.wrapper)+'.recovery';
  const parent=resolveChild(initial.wrapper,'.pipeline/repository-lock-recoveries');
  const archive=path.join(parent,initial.digest.slice(7));
  if(!await absent(archive))fail('repository-lock.history-exists');
  // mkdir is exclusive; failures must not remove somebody else's gate.
  try{await mkdir(gate,{mode:0o700});}catch(e){if(e.code==='EEXIST')fail('repository-lock.recovery-pending');throw e;}
  const gateId=identity(await lstat(gate,{bigint:true}));
  const gateOwner=path.join(gate,'owner.json');
  const gateDigest=await persist(gateOwner,{schemaVersion:1,wrapper:initial.wrapper,lockDigest:initial.digest,
    pid:process.pid,host:hostname(),token:randomUUID()});
  const checkGate=async(directory=gate)=>{
    assertRecoveryLeaseHeld(lease);
    await inspectDirectory(directory);
    if(identity(await lstat(directory,{bigint:true}))!==gateId ||
      (await readdir(directory)).join(',')!=='owner.json' || (await readRecord(path.join(directory,'owner.json'))).digest!==gateDigest)
      fail('repository-lock.gate-drift');
  };
  {
    await ioBoundary('lock-recovery-gate-created',{gate,archive});
    if((await inspectLocks(args,checkGate)).digest!==initial.digest)fail('repository-lock.drift');
    try{await mkdir(parent);}catch(e){if(e.code!=='EEXIST')throw e;}
    await inspectDirectory(parent);await mkdir(archive);
    const archiveId=identity(await lstat(archive,{bigint:true}));
    const requestFile=path.join(archive,'request.json');
    const requestDigest=await persist(requestFile,{schemaVersion:1,approval,observation:initial});
    const checkArchive=async()=>{
      await inspectDirectory(archive);
      if(identity(await lstat(archive,{bigint:true}))!==archiveId ||
        (await readRecord(requestFile)).digest!==requestDigest)fail('repository-lock.history-drift');
    };
    await ioBoundary('lock-recovery-intent-persisted',{gate,archive});
    if((await inspectLocks(args,checkGate)).digest!==initial.digest)fail('repository-lock.drift');
    await checkArchive();
    const inspect=()=>inspectRecovery({...args,lockDigest:initial.digest},false);
    const baseline=await inspect();
    if(baseline.status!=='intent-recorded')fail('repository-lock.drift');
    const {receiptFile,receiptDigest}=await retireRemaining({initial:baseline,inspect,
      checkGuard:async()=>{await checkGate();await checkArchive();},ownerLiveness:'live-or-reused-pid',
      ioBoundary,details:{gate},movePhase:'lock-recovery-lock-archived',receiptPhase:'lock-recovery-receipt-persisted'});
    await checkGate();await checkArchive();
    const archivedGate=path.join(archive,'recovery-gate');
    if(!await absent(archivedGate))fail('repository-lock.history-exists');
    await rename(gate,archivedGate);
    await ioBoundary('lock-recovery-first-gate-archived',{archive,archivedGate});
    await checkGate(archivedGate);
    return {status:'repository-locks-retired',archive,receiptFile,receiptDigest,
      requiresFinalization:initial.phase==='finalization-pending',pipelineActivated:false};
  }
}
