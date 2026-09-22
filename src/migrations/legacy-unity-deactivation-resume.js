import {readdir} from 'node:fs/promises';
import {absoluteRoot,resolveChild,inspectDirectory} from '../workspace/paths.js';
import {readRecord,observeTargets} from '../operations/state.js';
import {contractDigest} from '../contracts/semantic.js';
import {sha256} from '../source/inventory.js';
import {fail} from '../contracts/parse.js';
import {validateLegacyUnityDeactivation,inspectLegacyUnityDeactivation} from './legacy-unity.js';

// Read-only first-phase reconciliation. A current after hash is NOT a receipt.
export async function prepareLegacyUnityDeactivationResume(workspace,recoveryPath){
 workspace=absoluteRoot(workspace);
 if(typeof recoveryPath!=='string'||!/^\.pipeline\/migrations\/[a-f0-9-]{36}\/recovery\.json$/.test(recoveryPath))fail('migration.recovery-path');
 const recovery=await readRecord(resolveChild(workspace,recoveryPath)),r=recovery.value,p=r.preview;
 if(r.schemaVersion!==1||r.kind!=='legacy-unity-recovery'||r.workspace!==workspace||p?.workspace!==workspace||
  recoveryPath!==`.pipeline/migrations/${r.id}/recovery.json`)fail('migration.recovery-binding');
 const {digest,...body}=p;
 if(contractDigest(body)!==digest||contractDigest(r.approval)!==contractDigest({decision:'approve',previewDigest:digest}))fail('migration.preview-binding');
 const markerPath='.pipeline/migration-operation.json',marker=await readRecord(resolveChild(workspace,markerPath));
 if(contractDigest(marker.value)!==contractDigest({schemaVersion:1,kind:'legacy-unity-pending',workspace,recoveryPath,
  recoveryHash:recovery.digest,previewDigest:digest}))fail('migration.marker-binding');
 // Once native installation begins this narrow route must not restore its inputs.
 for(const path of [recoveryPath.replace(/recovery\.json$/,'installation.json'),'.pipeline/state.json']){
  if((await observeTargets(workspace,[path]))[0].bytes!==null)fail('migration.install-started');
 }
 const phase=validateLegacyUnityDeactivation(p.preflight.deactivation);
 const directory=recoveryPath.replace(/recovery\.json$/,'deactivation');
 const exists=(await inspectDirectory(resolveChild(workspace,directory))).exists;
 const names=exists?(await readdir(resolveChild(workspace,directory))).sort():[];
 if(names.length>6||names.some((name,i)=>name!==String(i).padStart(6,'0')+'.json'))fail('migration.phase-evidence');
 const events=[],intents=new Set(),completed=new Set();let previous=null,stopped=false;
 for(let seq=0;seq<names.length;seq++){
  if(stopped)fail('migration.phase-evidence');
  const record=await readRecord(resolveChild(workspace,directory+'/'+names[seq]));
  const event=record.value;let expected;
  if(seq===0)expected={kind:'start',detail:null};
  else if(seq===5)expected={kind:'phase-checked',detail:{phase:'deactivate-legacy'}};
  else{
   const t=phase.targets[Math.floor((seq-1)/2)];
   if(seq%2){expected={kind:'intent',detail:{path:t.path,beforeHash:t.beforeHash,afterHash:t.afterHash}};intents.add(t.path);}
   else{
    const d=event.detail;
    if(!d||!['completed','failed','uncertain'].includes(d.status)||
     !(d.observedHash===null||/^sha256:[a-f0-9]{64}$/.test(d.observedHash)))fail('migration.phase-evidence');
    if(d.status==='completed'&&d.observedHash!==t.afterHash||d.status==='failed'&&d.observedHash!==t.beforeHash)fail('migration.phase-evidence');
    stopped=d.status!=='completed';if(!stopped)completed.add(t.path);
    expected={kind:'outcome',detail:{path:t.path,status:d.status,observedHash:d.observedHash}};
   }
  }
  if(contractDigest(event)!==contractDigest({schemaVersion:1,seq,previous,recoveryHash:recovery.digest,...expected}))fail('migration.phase-evidence');
  previous=record.digest;events.push({path:directory+'/'+names[seq],hash:record.digest});
 }
 const expected=new Map(p.initialObservations.map(o=>[o.path,o.hash]));
 for(const o of p.preflight.observations){
  if(expected.has(o.path)&&expected.get(o.path)!==o.sha256)fail('migration.observation-binding');
  expected.set(o.path,o.sha256);
 }
 const rows=await observeTargets(workspace,[...expected.keys()]);
 const classifications=inspectLegacyUnityDeactivation(phase,phase.targets.map(t=>({provider:t.provider,bytes:rows.find(r=>r.path===t.path).bytes})));
 for(const row of rows){
  if(phase.targets.some(t=>t.path===row.path))continue;
  if((row.bytes===null?null:sha256(row.bytes))!==expected.get(row.path))fail('migration.observation-drift');
 }
 const conflicts=classifications.filter(t=>t.state==='conflict'||t.state==='after'&&!intents.has(t.path)||t.state==='before'&&completed.has(t.path));
 const operations=conflicts.length?[]:classifications.map(t=>({path:t.path,
  action:t.state==='before'?'write-disabled':'confirm-observed',state:t.state,
  beforeHash:sha256(rows.find(r=>r.path===t.path).bytes),afterHash:phase.targets.find(x=>x.path===t.path).afterHash}));
 // Recheck evidence and files, without claiming a global atomic snapshot.
 for(const e of [{path:markerPath,hash:marker.digest},{path:recoveryPath,hash:recovery.digest},...events])
  if((await readRecord(resolveChild(workspace,e.path))).digest!==e.hash)fail('migration.resume-drift');
 if(exists&&(await readdir(resolveChild(workspace,directory))).sort().join(',')!==names.join(','))fail('migration.resume-drift');
 if(!exists&&(await inspectDirectory(resolveChild(workspace,directory))).exists)fail('migration.resume-drift');
 for(const path of [recoveryPath.replace(/recovery\.json$/,'installation.json'),'.pipeline/state.json'])
  if((await observeTargets(workspace,[path]))[0].bytes!==null)fail('migration.resume-drift');
 const after=await observeTargets(workspace,[...expected.keys()]);
 const fingerprints=items=>items.map(o=>({path:o.path,hash:o.bytes===null?null:sha256(o.bytes)}));
 if(contractDigest(fingerprints(after))!==contractDigest(fingerprints(rows)))fail('migration.resume-drift');
 const result={schemaVersion:1,kind:'legacy-unity-deactivation-resume-preview',workspace,recoveryPath,
  recoveryHash:recovery.digest,markerHash:marker.digest,events,observations:fingerprints(rows),classifications,conflicts,operations,
  status:conflicts.length?'blocked':'needs-approval',executable:false,runtime:'not-run'};
 return {...result,digest:contractDigest(result)};
}
