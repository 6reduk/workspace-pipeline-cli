import {readdir} from 'node:fs/promises';
import {readRecord,observeTargets} from '../operations/state.js';
import {assertMigrationLockHeld} from '../operations/lock.js';
import {resolveChild,inspectDirectory} from '../workspace/paths.js';
import {applyPrepared,writeCheckedFile} from '../operations/apply.js';
import {assertRecoveryBudget} from '../operations/plan.js';
import {providerRegistry} from '../providers/registry.js';
import {validateLegacyUnityDeactivation} from './legacy-unity.js';
import {contractDigest} from '../contracts/semantic.js';
import {sha256} from '../source/inventory.js';
import {parse,fail} from '../contracts/parse.js';
import {verifyLegacyUnityResumedEvidence} from './legacy-unity-resumed-evidence.js';

// Require complete first-phase evidence, not merely disabled settings.
export async function verifyLegacyUnityDeactivationJournal(workspace,recoveryPath,recoveryHash,preview){
 const resumed=await verifyLegacyUnityResumedEvidence(workspace,recoveryPath,recoveryHash,preview);
 if(resumed)return resumed;
 const phase=validateLegacyUnityDeactivation(preview.preflight.deactivation);
 const directory=recoveryPath.replace(/recovery\.json$/,'deactivation');
 await inspectDirectory(resolveChild(workspace,directory));
 const names=(await readdir(resolveChild(workspace,directory))).sort();
 if(names.join(',')!=='000000.json,000001.json,000002.json,000003.json,000004.json,000005.json')fail('migration.phase-incomplete');
 const expected=[{kind:'start',detail:null}];
 for(const t of phase.targets)expected.push(
  {kind:'intent',detail:{path:t.path,beforeHash:t.beforeHash,afterHash:t.afterHash}},
  {kind:'outcome',detail:{path:t.path,status:'completed',observedHash:t.afterHash}});
 expected.push({kind:'phase-checked',detail:{phase:'deactivate-legacy'}});
 let previous=null;
 for(let seq=0;seq<expected.length;seq++){
  const actual=await readRecord(resolveChild(workspace,directory+'/'+names[seq]));
  const event={schemaVersion:1,seq,previous,recoveryHash,...expected[seq]};
  if(contractDigest(actual.value)!==contractDigest(event))fail('migration.phase-evidence');
  previous=actual.digest;
 }
 return {directory,head:previous};
}

// Trusted compiled adapters remain authoritative. The only extra requests are
// exact takeover bindings for the two entry files in the approved migration.
function migrationRegistry(preview){
 const decorate=adapter=>({...adapter,async plan(context){
  const requests=await adapter.plan(context);
  return requests.map(request=>{
   const entry=preview.entries.find(e=>e.path===request.path);
   if(!entry)return request;
   if(request.kind!=='file'||sha256(request.bytes)!==entry.desiredHash)fail('migration.entry-drift');
   return {...request,takeover:{beforeHash:entry.beforeHash,desiredHash:entry.desiredHash}};
  });
 }});
 return {sharedAdapter:decorate(providerRegistry.sharedAdapter),adapters:Object.fromEntries(
  Object.entries(providerRegistry.adapters).map(([id,adapter])=>[id,decorate(adapter)]))};
}

// Second phase delegates target writes/backups/state to native apply. Marker
// remains afterwards; a separate validated finalization must remove it.
export async function executeLegacyUnityInstall(lock,payload,options={}){
 await assertMigrationLockHeld(lock,payload.recoveryPath,payload.recoveryHash);
 const stored=await readRecord(resolveChild(lock.workspace,payload.recoveryPath));
 if(stored.digest!==payload.recoveryHash)fail('migration.recovery-drift');
 const preview=stored.value.preview;
 await verifyLegacyUnityDeactivationJournal(lock.workspace,payload.recoveryPath,payload.recoveryHash,preview);
 for(const row of await observeTargets(lock.workspace,preview.preflight.deactivation.targets.map(t=>t.path))){
  const t=preview.preflight.deactivation.targets.find(t=>t.path===row.path);
  if(row.bytes===null||sha256(row.bytes)!==t.afterHash)fail('migration.phase-drift');
 }
 const body={kind:'prepared-plan',preview:preview.setup,stateFileHash:null,rebind:null,
  preparation:{objects:preview.preflight.supply.objectsPath,snapshot:preview.preflight.supply.snapshotPath},runtime:'not-run'};
 const prepared={...body,digest:contractDigest(body)};
 assertRecoveryBudget(prepared,null);
 // This subordinate approval is derived only from the already authenticated
 // full migration approval. It is not a new claim of a human decision.
 const approval={decision:'approve',preparedDigest:prepared.digest};
 const locatorPath=payload.recoveryPath.replace(/recovery\.json$/,'installation.json');
 const [existing]=await observeTargets(lock.workspace,[locatorPath]);
 if(existing.bytes!==null)fail('migration.install-already-started');
 const applied=await applyPrepared(lock,prepared,approval,migrationRegistry(preview),null,{
  ...options,onJournal:async location=>{
   if(location.status!=='planned')return;
   const runId=location.relative.split('/').at(-1);
   const locator={schemaVersion:1,kind:'legacy-unity-installation',migrationRecoveryHash:payload.recoveryHash,
    preparedDigest:prepared.digest,deactivation:preview.preflight.deactivation.digest,
    journal:location.relative,recoveryPath:`.pipeline/transactions/${runId}/recovery.json`};
   await writeCheckedFile(lock,locatorPath,null,Buffer.from(JSON.stringify(parse(JSON.stringify(locator),'json'))+'\n'));
  }
 });
 return {status:'needs-reconciliation',phase:'install-local-delivery',installationStatus:applied.status,
  recoveryPath:applied.recoveryPath,journal:applied.journal,runtime:'not-run'};
}
