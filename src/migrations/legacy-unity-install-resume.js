import {randomUUID} from 'node:crypto';
import {absoluteRoot,resolveChild} from '../workspace/paths.js';
import {readRecord,observeTargets,verifyPreparedSnapshot} from '../operations/state.js';
import {contractDigest} from '../contracts/semantic.js';
import {sha256} from '../source/inventory.js';
import {fail} from '../contracts/parse.js';
import {verifyLegacyUnityDeactivationJournal,executeLegacyUnityInstall} from './legacy-unity-install.js';
import {createLegacyUnityInstallResumeLease,legacyUnityLeasePayload} from './legacy-unity-lease.js';
import {acquireWorkspaceLock} from '../operations/lock.js';
import {writeCheckedFile} from '../operations/apply.js';

export async function prepareLegacyUnityInstallResume(workspace,recoveryPath){
 workspace=absoluteRoot(workspace);
 if(typeof recoveryPath!=='string'||!/^\.pipeline\/migrations\/[a-f0-9-]{36}\/recovery\.json$/.test(recoveryPath))fail('migration.recovery-path');
 const record=await readRecord(resolveChild(workspace,recoveryPath)),r=record.value,p=r.preview;
 if(r.schemaVersion!==1||r.kind!=='legacy-unity-recovery'||r.workspace!==workspace||p?.workspace!==workspace||
  recoveryPath!==`.pipeline/migrations/${r.id}/recovery.json`)fail('migration.recovery-binding');
 const {digest,...body}=p;
 if(contractDigest(body)!==digest||contractDigest(r.approval)!==contractDigest({decision:'approve',previewDigest:digest}))fail('migration.preview-binding');
 const markerPath='.pipeline/migration-operation.json',marker=await readRecord(resolveChild(workspace,markerPath));
 if(contractDigest(marker.value)!==contractDigest({schemaVersion:1,kind:'legacy-unity-pending',workspace,recoveryPath,recoveryHash:record.digest,previewDigest:digest}))fail('migration.marker-binding');
 const absent=[recoveryPath.replace(/recovery\.json$/,'installation.json'),'.pipeline/state.json'];
 for(const o of await observeTargets(workspace,absent))if(o.bytes!==null)fail('migration.install-started');
 const phase=await verifyLegacyUnityDeactivationJournal(workspace,recoveryPath,record.digest,p);
 const expected=new Map(p.initialObservations.map(o=>[o.path,o.hash]));
 for(const o of p.preflight.observations){
  if(expected.has(o.path)&&expected.get(o.path)!==o.sha256)fail('migration.observation-binding');
  expected.set(o.path,o.sha256);
 }
 for(const t of p.preflight.deactivation.targets)expected.set(t.path,t.afterHash);
 const observe=async()=>{
  const rows=await observeTargets(workspace,[...expected.keys()]);
  const hashes=rows.map(o=>({path:o.path,hash:o.bytes===null?null:sha256(o.bytes)}));
  if(hashes.some(o=>o.hash!==expected.get(o.path)))fail('migration.observation-drift');
  return hashes;
 };
 const observations=await observe(),s=p.preflight.supply;
 await verifyPreparedSnapshot({snapshotPath:s.snapshotPath,manifest:{id:'unity-sdd',version:s.version},digest:s.digest,inventoryDigest:s.inventoryDigest});
 if(contractDigest(await observe())!==contractDigest(observations)||
  contractDigest(await verifyLegacyUnityDeactivationJournal(workspace,recoveryPath,record.digest,p))!==contractDigest(phase)||
  (await readRecord(resolveChild(workspace,recoveryPath))).digest!==record.digest||
  (await readRecord(resolveChild(workspace,markerPath))).digest!==marker.digest)fail('migration.resume-drift');
 for(const o of await observeTargets(workspace,absent))if(o.bytes!==null)fail('migration.install-started');
 const result={schemaVersion:1,kind:'legacy-unity-install-resume-preview',workspace,recoveryPath,
  recoveryHash:record.digest,markerHash:marker.digest,phase,observations,setup:p.setup,status:'needs-approval',executable:false,runtime:'not-run'};
 return {...result,digest:contractDigest(result)};
}

export async function applyLegacyUnityInstallResume(proposal,approval,workspace,options={}){
 const {lease,preview}=await createLegacyUnityInstallResumeLease(proposal,approval,workspace);
 const lock=await acquireWorkspaceLock(workspace,{migrationOperation:lease});
 try{
  if(contractDigest(await prepareLegacyUnityInstallResume(lock.workspace,preview.recoveryPath))!==contractDigest(preview))fail('migration.resume-drift');
  const authorizationPath=preview.recoveryPath.replace(/recovery\.json$/,`install-authorizations/${randomUUID()}.json`);
  await writeCheckedFile(lock,authorizationPath,null,Buffer.from(JSON.stringify({schemaVersion:1,kind:'legacy-unity-install-authorization',
   preview,approval:{decision:'approve',previewDigest:preview.digest}})+'\n'));
  const result=await executeLegacyUnityInstall(lock,legacyUnityLeasePayload(lease,lock.workspace),options);
  return {...result,authorizationPath};
 }finally{await lock.release();}
}
