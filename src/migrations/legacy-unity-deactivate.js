import {readRecord,observeTargets} from '../operations/state.js';
import {writeCheckedFile} from '../operations/apply.js';
import {assertMigrationLockHeld} from '../operations/lock.js';
import {resolveChild} from '../workspace/paths.js';
import {validateLegacyUnityDeactivation} from './legacy-unity.js';
import {sha256} from '../source/inventory.js';
import {parse,fail,ContractError} from '../contracts/parse.js';

// Internal first-phase executor. New activation is deliberately not performed.
// Every attempt has an exclusive journal; replay requires a future recovery API.
export async function executeLegacyUnityDeactivation(lock,payload,{boundary=async()=>{}}={}){
 const guard=()=>assertMigrationLockHeld(lock,payload.recoveryPath,payload.recoveryHash);
 await guard();
 const stored=await readRecord(resolveChild(lock.workspace,payload.recoveryPath));
 if(stored.digest!==payload.recoveryHash)fail('migration.recovery-drift');
 const record=stored.value,preview=record.preview;
 if(record.workspace!==lock.workspace||record.approval?.previewDigest!==preview.digest||record.approval?.decision!=='approve')fail('migration.recovery-binding');
 const phase=validateLegacyUnityDeactivation(preview.preflight.deactivation);
 const before=new Map(preview.initialObservations.map(x=>[x.path,x.hash]));
 for(const x of preview.preflight.observations){
  if(before.has(x.path)&&before.get(x.path)!==x.sha256)fail('migration.observation-binding');
  before.set(x.path,x.sha256);
 }
 for(const row of await observeTargets(lock.workspace,[...before.keys()]))
  if((row.bytes===null?null:sha256(row.bytes))!==before.get(row.path))fail('migration.observation-drift');
 const directory=payload.recoveryPath.replace(/recovery\.json$/,'deactivation');
 let seq=0,head=null,lastPath;const written=[];
 async function append(kind,detail){
  await guard();
  if(lastPath&&(await readRecord(resolveChild(lock.workspace,lastPath))).digest!==head)fail('migration.journal-drift');
  const relative=directory+'/'+String(seq).padStart(6,'0')+'.json';
  const event={schemaVersion:1,seq,previous:head,recoveryHash:payload.recoveryHash,kind,detail};
  const bytes=Buffer.from(JSON.stringify(parse(JSON.stringify(event),'json'))+'\n');
  await writeCheckedFile(lock,relative,null,bytes);
  lastPath=relative;head=sha256(bytes);written.push({path:relative,hash:head});seq++;
 }
 await append('start',null);
 for(const target of phase.targets){
  await append('intent',{path:target.path,beforeHash:target.beforeHash,afterHash:target.afterHash});
  try{
   await writeCheckedFile(lock,target.path,target.beforeHash,Buffer.from(target.after,'base64'),undefined,
    async step=>boundary(step,{path:target.path}));
  }catch(error){
   // Error after a write is not silently promoted to successful completion.
   let observedHash=null;
   try{const [row]=await observeTargets(lock.workspace,[target.path]);observedHash=row.bytes===null?null:sha256(row.bytes);}catch{}
   const status=observedHash===target.beforeHash?'failed':'uncertain';
   await append('outcome',{path:target.path,status,observedHash});
   return {status:'needs-reconciliation',phase:'deactivate-legacy',outcome:status,
    journal:directory,error:error instanceof ContractError?error.code:'migration.target-io',runtime:'not-run'};
  }
  await append('outcome',{path:target.path,status:'completed',observedHash:target.afterHash});
 }
 for(const row of await observeTargets(lock.workspace,phase.targets.map(t=>t.path)))
  if(row.bytes===null||sha256(row.bytes)!==phase.targets.find(t=>t.path===row.path).afterHash)fail('migration.phase-drift');
 await append('phase-checked',{phase:'deactivate-legacy'});
 for(const item of written)if((await readRecord(resolveChild(lock.workspace,item.path))).digest!==item.hash)fail('migration.journal-drift');
 return {status:'needs-reconciliation',phase:'deactivate-legacy',outcome:'completed',journal:directory,
  next:'install-local-delivery',runtime:'not-run'};
}
