import {absoluteRoot,resolveChild} from '../workspace/paths.js';
import {readRecord,observeTargets} from '../operations/state.js';
import {contractDigest} from '../contracts/semantic.js';
import {sha256} from '../source/inventory.js';
import {fail} from '../contracts/parse.js';
import {inspectInstalledLegacyUnityMigration} from './legacy-unity-finalize.js';

// Narrow restart preview: installed phases only, not partial-target recovery.
// Digests bind observations, not authorization. No lock or write is performed.
export async function prepareLegacyUnityCloseoutResume(workspace,recoveryPath){
 workspace=absoluteRoot(workspace);
 if(typeof recoveryPath!=='string'||!/^\.pipeline\/migrations\/[a-f0-9-]{36}\/recovery\.json$/.test(recoveryPath))fail('migration.recovery-path');
 const markerPath='.pipeline/migration-operation.json';
 const marker=await readRecord(resolveChild(workspace,markerPath));
 const recovery=await readRecord(resolveChild(workspace,recoveryPath));
 const r=recovery.value,p=r.preview;
 if(r.kind!=='legacy-unity-recovery'||r.schemaVersion!==1||r.workspace!==workspace||
  recoveryPath!==`.pipeline/migrations/${r.id}/recovery.json`||p?.workspace!==workspace)fail('migration.recovery-binding');
 const {digest,...body}=p;
 if(contractDigest(body)!==digest||contractDigest(r.approval)!==contractDigest({decision:'approve',previewDigest:digest}))fail('migration.preview-binding');
 const expected={schemaVersion:1,kind:'legacy-unity-pending',workspace,recoveryPath,recoveryHash:recovery.digest,previewDigest:digest};
 if(contractDigest(marker.value)!==contractDigest(expected))fail('migration.marker-binding');
 const verified=await inspectInstalledLegacyUnityMigration(workspace,{recoveryPath,recoveryHash:recovery.digest});
 const completionPath=recoveryPath.replace(/recovery\.json$/,'completion.json');
 const [completion]=await observeTargets(workspace,[completionPath]);
 const completionValue={schemaVersion:1,kind:'legacy-unity-completion',workspace,...verified,runtime:'not-run'};
 if(completion.bytes!==null){
  const record=await readRecord(resolveChild(workspace,completionPath));
  if(record.digest!==sha256(completion.bytes)||contractDigest(record.value)!==contractDigest(completionValue))fail('migration.completion-drift');
 }
 const observations={marker:marker.digest,recovery:recovery.digest,completion:completion.bytes===null?null:sha256(completion.bytes)};
 if((await readRecord(resolveChild(workspace,markerPath))).digest!==marker.digest||
  contractDigest(await inspectInstalledLegacyUnityMigration(workspace,{recoveryPath,recoveryHash:recovery.digest}))!==contractDigest(verified))fail('migration.resume-drift');
 const [last]=await observeTargets(workspace,[completionPath]);
 if((last.bytes===null?null:sha256(last.bytes))!==observations.completion)fail('migration.resume-drift');
 const result={schemaVersion:1,kind:'legacy-unity-closeout-preview',workspace,recoveryPath,observations,verified,
  operations:[...(completion.bytes===null?[{action:'create',path:completionPath,value:completionValue}]:[]),
   {action:'delete',path:markerPath,beforeHash:marker.digest}],
  status:'needs-approval',executable:false,runtime:'not-run'};
 return {...result,digest:contractDigest(result)};
}
