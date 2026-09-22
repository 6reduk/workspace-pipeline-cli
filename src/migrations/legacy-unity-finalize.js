import {assertMigrationLockHeld} from '../operations/lock.js';
import {readRecord,readState,observeTargets} from '../operations/state.js';
import {inspectRecovery,writeCheckedFile,deleteCheckedFile} from '../operations/apply.js';
import {resolveChild} from '../workspace/paths.js';
import {contractDigest} from '../contracts/semantic.js';
import {sha256} from '../source/inventory.js';
import {fail} from '../contracts/parse.js';
import {verifyLegacyUnityDeactivationJournal} from './legacy-unity-install.js';

// Read-only installed-phase verification. This never issues a write capability.
export async function inspectInstalledLegacyUnityMigration(workspace,payload){
  const stored=await readRecord(resolveChild(workspace,payload.recoveryPath));
  if(stored.digest!==payload.recoveryHash)fail('migration.recovery-drift');
  const preview=stored.value.preview;
  const phase=await verifyLegacyUnityDeactivationJournal(workspace,payload.recoveryPath,payload.recoveryHash,preview);
  const locator=await readRecord(resolveChild(workspace,payload.recoveryPath.replace(/recovery\.json$/,'installation.json')));
  const native=await readRecord(resolveChild(workspace,locator.value.recoveryPath));
  const body={kind:'prepared-plan',preview:preview.setup,stateFileHash:null,rebind:null,
   preparation:{objects:preview.preflight.supply.objectsPath,snapshot:preview.preflight.supply.snapshotPath},runtime:'not-run'};
  const digest=contractDigest(body);
  if(contractDigest(native.value.prepared)!==contractDigest({...body,digest}) || native.value.previous!==null ||
   contractDigest(native.value.approval)!==contractDigest({decision:'approve',preparedDigest:digest}))fail('migration.install-binding');
  let selectedPath=locator.value.recoveryPath,selected=native,continuationHash=null;
  const continuationPath=payload.recoveryPath.replace(/recovery\.json$/,'installation-continuation.json');
  if((await observeTargets(workspace,[continuationPath]))[0].bytes!==null){
   const pointer=await readRecord(resolveChild(workspace,continuationPath));
   const authorizationPath=payload.recoveryPath.replace(/recovery\.json$/,'installation-continuation-authorization.json');
   const authorization=await readRecord(resolveChild(workspace,authorizationPath)),a=authorization.value,p=a.preview;
   if(!p||a.kind!=='legacy-unity-install-recovery-authorization'||a.schemaVersion!==1)fail('migration.continuation-binding');
   const {digest:approvedDigest,...approvedBody}=p;
   if(contractDigest(approvedBody)!==approvedDigest||contractDigest(a.approval)!==contractDigest({decision:'approve',previewDigest:approvedDigest})||
    p.workspace!==workspace||p.recoveryPath!==payload.recoveryPath||p.recoveryHash!==payload.recoveryHash||p.locatorHash!==locator.digest||
    contractDigest(p.phase)!==contractDigest(phase)||p.continuation?.evidence?.recoveryPath!==locator.value.recoveryPath||
    p.continuation.evidence.recoveryHash!==native.digest)fail('migration.continuation-binding');
   selectedPath=pointer.value.recoveryPath;
   if(typeof selectedPath!=='string'||!/^\.pipeline\/transactions\/[a-f0-9-]{36}\/recovery\.json$/.test(selectedPath))fail('migration.continuation-binding');
   const expectedPointer={schemaVersion:1,kind:'legacy-unity-install-continuation',migrationRecoveryHash:payload.recoveryHash,
    authorizationPath,authorizationHash:authorization.digest,preparedDigest:p.continuation.digest,recoveryPath:selectedPath,
    journal:selectedPath.replace('/transactions/','/journals/').replace('/recovery.json','')};
   if(contractDigest(pointer.value)!==contractDigest(expectedPointer))fail('migration.continuation-binding');
   selected=await readRecord(resolveChild(workspace,selectedPath));
   if(contractDigest(selected.value.prepared)!==contractDigest(p.continuation)||
    contractDigest(selected.value.approval)!==contractDigest({decision:'approve',preparedDigest:p.continuation.digest}))fail('migration.continuation-binding');
   continuationHash=pointer.digest;
  }
  const checked=await inspectRecovery(workspace,selectedPath);
  const expected={schemaVersion:1,kind:'legacy-unity-installation',migrationRecoveryHash:payload.recoveryHash,
   preparedDigest:digest,deactivation:preview.preflight.deactivation.digest,
   journal:locator.value.recoveryPath.replace('/transactions/','/journals/').replace('/recovery.json',''),recoveryPath:locator.value.recoveryPath};
  if(contractDigest(locator.value)!==contractDigest(expected) || checked.recoveryHash!==selected.digest)fail('migration.install-binding');
  if(continuationHash&&(checked.lineage.length!==1||checked.lineage[0].recovery!==locator.value.recoveryPath||checked.lineage[0].recoveryHash!==native.digest))fail('migration.continuation-binding');
  if(checked.status!=='applied'||checked.statePhase!=='active'||checked.diagnostics.length)fail('migration.install-incomplete');
  const state=await readState(resolveChild(workspace,'.pipeline/state.json'));
  if(contractDigest(state.value.activation)!==contractDigest({recovery:selectedPath,
   recoveryHash:selected.digest,journalHead:checked.journalHead}))fail('migration.activation-binding');
  // Native exact target verification covers final configs (including opt-outs).
  // Legacy binding markers are not native targets and must also remain unchanged.
  const markers=preview.preflight.observations.filter(o=>o.path.startsWith('.unity-sdd/'));
  for(const row of await observeTargets(workspace,markers.map(o=>o.path))){
   const expected=markers.find(o=>o.path===row.path);
   if(row.bytes===null||sha256(row.bytes)!==expected.sha256)fail('migration.legacy-marker-drift');
  }
  return {migrationRecoveryHash:stored.digest,installationLocatorHash:locator.digest,
   deactivationHead:phase.head,stateHash:state.digest,nativeRecoveryHash:selected.digest,native:checked,
   ...(continuationHash?{continuationHash,originalNativeRecoveryHash:native.digest}:{})};
}

// Internal same-process closeout. Restart authorization/recovery is separate.
export async function finalizeLegacyUnityMigration(lock,payload,{boundary=async()=>{}}={}){
 const check=async()=>{
  await assertMigrationLockHeld(lock,payload.recoveryPath,payload.recoveryHash);
  return inspectInstalledLegacyUnityMigration(lock.workspace,payload);
 };
 const verified=await check();
 const completionPath=payload.recoveryPath.replace(/recovery\.json$/,'completion.json');
 const bytes=Buffer.from(JSON.stringify({schemaVersion:1,kind:'legacy-unity-completion',
  workspace:lock.workspace,...verified,runtime:'not-run'})+'\n');
 await writeCheckedFile(lock,completionPath,null,bytes);
 await boundary('completion-recorded');
 if(contractDigest(await check())!==contractDigest(verified))fail('migration.completion-drift');
 if((await readRecord(resolveChild(lock.workspace,completionPath))).digest!==sha256(bytes))fail('migration.completion-drift');
 await deleteCheckedFile(lock,payload.markerPath,payload.markerHash,async phase=>{
  if(phase==='before-delete')await boundary('before-marker-removal');
 });
 // Marker removal deliberately invalidates the sealed migration capability.
 // Caller can release it, but cannot perform further migration writes.
 return {status:'completed',completionPath,completionHash:sha256(bytes),runtime:'not-run'};
}
