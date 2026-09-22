import {randomUUID} from 'node:crypto';
import {verifyLegacyUnityPreview} from './legacy-unity-preview.js';
import {absoluteRoot,resolveChild} from '../workspace/paths.js';
import {readRecord,observeTargets} from '../operations/state.js';
import {parse,fail} from '../contracts/parse.js';
import {sha256} from '../source/inventory.js';
import {contractDigest} from '../contracts/semantic.js';

const leases=new WeakMap();
const encode=value=>Buffer.from(JSON.stringify(parse(JSON.stringify(value),'json'))+'\n');
const markerPath='.pipeline/migration-operation.json';

// Fresh closeout approval can recreate only a verified persisted migration lease.
export async function createLegacyUnityCloseoutLease(proposal,approval,workspace){
 const {prepareLegacyUnityCloseoutResume}=await import('./legacy-unity-resume.js');
 workspace=absoluteRoot(workspace);
 const detached=parse(JSON.stringify(proposal),'json');
 if(contractDigestApproval(approval)!==detached.digest)fail('migration.resume-approval');
 const actual=await prepareLegacyUnityCloseoutResume(workspace,detached.recoveryPath);
 if(contractDigest(actual)!==contractDigest(detached))fail('migration.resume-drift');
 const recovery=await readRecord(resolveChild(workspace,actual.recoveryPath));
 const [marker]=await observeTargets(workspace,[markerPath]);
 if(recovery.digest!==actual.observations.recovery||marker.bytes===null||sha256(marker.bytes)!==actual.observations.marker)fail('migration.resume-drift');
 const lease=Object.freeze({workspace});
 leases.set(lease,{workspace,recoveryPath:actual.recoveryPath,recoveryBytes:encode(recovery.value),
  recoveryHash:recovery.digest,markerBytes:Buffer.from(marker.bytes),markerHash:sha256(marker.bytes),sealed:true});
 return {lease,preview:actual};
}
function contractDigestApproval(value){
 if(!value||value.decision!=='approve'||typeof value.previewDigest!=='string'||Object.keys(value).sort().join(',')!=='decision,previewDigest')fail('migration.resume-approval');
 return value.previewDigest;
}

export async function createLegacyUnityCompensationLease(proposal,approval,workspace){
 const {prepareLegacyUnityCompensation}=await import('./legacy-unity-compensate.js');
 workspace=absoluteRoot(workspace);const detached=parse(JSON.stringify(proposal),'json');
 if(contractDigestApproval(approval)!==detached.digest)fail('migration.resume-approval');
 const actual=await prepareLegacyUnityCompensation(workspace,detached.recoveryPath);
 if(contractDigest(actual)!==contractDigest(detached))fail('migration.resume-drift');
 const recovery=await readRecord(resolveChild(workspace,actual.recoveryPath));
 const [marker]=await observeTargets(workspace,[markerPath]);
 if(recovery.digest!==actual.recoveryHash||marker.bytes===null||sha256(marker.bytes)!==actual.markerHash)fail('migration.resume-drift');
 const lease=Object.freeze({workspace});
 leases.set(lease,{workspace,recoveryPath:actual.recoveryPath,recoveryBytes:encode(recovery.value),recoveryHash:recovery.digest,
  markerBytes:Buffer.from(marker.bytes),markerHash:sha256(marker.bytes),sealed:true});
 return {lease,preview:actual};
}

export async function createLegacyUnityInstallRecoveryLease(proposal,approval,workspace){
 const {prepareLegacyUnityInstallRecovery}=await import('./legacy-unity-install-recovery.js');
 workspace=absoluteRoot(workspace);const detached=parse(JSON.stringify(proposal),'json');
 if(contractDigestApproval(approval)!==detached.digest)fail('migration.resume-approval');
 const actual=await prepareLegacyUnityInstallRecovery(workspace,detached.recoveryPath);
 if(contractDigest(actual)!==contractDigest(detached))fail('migration.resume-drift');
 const recovery=await readRecord(resolveChild(workspace,actual.recoveryPath));
 const [marker]=await observeTargets(workspace,[markerPath]);
 if(recovery.digest!==actual.recoveryHash||marker.bytes===null||sha256(marker.bytes)!==actual.markerHash)fail('migration.resume-drift');
 const lease=Object.freeze({workspace});
 leases.set(lease,{workspace,recoveryPath:actual.recoveryPath,recoveryBytes:encode(recovery.value),recoveryHash:recovery.digest,
  markerBytes:Buffer.from(marker.bytes),markerHash:sha256(marker.bytes),sealed:true});
 return {lease,preview:actual};
}

