import path from 'node:path';
import { hostname } from 'node:os';
import { mkdir,open,lstat } from 'node:fs/promises';
import { fail,ContractError,parse,MAX_INPUT_BYTES } from '../contracts/parse.js';
import { sha256 } from '../source/inventory.js';
import { contractDigest } from '../contracts/semantic.js';
import { inspectDirectory,pathBudget } from '../workspace/paths.js';
import { readRecord } from './state.js';
import { inspectRepositoryBootstrap } from './repository-bootstrap-reconcile.js';
import { inspectBootstrapRecovery,executeBootstrapRecovery } from './repository-bootstrap-continuation.js';
import { withRecoveryLease,assertRecoveryLeaseHeld } from './recovery-lease.js';

async function persist(file,bytes) {
  if(bytes.length>MAX_INPUT_BYTES)fail('bootstrap-recover.input-size');
  const handle=await open(file,'wx',0o600);
  try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
  if((await readRecord(file)).digest!==sha256(bytes))fail('bootstrap-recover.readback');
  return sha256(bytes);
}
async function absent(file) {
  try{await lstat(file);}catch(e){if(e.code==='ENOENT')return;throw e;}
  fail('bootstrap-recover.destination-exists');
}
function requireStopped(owner) {
  if(owner.host!==hostname() || !Number.isSafeInteger(owner.pid) || owner.pid<=0)fail('bootstrap-recover.owner-unknown');
  try {process.kill(owner.pid,0);}catch(e){if(e.code==='ESRCH')return;fail('bootstrap-recover.owner-unknown');}
  fail('bootstrap-recover.owner-live');
}

// Completed receipt or still-absent wrapper. Preserve the original lock as history, do not
// steal it or infer completion from an empty directory. The gate excludes new
// cooperative bootstrap creators while the old lock is relocated.
export async function recoverRepositoryBootstrap(args) {
  return withRecoveryLease(args.wrapper,lease=>recoverBootstrap(args,lease));
}
async function recoverBootstrap({wrapper,previewText,previewDigest,approval,
  ioBoundary=async()=>{},onLocation=async()=>{}},lease) {
  assertRecoveryLeaseHeld(lease);
  if(!approval || Object.keys(approval).sort().join(',')!=='decision,reconciliationDigest' || approval.decision!=='approve')
    fail('bootstrap-recover.approval');
  const inspect=()=>inspectRepositoryBootstrap(wrapper,previewText,previewDigest);
  const initial=await inspect();
  if(initial.digest!==approval.reconciliationDigest)fail('bootstrap-recover.stale-approval');
  const retry=initial.status==='before-state-observed';
  if(!retry && initial.status!=='receipt-consistent-lock-retained')fail('bootstrap-recover.unconfirmed');
  const ownerFile=path.join(initial.directory,'owner.json');
  requireStopped((await readRecord(ownerFile)).value);
  const gate=initial.directory+'.recovery',metadata=path.join(initial.wrapper,'.pipeline');
  const archive=retry?path.join(path.dirname(initial.wrapper),'.wpc-bootstrap-history-'+initial.digest.slice(7)):
    path.join(metadata,'repository-bootstrap-recovered-lock');
  const receipt=retry?path.join(archive,'recovery.json'):path.join(metadata,'repository-bootstrap-recovery.json');
  const recoveryHistory=path.join(path.dirname(initial.wrapper),'.wpc-bootstrap-recovery-'+initial.digest.slice(7));
  pathBudget(gate);pathBudget(archive);pathBudget(receipt);pathBudget(recoveryHistory);
  await absent(archive);await absent(receipt);await absent(recoveryHistory);
  let acquired=false,gateDigest,gateIdentity,requestDigest;
  const identity=s=>String(s.dev)+':'+String(s.ino);
  const checkGate=async(directory=gate)=>{
    assertRecoveryLeaseHeld(lease);
    await inspectDirectory(directory);
    if(identity(await lstat(directory,{bigint:true}))!==gateIdentity ||
      (await readRecord(path.join(directory,'owner.json'))).digest!==gateDigest ||
      (await readRecord(path.join(directory,'request.json'))).digest!==requestDigest)fail('bootstrap-recover.gate-drift');
  };
  try {
    await onLocation({directory:gate,status:'planned'});
    try{await mkdir(gate);acquired=true;}catch(e){if(e.code==='EEXIST')fail('bootstrap-recover.busy');throw e;}
    gateIdentity=identity(await lstat(gate,{bigint:true}));
    gateDigest=await persist(path.join(gate,'owner.json'),Buffer.from(JSON.stringify({pid:process.pid,host:hostname(),
      wrapper:initial.wrapper,reconciliationDigest:initial.digest})+'\n'));
    requestDigest=await persist(path.join(gate,'request.json'),Buffer.from(JSON.stringify({schemaVersion:1,
      approval,initial,preview:parse(previewText,'json')})+'\n'));
    await ioBoundary('recovery-gate-created',{directory:gate});
    await checkGate();
    const current=await inspect();
    const {digest:ignored,...projected}=current;
    projected.observations={...current.observations,recoveryGate:null};
    projected.status=initial.status;
    if(current.status!=='recovery-incomplete' || contractDigest(projected)!==initial.digest)fail('bootstrap-recover.drift');
    const owner=await readRecord(ownerFile);
    if(owner.digest!==initial.recordDigests.owner)fail('bootstrap-recover.drift');
    requireStopped(owner.value);
    if(retry) {
      // Current absence is not a claim that mkdir never happened historically.
      // Archive the attempt without creating/deleting the wrapper or replaying it.
      const intent=await readRecord(path.join(initial.directory,'intent.json'));
      if(intent.digest!==initial.recordDigests.externalIntent)fail('bootstrap-recover.drift');
      await absent(initial.wrapper);await absent(archive);
      await onLocation({directory:archive,status:'history-planned'});
      await checkGate();
      const finalBefore=await inspect();
      const {digest:unused,...projectedBefore}=finalBefore;
      projectedBefore.observations={...finalBefore.observations,recoveryGate:null};
      projectedBefore.status=initial.status;
      if(finalBefore.status!=='recovery-incomplete' || contractDigest(projectedBefore)!==initial.digest)
        fail('bootstrap-recover.drift');
    }
    const recovery=await inspectBootstrapRecovery({wrapper:initial.wrapper,initialDigest:initial.digest});
    const phases={
      'bootstrap-continuation-intent-archived':'recovery-intent-archived',
      'bootstrap-continuation-lock-archived':'recovery-lock-archived',
      'bootstrap-continuation-receipt-persisted':'recovery-receipt-persisted',
      'bootstrap-continuation-gate-archived':'recovery-gate-archived'
    };
    await executeBootstrapRecovery({lease,current:recovery,initialOwner:true,args:{
      wrapper:initial.wrapper,initialDigest:initial.digest,
      ioBoundary:async phase=>ioBoundary(phases[phase],{archive,recoveryHistory})
    }});
    return {status:retry?'bootstrap-attempt-archived':'bootstrap-recovered',
      receipt,archive,recoveryHistory,requiresRepositoryPreview:true,pipelineActivated:false};
  }catch(cause){
    const error=cause instanceof ContractError?cause:new ContractError('bootstrap-recover.io');
    if(acquired)error.recoveryDirectory=gate;throw error;
  }
}
