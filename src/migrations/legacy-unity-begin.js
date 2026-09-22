import {createLegacyUnityLease,legacyUnityLeasePayload,sealLegacyUnityLease} from './legacy-unity-lease.js';
import {verifyLegacyUnityPreview} from './legacy-unity-preview.js';
import {acquireWorkspaceLock,assertLockHeld} from '../operations/lock.js';
import {writeCheckedFile} from '../operations/apply.js';
import {executeLegacyUnityDeactivation} from './legacy-unity-deactivate.js';
import {executeLegacyUnityInstall} from './legacy-unity-install.js';
import {finalizeLegacyUnityMigration} from './legacy-unity-finalize.js';

// Persist recovery before any provider writes. Marker is written FIRST so a
// crash saving recovery is still fail-closed for ordinary lifecycle commands.
// No automatic rollback/unlink on error. Caller owns the returned lock lifetime.
export async function beginLegacyUnityMigration(proposal,approval,workspace,{boundary=async()=>{}}={}){
 const lease=await createLegacyUnityLease(proposal,approval,workspace);
 let lock;
 try{
  lock=await acquireWorkspaceLock(workspace,{migrationOperation:lease});
  await boundary('locked');
  await verifyLegacyUnityPreview(proposal,approval,lock.workspace,lock);
  const payload=legacyUnityLeasePayload(lease,lock.workspace);
  await writeCheckedFile(lock,payload.markerPath,null,payload.markerBytes,undefined,
   async phase=>boundary('marker:'+phase));
  await writeCheckedFile(lock,payload.recoveryPath,null,payload.recoveryBytes,undefined,
   async phase=>boundary('recovery:'+phase));
  await sealLegacyUnityLease(lease,lock.workspace);
  await assertLockHeld(lock);
  return Object.freeze({lock,recoveryPath:payload.recoveryPath,recoveryHash:payload.recoveryHash,
   status:'needs-reconciliation',providerWrites:0,runtime:'not-run',
   deactivate:options=>executeLegacyUnityDeactivation(lock,payload,options),
   install:options=>executeLegacyUnityInstall(lock,payload,options),
   finalize:options=>finalizeLegacyUnityMigration(lock,payload,options)});
 }catch(error){
  if(lock){try{await lock.release({removeEmptyMetadata:true});}catch{error.lockRelease='failed';}}
  throw error;
 }
}