export async function createLegacyUnityInstallResumeLease(proposal,approval,workspace){
 const {prepareLegacyUnityInstallResume}=await import('./legacy-unity-install-resume.js');
 workspace=absoluteRoot(workspace);
 const detached=parse(JSON.stringify(proposal),'json');
 if(contractDigestApproval(approval)!==detached.digest)fail('migration.resume-approval');
 const actual=await prepareLegacyUnityInstallResume(workspace,detached.recoveryPath);
 if(contractDigest(actual)!==contractDigest(detached))fail('migration.resume-drift');
 const recovery=await readRecord(resolveChild(workspace,actual.recoveryPath));
 const [marker]=await observeTargets(workspace,[markerPath]);
 if(recovery.digest!==actual.recoveryHash||marker.bytes===null||sha256(marker.bytes)!==actual.markerHash)fail('migration.resume-drift');
 const lease=Object.freeze({workspace});
 leases.set(lease,{workspace,recoveryPath:actual.recoveryPath,recoveryBytes:encode(recovery.value),recoveryHash:recovery.digest,
  markerBytes:Buffer.from(marker.bytes),markerHash:sha256(marker.bytes),sealed:true});
 return {lease,preview:actual};
}

export async function createLegacyUnityDeactivationResumeLease(proposal,approval,workspace){
 const {prepareLegacyUnityDeactivationResume}=await import('./legacy-unity-deactivation-resume.js');
 workspace=absoluteRoot(workspace);
 const detached=parse(JSON.stringify(proposal),'json');
 if(contractDigestApproval(approval)!==detached.digest)fail('migration.resume-approval');
 const actual=await prepareLegacyUnityDeactivationResume(workspace,detached.recoveryPath);
 if(actual.status!=='needs-approval'||contractDigest(actual)!==contractDigest(detached))fail('migration.resume-drift');
 const recovery=await readRecord(resolveChild(workspace,actual.recoveryPath));
 const [marker]=await observeTargets(workspace,[markerPath]);
 if(recovery.digest!==actual.recoveryHash||marker.bytes===null||sha256(marker.bytes)!==actual.markerHash)fail('migration.resume-drift');
 const lease=Object.freeze({workspace});
 leases.set(lease,{workspace,recoveryPath:actual.recoveryPath,recoveryBytes:encode(recovery.value),recoveryHash:recovery.digest,
  markerBytes:Buffer.from(marker.bytes),markerHash:sha256(marker.bytes),sealed:true});
 return {lease,preview:actual};
}

// Process-local capability, issued only after trusted reconstruction and explicit
// complete-preview approval. Serialized objects cannot recreate this capability.
export async function createLegacyUnityLease(proposal,approval,workspace){
 workspace=absoluteRoot(workspace);
 const preview=await verifyLegacyUnityPreview(proposal,approval,workspace);
 const id=randomUUID(),recoveryPath=`.pipeline/migrations/${id}/recovery.json`;
 const record={schemaVersion:1,kind:'legacy-unity-recovery',id,workspace,preview,
  approval:{decision:'approve',previewDigest:preview.digest}};
 const recoveryBytes=encode(record),recoveryHash=sha256(recoveryBytes);
 const marker={schemaVersion:1,kind:'legacy-unity-pending',workspace,recoveryPath,recoveryHash,previewDigest:preview.digest};
 const markerBytes=encode(marker),markerHash=sha256(markerBytes);
 const lease=Object.freeze({workspace});
 leases.set(lease,{workspace,recoveryPath,recoveryBytes,recoveryHash,markerBytes,markerHash,sealed:false});
 return lease;
}
function selected(lease,workspace){
 const value=lease&&leases.get(lease);
 if(!value||value.workspace!==absoluteRoot(workspace))fail('migration.lease');
 return value;
}
export async function assertLegacyUnityLease(lease,workspace){
 const value=selected(lease,workspace);
 const [marker]=await observeTargets(workspace,[markerPath]);
 if(marker.bytes===null){if(value.sealed)fail('migration.marker-missing');return;}
 if(sha256(marker.bytes)!==value.markerHash)fail('migration.marker-drift');
 if(value.sealed&&(await readRecord(resolveChild(workspace,value.recoveryPath))).digest!==value.recoveryHash)fail('migration.recovery-drift');
}
// Internal persistence payload, not another source of approval. Copies prevent
// callers mutating the private capability's expected hashes or bytes.
export function legacyUnityLeasePayload(lease,workspace){
 const value=selected(lease,workspace);
 return {markerPath,markerBytes:Buffer.from(value.markerBytes),markerHash:value.markerHash,
  recoveryPath:value.recoveryPath,recoveryBytes:Buffer.from(value.recoveryBytes),recoveryHash:value.recoveryHash};
}
export async function sealLegacyUnityLease(lease,workspace){
 const value=selected(lease,workspace);
 const [marker]=await observeTargets(workspace,[markerPath]);
 if(marker.bytes===null||sha256(marker.bytes)!==value.markerHash)fail('migration.marker-drift');
 if((await readRecord(resolveChild(workspace,value.recoveryPath))).digest!==value.recoveryHash)fail('migration.recovery-drift');
 value.sealed=true;
}
