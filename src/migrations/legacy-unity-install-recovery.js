import {absoluteRoot,resolveChild} from '../workspace/paths.js';
import {readRecord,observeTargets} from '../operations/state.js';
import {prepareContinuation} from '../operations/reconciliation.js';
import {contractDigest} from '../contracts/semantic.js';
import {sha256} from '../source/inventory.js';
import {fail} from '../contracts/parse.js';
import {verifyLegacyUnityDeactivationJournal} from './legacy-unity-install.js';
import {createLegacyUnityInstallRecoveryLease} from './legacy-unity-lease.js';
import {acquireWorkspaceLock} from '../operations/lock.js';
import {applyContinuation,writeCheckedFile} from '../operations/apply.js';

// Read-only wrapper around the existing native continuation planner. No retry,
// outcome rewriting, migration lease, native write or source acquisition.
export async function prepareLegacyUnityInstallRecovery(workspace,recoveryPath){
 workspace=absoluteRoot(workspace);
 if(typeof recoveryPath!=='string'||!/^\.pipeline\/migrations\/[a-f0-9-]{36}\/recovery\.json$/.test(recoveryPath))fail('migration.recovery-path');
 if((await observeTargets(workspace,[recoveryPath.replace(/recovery\.json$/,'installation-continuation.json')]))[0].bytes!==null)fail('migration.continuation-started');
 const original=await readRecord(resolveChild(workspace,recoveryPath)),r=original.value,p=r.preview;
 if(r.schemaVersion!==1||r.kind!=='legacy-unity-recovery'||r.workspace!==workspace||p?.workspace!==workspace||
  recoveryPath!==`.pipeline/migrations/${r.id}/recovery.json`)fail('migration.recovery-binding');
 const {digest,...body}=p;
 if(contractDigest(body)!==digest||contractDigest(r.approval)!==contractDigest({decision:'approve',previewDigest:digest}))fail('migration.preview-binding');
 const markerPath='.pipeline/migration-operation.json',marker=await readRecord(resolveChild(workspace,markerPath));
 if(contractDigest(marker.value)!==contractDigest({schemaVersion:1,kind:'legacy-unity-pending',workspace,recoveryPath,
  recoveryHash:original.digest,previewDigest:digest}))fail('migration.marker-binding');
 const phase=await verifyLegacyUnityDeactivationJournal(workspace,recoveryPath,original.digest,p);
 const locatorPath=recoveryPath.replace(/recovery\.json$/,'installation.json'),locator=await readRecord(resolveChild(workspace,locatorPath));
 const nativePath=locator.value.recoveryPath;
 if(typeof nativePath!=='string'||!/^\.pipeline\/transactions\/[a-f0-9-]{36}\/recovery\.json$/.test(nativePath))fail('migration.install-binding');
 const native=await readRecord(resolveChild(workspace,nativePath));
 const preparedBody={kind:'prepared-plan',preview:p.setup,stateFileHash:null,rebind:null,
  preparation:{objects:p.preflight.supply.objectsPath,snapshot:p.preflight.supply.snapshotPath},runtime:'not-run'};
 const preparedDigest=contractDigest(preparedBody);
 if(contractDigest(native.value.prepared)!==contractDigest({...preparedBody,digest:preparedDigest})||native.value.previous!==null||
  contractDigest(native.value.approval)!==contractDigest({decision:'approve',preparedDigest}))fail('migration.install-binding');
 const continuation=await prepareContinuation(workspace,nativePath);
 if(continuation.evidence.recoveryHash!==native.digest||contractDigest(locator.value)!==contractDigest({schemaVersion:1,
  kind:'legacy-unity-installation',migrationRecoveryHash:original.digest,preparedDigest,deactivation:p.preflight.deactivation.digest,
  journal:continuation.evidence.journal,recoveryPath:nativePath}))fail('migration.install-binding');
 // These legacy markers are outside native ownership and continuation checks.
 const bindings=p.preflight.observations.filter(o=>o.path.startsWith('.unity-sdd/'));
 for(const row of await observeTargets(workspace,bindings.map(o=>o.path)))
  if(row.bytes===null||sha256(row.bytes)!==bindings.find(o=>o.path===row.path).sha256)fail('migration.legacy-marker-drift');
 for(const record of [{path:recoveryPath,hash:original.digest},{path:markerPath,hash:marker.digest},
  {path:locatorPath,hash:locator.digest},{path:nativePath,hash:native.digest}])
  if((await readRecord(resolveChild(workspace,record.path))).digest!==record.hash)fail('migration.resume-drift');
 if(contractDigest(await verifyLegacyUnityDeactivationJournal(workspace,recoveryPath,original.digest,p))!==contractDigest(phase)||
  (await prepareContinuation(workspace,nativePath)).digest!==continuation.digest)fail('migration.resume-drift');
 const result={schemaVersion:1,kind:'legacy-unity-install-recovery-preview',workspace,recoveryPath,recoveryHash:original.digest,
  markerHash:marker.digest,locatorHash:locator.digest,phase,continuation,status:'needs-approval',executable:false,runtime:'not-run'};
 return {...result,digest:contractDigest(result)};
}

export async function applyLegacyUnityInstallRecovery(proposal,approval,workspace,options={}){
 const {lease,preview}=await createLegacyUnityInstallRecoveryLease(proposal,approval,workspace);
 const lock=await acquireWorkspaceLock(workspace,{migrationOperation:lease});
 try{
  if(contractDigest(await prepareLegacyUnityInstallRecovery(lock.workspace,preview.recoveryPath))!==contractDigest(preview))fail('migration.resume-drift');
  const authorizationPath=preview.recoveryPath.replace(/recovery\.json$/,'installation-continuation-authorization.json');
  const bytes=Buffer.from(JSON.stringify({schemaVersion:1,kind:'legacy-unity-install-recovery-authorization',preview,
   approval:{decision:'approve',previewDigest:preview.digest}})+'\n');
  await writeCheckedFile(lock,authorizationPath,null,bytes);
  const locatorPath=preview.recoveryPath.replace(/recovery\.json$/,'installation-continuation.json');
  const result=await applyContinuation(lock,preview.continuation,{decision:'approve',preparedDigest:preview.continuation.digest},{
   ...options,onJournal:async location=>{
    if(location.status!=='planned')return;
    const recoveryPath=`.pipeline/transactions/${location.relative.split('/').at(-1)}/recovery.json`;
    await writeCheckedFile(lock,locatorPath,null,Buffer.from(JSON.stringify({schemaVersion:1,kind:'legacy-unity-install-continuation',
     migrationRecoveryHash:preview.recoveryHash,authorizationPath,authorizationHash:sha256(bytes),
     preparedDigest:preview.continuation.digest,recoveryPath,journal:location.relative})+'\n'));
   }
  });
  if((await readRecord(resolveChild(lock.workspace,authorizationPath))).digest!==sha256(bytes))fail('migration.authorization-drift');
  return {status:'needs-reconciliation',installationStatus:result.status,recoveryPath:result.recoveryPath,authorizationPath,runtime:'not-run'};
 }finally{await lock.release();}
}
