import {createLegacyUnityDeactivationResumeLease} from './legacy-unity-lease.js';
import {prepareLegacyUnityDeactivationResume} from './legacy-unity-deactivation-resume.js';
import {validateLegacyUnityDeactivation} from './legacy-unity.js';
import {acquireWorkspaceLock} from '../operations/lock.js';
import {readRecord,observeTargets} from '../operations/state.js';
import {writeCheckedFile} from '../operations/apply.js';
import {resolveChild} from '../workspace/paths.js';
import {contractDigest} from '../contracts/semantic.js';
import {sha256} from '../source/inventory.js';
import {fail} from '../contracts/parse.js';
import {readdir} from 'node:fs/promises';

// Internal execution only; original uncertain/failed receipts are never rewritten.
export async function applyLegacyUnityDeactivationResume(proposal,approval,workspace,{boundary=async()=>{}}={}){
 const {lease,preview}=await createLegacyUnityDeactivationResumeLease(proposal,approval,workspace);
 const lock=await acquireWorkspaceLock(workspace,{migrationOperation:lease});
 try{
  if(contractDigest(await prepareLegacyUnityDeactivationResume(lock.workspace,preview.recoveryPath))!==contractDigest(preview))fail('migration.resume-drift');
  const record=await readRecord(resolveChild(lock.workspace,preview.recoveryPath));
  const phase=validateLegacyUnityDeactivation(record.value.preview.preflight.deactivation);
  const directory=preview.recoveryPath.replace(/recovery\.json$/,`deactivation-resumes/${preview.digest.slice(7)}`);
  const written=[];let previous=null;
  const append=async(kind,detail)=>{
   for(const item of written)if((await readRecord(resolveChild(lock.workspace,item.path))).digest!==item.hash)fail('migration.journal-drift');
   const path=directory+'/'+String(written.length).padStart(6,'0')+'.json';
   const bytes=Buffer.from(JSON.stringify({schemaVersion:1,seq:written.length,previous,kind,detail})+'\n');
   await writeCheckedFile(lock,path,null,bytes);previous=sha256(bytes);written.push({path,hash:previous});
  };
  await append('authorization',{preview,approval:{decision:'approve',previewDigest:preview.digest}});
  const expected=new Map(preview.observations.map(o=>[o.path,o.hash]));
  const check=async()=>{
   const originalDirectory=preview.recoveryPath.replace(/recovery\.json$/,'deactivation');
   let names;try{names=(await readdir(resolveChild(lock.workspace,originalDirectory))).sort();}catch(error){if(error.code!=='ENOENT')throw error;names=[];}
   if(names.join(',')!==preview.events.map(e=>e.path.split('/').at(-1)).join(','))fail('migration.journal-drift');
   for(const e of preview.events)if((await readRecord(resolveChild(lock.workspace,e.path))).digest!==e.hash)fail('migration.journal-drift');
   for(const path of [preview.recoveryPath.replace(/recovery\.json$/,'installation.json'),'.pipeline/state.json'])
    if((await observeTargets(lock.workspace,[path]))[0].bytes!==null)fail('migration.install-started');
   for(const row of await observeTargets(lock.workspace,[...expected.keys()]))
    if((row.bytes===null?null:sha256(row.bytes))!==expected.get(row.path))fail('migration.observation-drift');
  };
  for(const operation of preview.operations){
   await check();await append('intent',operation);
   try{
    if(operation.action==='write-disabled'){
     const target=phase.targets.find(t=>t.path===operation.path);
     await writeCheckedFile(lock,operation.path,operation.beforeHash,Buffer.from(target.after,'base64'),undefined,boundary);
    }
    const [row]=await observeTargets(lock.workspace,[operation.path]);
    if(row.bytes===null||sha256(row.bytes)!==operation.afterHash)fail('migration.phase-drift');
   }catch{
    const [row]=await observeTargets(lock.workspace,[operation.path]);
    await append('outcome',{path:operation.path,status:'uncertain',observedHash:row.bytes===null?null:sha256(row.bytes)});
    return {status:'needs-reconciliation',outcome:'uncertain',journal:directory,runtime:'not-run'};
   }
   expected.set(operation.path,operation.afterHash);
   await append('outcome',{path:operation.path,status:operation.action==='write-disabled'?'written':'confirmed-observed',observedHash:operation.afterHash});
  }
  await check();await append('phase-observed',{phase:'deactivate-legacy',recoveryHash:preview.recoveryHash});
  for(const e of written)if((await readRecord(resolveChild(lock.workspace,e.path))).digest!==e.hash)fail('migration.journal-drift');
  return {status:'needs-reconciliation',outcome:'phase-observed',journal:directory,runtime:'not-run'};
 }finally{await lock.release();}
}
