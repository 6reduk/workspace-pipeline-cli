import {randomUUID} from 'node:crypto';
import {createLegacyUnityCloseoutLease,legacyUnityLeasePayload} from './legacy-unity-lease.js';
import {prepareLegacyUnityCloseoutResume} from './legacy-unity-resume.js';
import {acquireWorkspaceLock} from '../operations/lock.js';
import {writeCheckedFile,deleteCheckedFile} from '../operations/apply.js';
import {readRecord} from '../operations/state.js';
import {resolveChild} from '../workspace/paths.js';
import {contractDigest} from '../contracts/semantic.js';
import {sha256} from '../source/inventory.js';
import {fail} from '../contracts/parse.js';

// Executes only reconstructed closeout operations, never caller-supplied paths.
export async function applyLegacyUnityCloseoutResume(proposal,approval,workspace,{boundary=async()=>{}}={}){
 const {lease,preview}=await createLegacyUnityCloseoutLease(proposal,approval,workspace);
 const lock=await acquireWorkspaceLock(workspace,{migrationOperation:lease});
 try{
  const payload=legacyUnityLeasePayload(lease,lock.workspace);
  const check=()=>prepareLegacyUnityCloseoutResume(lock.workspace,preview.recoveryPath);
  if(contractDigest(await check())!==contractDigest(preview))fail('migration.resume-drift');
  const authorizationPath=preview.recoveryPath.replace(/recovery\.json$/,`closeout-authorizations/${randomUUID()}.json`);
  const authorizationBytes=Buffer.from(JSON.stringify({schemaVersion:1,
   kind:'legacy-unity-closeout-authorization',preview,approval:{decision:'approve',previewDigest:preview.digest}})+'\n');
  await writeCheckedFile(lock,authorizationPath,null,authorizationBytes);
  await boundary('authorization-recorded');
  if(contractDigest(await check())!==contractDigest(preview))fail('migration.resume-drift');
  const creation=preview.operations.find(o=>o.action==='create');
  if(creation)await writeCheckedFile(lock,creation.path,null,Buffer.from(JSON.stringify(creation.value)+'\n'));
  await boundary('completion-recorded');
  const final=await check();
  if(contractDigest(final.verified)!==contractDigest(preview.verified)||final.observations.marker!==preview.observations.marker||
   final.observations.recovery!==preview.observations.recovery||final.operations.length!==1||final.operations[0].action!=='delete')fail('migration.resume-drift');
  const completionPath=preview.recoveryPath.replace(/recovery\.json$/,'completion.json');
  const completion=await readRecord(resolveChild(lock.workspace,completionPath));
  if(completion.digest!==final.observations.completion)fail('migration.completion-drift');
  if((await readRecord(resolveChild(lock.workspace,authorizationPath))).digest!==sha256(authorizationBytes))fail('migration.authorization-drift');
  await deleteCheckedFile(lock,payload.markerPath,payload.markerHash,async()=>{});
  return {status:'completed',authorizationPath,completionPath,completionHash:completion.digest,runtime:'not-run'};
 }finally{await lock.release();}
}
