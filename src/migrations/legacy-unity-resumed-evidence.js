import {readdir} from 'node:fs/promises';
import {resolveChild,inspectDirectory} from '../workspace/paths.js';
import {readRecord} from '../operations/state.js';
import {contractDigest} from '../contracts/semantic.js';
import {fail} from '../contracts/parse.js';
import {validateLegacyUnityDeactivation} from './legacy-unity.js';

// One explicit completed attempt; never choose newest among competing histories.
export async function verifyLegacyUnityResumedEvidence(workspace,recoveryPath,recoveryHash,original){
 const root=recoveryPath.replace(/recovery\.json$/,'deactivation-resumes');
 if(!(await inspectDirectory(resolveChild(workspace,root))).exists)return null;
 const attempts=await readdir(resolveChild(workspace,root));
 if(attempts.length!==1||! /^[a-f0-9]{64}$/.test(attempts[0]))fail('migration.resume-selection');
 const directory=root+'/'+attempts[0];await inspectDirectory(resolveChild(workspace,directory));
 const names=(await readdir(resolveChild(workspace,directory))).sort();
 if(names.join(',')!=='000000.json,000001.json,000002.json,000003.json,000004.json,000005.json')fail('migration.resume-incomplete');
 const records=[];for(const name of names)records.push(await readRecord(resolveChild(workspace,directory+'/'+name)));
 const authorization=records[0].value.detail,p=authorization?.preview;
 if(!p||p.kind!=='legacy-unity-deactivation-resume-preview'||p.workspace!==workspace||p.recoveryPath!==recoveryPath||
  p.recoveryHash!==recoveryHash||p.status!=='needs-approval'||p.conflicts?.length!==0||p.digest!=='sha256:'+attempts[0])fail('migration.resume-binding');
 const {digest,...body}=p;
 if(contractDigest(body)!==digest||contractDigest(authorization.approval)!==contractDigest({decision:'approve',previewDigest:digest}))fail('migration.resume-binding');
 const marker=await readRecord(resolveChild(workspace,'.pipeline/migration-operation.json'));
 if(marker.digest!==p.markerHash||contractDigest(marker.value)!==contractDigest({schemaVersion:1,kind:'legacy-unity-pending',
  workspace,recoveryPath,recoveryHash,previewDigest:original.digest}))fail('migration.marker-binding');
 const phase=validateLegacyUnityDeactivation(original.preflight.deactivation);
 const expectedObservations=new Map(original.initialObservations.map(o=>[o.path,o.hash]));
 for(const o of original.preflight.observations){
  if(expectedObservations.has(o.path)&&expectedObservations.get(o.path)!==o.sha256)fail('migration.observation-binding');
  expectedObservations.set(o.path,o.sha256);
 }
 if(!Array.isArray(p.observations)||p.observations.length!==expectedObservations.size||new Set(p.observations.map(o=>o.path)).size!==p.observations.length)fail('migration.resume-binding');
 for(const o of p.observations){
  const target=phase.targets.find(t=>t.path===o.path);
  if(!expectedObservations.has(o.path)||(!target&&o.hash!==expectedObservations.get(o.path))||
   (target&&o.hash!==target.beforeHash&&o.hash!==target.afterHash))fail('migration.resume-binding');
 }
 const oldDirectory=recoveryPath.replace(/recovery\.json$/,'deactivation');
 const oldNames=(await inspectDirectory(resolveChild(workspace,oldDirectory))).exists?(await readdir(resolveChild(workspace,oldDirectory))).sort():[];
 if(!Array.isArray(p.events)||oldNames.length!==p.events.length||oldNames.length>6)fail('migration.phase-evidence');
 let previous=null,stopped=false;const intents=new Set(),completed=new Set();
 for(let seq=0;seq<oldNames.length;seq++){
  const name=String(seq).padStart(6,'0')+'.json',relative=oldDirectory+'/'+name;
  if(stopped||oldNames[seq]!==name||p.events[seq].path!==relative)fail('migration.phase-evidence');
  const record=await readRecord(resolveChild(workspace,relative));let expected;
  if(record.digest!==p.events[seq].hash)fail('migration.phase-evidence');
  if(seq===0)expected={kind:'start',detail:null};
  else if(seq===5)expected={kind:'phase-checked',detail:{phase:'deactivate-legacy'}};
  else{
   const t=phase.targets[Math.floor((seq-1)/2)];
   if(seq%2){expected={kind:'intent',detail:{path:t.path,beforeHash:t.beforeHash,afterHash:t.afterHash}};intents.add(t.path);}
   else{
    const d=record.value.detail;
    if(!d||!['completed','failed','uncertain'].includes(d.status)||!(d.observedHash===null||/^sha256:[a-f0-9]{64}$/.test(d.observedHash))||
     d.status==='completed'&&d.observedHash!==t.afterHash||d.status==='failed'&&d.observedHash!==t.beforeHash)fail('migration.phase-evidence');
    stopped=d.status!=='completed';if(!stopped)completed.add(t.path);
    expected={kind:'outcome',detail:{path:t.path,status:d.status,observedHash:d.observedHash}};
   }
  }
  if(contractDigest(record.value)!==contractDigest({schemaVersion:1,seq,previous,recoveryHash,...expected}))fail('migration.phase-evidence');
  previous=record.digest;
 }
 const operations=phase.targets.map(t=>{
  const hash=p.observations.find(o=>o.path===t.path).hash;
  const state=hash===t.beforeHash?(t.beforeHash===t.afterHash?'unchanged-disabled':'before'):'after';
  if(state==='after'&&!intents.has(t.path)||state==='before'&&completed.has(t.path))fail('migration.resume-binding');
  return {path:t.path,action:state==='before'?'write-disabled':'confirm-observed',state,beforeHash:hash,afterHash:t.afterHash};
 });
 if(contractDigest(p.operations)!==contractDigest(operations))fail('migration.resume-binding');
 const classifications=operations.map(o=>({provider:phase.targets.find(t=>t.path===o.path).provider,path:o.path,state:o.state}));
 if(contractDigest(p.classifications)!==contractDigest(classifications))fail('migration.resume-binding');
 const expected=[{kind:'authorization',detail:authorization}];
 for(const o of operations)expected.push({kind:'intent',detail:o},{kind:'outcome',detail:{path:o.path,
  status:o.action==='write-disabled'?'written':'confirmed-observed',observedHash:o.afterHash}});
 expected.push({kind:'phase-observed',detail:{phase:'deactivate-legacy',recoveryHash}});
 previous=null;
 for(let seq=0;seq<records.length;seq++){
  if(contractDigest(records[seq].value)!==contractDigest({schemaVersion:1,seq,previous,...expected[seq]}))fail('migration.resume-evidence');
  previous=records[seq].digest;
 }
 for(let i=0;i<names.length;i++)if((await readRecord(resolveChild(workspace,directory+'/'+names[i]))).digest!==records[i].digest)fail('migration.journal-drift');
 if((await readdir(resolveChild(workspace,root))).sort().join(',')!==attempts.sort().join(',')||
  (await readdir(resolveChild(workspace,directory))).sort().join(',')!==names.join(','))fail('migration.journal-drift');
 for(const e of p.events)if((await readRecord(resolveChild(workspace,e.path))).digest!==e.hash)fail('migration.journal-drift');
 const oldFinal=(await inspectDirectory(resolveChild(workspace,oldDirectory))).exists?(await readdir(resolveChild(workspace,oldDirectory))).sort():[];
 if(oldFinal.join(',')!==oldNames.join(','))fail('migration.journal-drift');
 return {directory,head:previous};
}
