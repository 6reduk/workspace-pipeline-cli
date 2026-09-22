import {prepareLegacyUnityDeactivationResume} from './legacy-unity-deactivation-resume.js';
import {validateLegacyUnityDeactivation} from './legacy-unity.js';
import {readRecord,observeTargets} from '../operations/state.js';
import {resolveChild,inspectDirectory} from '../workspace/paths.js';
import {contractDigest} from '../contracts/semantic.js';
import {sha256} from '../source/inventory.js';
import {fail} from '../contracts/parse.js';
import {createLegacyUnityCompensationLease,legacyUnityLeasePayload} from './legacy-unity-lease.js';
import {acquireWorkspaceLock} from '../operations/lock.js';
import {writeCheckedFile,deleteCheckedFile} from '../operations/apply.js';
import {readdir} from 'node:fs/promises';

async function noInstallation(workspace){
 for(const path of ['.pipeline/snapshots','.pipeline/backups','.pipeline/journals','.pipeline/transactions'])
  if((await inspectDirectory(resolveChild(workspace,path))).exists)fail('migration.compensation-installation');
}
export async function prepareLegacyUnityCompensation(workspace,recoveryPath){
 const base=await prepareLegacyUnityDeactivationResume(workspace,recoveryPath);
 if(base.status!=='needs-approval')fail('migration.compensation-conflict');
 await noInstallation(base.workspace);
 // A resumed attempt needs its own recovery/compensation selection, never ignore it.
 if((await inspectDirectory(resolveChild(base.workspace,recoveryPath.replace(/recovery\.json$/,'deactivation-resumes')))).exists)fail('migration.compensation-resumed');
 const stored=await readRecord(resolveChild(base.workspace,recoveryPath));
 if(stored.digest!==base.recoveryHash)fail('migration.resume-drift');
 const phase=validateLegacyUnityDeactivation(stored.value.preview.preflight.deactivation);
 const operations=phase.targets.map(t=>{
  const observed=base.observations.find(o=>o.path===t.path).hash;
  return {path:t.path,action:observed===t.beforeHash?'confirm-original':'restore-original',beforeHash:observed,
   afterHash:t.beforeHash,bytes:t.before};
 });
 const body={schemaVersion:1,kind:'legacy-unity-compensation-preview',workspace:base.workspace,recoveryPath,
  recoveryHash:base.recoveryHash,markerHash:base.markerHash,base,operations,
  removeMarker:{path:'.pipeline/migration-operation.json',beforeHash:base.markerHash},status:'needs-approval',executable:false,runtime:'not-run'};
 return {...body,digest:contractDigest(body)};
}

export async function applyLegacyUnityCompensation(proposal,approval,workspace,{boundary=async()=>{}}={}){
 const {lease,preview}=await createLegacyUnityCompensationLease(proposal,approval,workspace);
 const lock=await acquireWorkspaceLock(workspace,{migrationOperation:lease});
 try{
  if(contractDigest(await prepareLegacyUnityCompensation(lock.workspace,preview.recoveryPath))!==contractDigest(preview))fail('migration.resume-drift');
  const payload=legacyUnityLeasePayload(lease,lock.workspace),directory=preview.recoveryPath.replace(/recovery\.json$/,'compensation');
  const written=[];let previous=null;
  const append=async(kind,detail)=>{
   for(const item of written)if((await readRecord(resolveChild(lock.workspace,item.path))).digest!==item.hash)fail('migration.journal-drift');
   const path=directory+'/'+String(written.length).padStart(6,'0')+'.json';
   const bytes=Buffer.from(JSON.stringify({schemaVersion:1,seq:written.length,previous,kind,detail})+'\n');
   await writeCheckedFile(lock,path,null,bytes);previous=sha256(bytes);written.push({path,hash:previous});
  };
  await append('authorization',{preview,approval:{decision:'approve',previewDigest:preview.digest}});
  const expected=new Map(preview.base.observations.map(o=>[o.path,o.hash]));
  const check=async()=>{
   await noInstallation(lock.workspace);
   const originalDirectory=preview.recoveryPath.replace(/recovery\.json$/,'deactivation');
   let names;try{names=(await readdir(resolveChild(lock.workspace,originalDirectory))).sort();}catch(e){if(e.code!=='ENOENT')throw e;names=[];}
   if(names.join(',')!==preview.base.events.map(e=>e.path.split('/').at(-1)).join(','))fail('migration.journal-drift');
   if((await inspectDirectory(resolveChild(lock.workspace,preview.recoveryPath.replace(/recovery\.json$/,'deactivation-resumes')))).exists)fail('migration.compensation-resumed');
   for(const path of ['.pipeline/state.json',preview.recoveryPath.replace(/recovery\.json$/,'installation.json')])
    if((await observeTargets(lock.workspace,[path]))[0].bytes!==null)fail('migration.compensation-installation');
   for(const e of preview.base.events)if((await readRecord(resolveChild(lock.workspace,e.path))).digest!==e.hash)fail('migration.journal-drift');
   for(const row of await observeTargets(lock.workspace,[...expected.keys()]))
    if((row.bytes===null?null:sha256(row.bytes))!==expected.get(row.path))fail('migration.observation-drift');
  };
  for(const op of preview.operations){
   await check();await append('intent',op);
   try{
    if(op.action==='restore-original')await writeCheckedFile(lock,op.path,op.beforeHash,Buffer.from(op.bytes,'base64'),undefined,boundary);
    const [row]=await observeTargets(lock.workspace,[op.path]);
    if(row.bytes===null||sha256(row.bytes)!==op.afterHash)fail('migration.compensation-drift');
   }catch{
    await append('outcome',{path:op.path,status:'uncertain'});
    return {status:'needs-reconciliation',journal:directory,runtime:'not-run'};
   }
   expected.set(op.path,op.afterHash);await append('outcome',{path:op.path,status:'original-observed',hash:op.afterHash});
  }
  await check();await append('compensated',{recoveryHash:preview.recoveryHash});
  await boundary('compensation-recorded');await check();
  for(const e of written)if((await readRecord(resolveChild(lock.workspace,e.path))).digest!==e.hash)fail('migration.journal-drift');
  await deleteCheckedFile(lock,payload.markerPath,payload.markerHash,async()=>{});
  return {status:'legacy-restored',journal:directory,runtime:'not-run'};
 }finally{await lock.release();}
}
