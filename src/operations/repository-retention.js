import path from 'node:path';
import {lstat,readdir,open} from 'node:fs/promises';
import {absoluteRoot,inspectDirectory,resolveChild} from '../workspace/paths.js';
import {fail,parse} from '../contracts/parse.js';
import {contractDigest} from '../contracts/semantic.js';
import {sha256} from '../source/inventory.js';
import {readRecord,readState} from './state.js';
import {readRepositoryJournal} from './repository-journal.js';
import {readRepositoryInputs} from './repository-inputs.js';
import {verifyRepositoryAuthorization} from './repository-authorization.js';
import {repositoryContentDigest} from './repository-apply.js';
import {listRepositoryHistory} from './repository-history.js';
import {planRetention} from './retention.js';
import {bootstrapLockDirectory} from './bootstrap-lock.js';
import {validateInventorySummary} from '../workspace/repository-observation.js';

function validEvidenceInventory(v) {
  if(v?.kind==='repository-inventory-summary'){validateInventorySummary(v);return true;}
  return Array.isArray(v?.entries) && v.digest===sha256(Buffer.from(JSON.stringify(v.entries)));
}

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const same=(a,b)=>contractDigest(a)===contractDigest(b);
const namespaces=['repository-journals','repository-evidence','repository-inputs','repository-authorizations','repository-completions'];
const idFor=relative=>{const m=/^\.pipeline\/(repository-journals|repository-evidence|repository-inputs|repository-authorizations|repository-completions)\/([a-f0-9-]{36})(?:\/|\.pending\.json$|\.json$|$)/.exec(relative);return m&&uuid.test(m[2])?m[2]:null;};

// Bounded reference scan includes arbitrary retained metadata, not only known
// recovery formats. Parsed strings catch JSON-escaped identifiers. No contents
// are returned. Runtime repositories/provider roots are outside this inventory.
export async function inspectRepositoryRetentionFiles(workspace) {
  workspace=absoluteRoot(workspace);await inspectDirectory(workspace);
  const files=[],directories=[];let count=0,total=0;
  const walk=async(filename,depth)=>{
    if(depth>32||++count>20000)fail('repository-retention.limit');
    const before=await lstat(filename);
    if(before.isSymbolicLink()||(!before.isFile()&&!before.isDirectory())||(before.isFile()&&before.nlink!==1))fail('repository-retention.type');
    if(before.isDirectory()) {
      await inspectDirectory(filename);
      directories.push({path:filename,dev:String(before.dev),ino:String(before.ino)});
      for(const name of (await readdir(filename)).sort()) {
        if(filename===path.join(workspace,'.pipeline')&&name==='lock')continue;
        await walk(path.join(filename,name),depth+1);
      }
      const after=await lstat(filename);
      if(after.dev!==before.dev||after.ino!==before.ino||after.mtimeMs!==before.mtimeMs)fail('repository-retention.drift');
      return;
    }
    total+=before.size;if(before.size>8*1024*1024||total>128*1024*1024)fail('repository-retention.limit');
    const handle=await open(filename,'r');let bytes;
    try {
      const opened=await handle.stat();if(!opened.isFile()||opened.nlink!==1||opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size)fail('repository-retention.drift');
      const buffer=Buffer.alloc(before.size+1);let length=0;
      while(length<buffer.length){const read=await handle.read(buffer,length,buffer.length-length,null);if(!read.bytesRead)break;length+=read.bytesRead;}
      bytes=buffer.subarray(0,length);
    }finally{await handle.close();}
    const after=await lstat(filename);
    if(after.dev!==before.dev||after.ino!==before.ino||after.mtimeMs!==before.mtimeMs||bytes.length!==before.size)fail('repository-retention.drift');
    let text=bytes.toString('utf8');if(filename.endsWith('.json'))text=JSON.stringify(parse(text,'json'));
    const references=[...new Set([
      ...(text.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi)??[]).map(s=>s.toLowerCase()),
      ...(text.match(/[a-f0-9]{64}/gi)??[]).map(s=>'sha256:'+s.toLowerCase())])].sort();
    files.push({path:filename,hash:sha256(bytes),bytes:bytes.length,mtimeMs:before.mtimeMs,dev:String(before.dev),ino:String(before.ino),references});
  };
  const metadata=path.join(workspace,'.pipeline');if((await inspectDirectory(metadata)).exists)await walk(metadata,0);
  const history=await listRepositoryHistory(workspace);
  if(!history.complete)fail('repository-retention.history-incomplete');
  for(const entry of history.entries)if(!entry.path.startsWith(metadata+path.sep))await walk(entry.path,0);
  files.sort((a,b)=>a.path.localeCompare(b.path));directories.sort((a,b)=>a.path.localeCompare(b.path));
  return {files,directories};
}

async function verifyHistoricalGroup(workspace,id,files) {
  const journal='.pipeline/repository-journals/'+id,base='.pipeline/repository-completions/'+id;
  const receipt=await readRecord(resolveChild(workspace,base+'.json')),r=receipt.value;
  const digest=r.reconciliation?.previewDigest,input=await readRepositoryInputs(workspace,journal,digest),preview=parse(input.previewText,'json');
  const history=await readRepositoryJournal(workspace,journal,preview);
  if(history.phase!=='terminal'||history.operations.some(o=>o.status!=='completed'))fail('repository-retention.incomplete');
  const pending=await readRecord(resolveChild(workspace,base+'.pending.json'));
  if(!same(pending.value,{schemaVersion:1,previewDigest:digest,journal,status:'requires-reconciliation'}))fail('repository-retention.marker');
  const bindings=await verifyRepositoryAuthorization(workspace,journal,preview,history.authorization),observations=[];
  const allowed=new Set([base+'.json',base+'.pending.json','.pipeline/repository-inputs/'+id+'.json',
    ...Array.from({length:history.sequence},(_,i)=>journal+'/'+String(i).padStart(6,'0')+'.json')]);
  if(history.authorization)allowed.add(history.authorization.path);
  for(let i=0;i<preview.operations.length;i++) {
    const op=preview.operations[i],relative='.pipeline/repository-evidence/'+id+'/'+String(i).padStart(6,'0')+'.json';
    allowed.add(relative);const record=await readRecord(resolveChild(workspace,relative)),e=record.value;
    if(Object.keys(e).sort().join(',')!=='action,contentDigest,inventory,previewDigest,repository,schemaVersion,sourceAbsent,target'||
      !validEvidenceInventory(e.inventory)||
      record.digest!==history.operations[i].evidenceDigest||e.schemaVersion!==1||e.previewDigest!==digest||e.repository!==op.repository||
      e.action!==op.action||e.target!==op.target||e.inventory?.root!==op.target||e.sourceAbsent!==(op.action==='move'?true:null)||
      e.contentDigest!==repositoryContentDigest(e.inventory))fail('repository-retention.evidence');
    bindings.push({path:relative,digest:record.digest});observations.push({repository:op.repository,claimedStatus:'completed',state:'completed-verified',targetDigest:e.inventory.digest,sourceDigest:null});
  }
  const body={kind:'repository-reconciliation',wrapper:workspace,previewDigest:digest,markerDigest:pending.digest,journal,
    journalHead:history.lastHash,evidenceBindings:bindings,observations,canFinalize:true,executionAuthorized:false};
  if(!same(r,{schemaVersion:1,status:'repository-effects-verified',reconciliation:{...body,digest:contractDigest(body)},pipelineActivated:false}))fail('repository-retention.completion');
  const actual=files.map(f=>path.relative(workspace,f.path).split(path.sep).join('/'));
  if(actual.length!==allowed.size||actual.some(p=>!allowed.has(p)))fail('repository-retention.foreign');
}

export async function scanRepositoryRetention(workspace,{policy,now,currentRuns=[]}) {
  workspace=absoluteRoot(workspace);planRetention({journals:[],policy,now});
  if(!Array.isArray(currentRuns)||currentRuns.some(id=>!uuid.test(id)))fail('repository-retention.current-runs');
  const diagnostics=[],groups=[];let inventory;
  try{inventory=await inspectRepositoryRetentionFiles(workspace);}catch(error){diagnostics.push({code:error.code??'repository-retention.io'});inventory={files:[],directories:[]};}
  try {
    const state=await readState(resolveChild(workspace,'.pipeline/state.json'));
    if(state.value.pending!==null)diagnostics.push({code:'repository-retention.configuration-pending'});
  }catch(error){if(error.code!=='record.missing')diagnostics.push({code:error.code??'repository-retention.state'});}
  const relative=f=>path.relative(workspace,f.path).split(path.sep).join('/');
  const ids=[...new Set([...inventory.files,...inventory.directories].map(f=>idFor(relative(f))).filter(Boolean))].sort();
  for(const id of ids) {
    const files=inventory.files.filter(f=>idFor(relative(f))===id),paths=inventory.directories.filter(d=>idFor(relative(d))===id).map(d=>d.path);
    const reasons=[];let status='completed';
    try {
      if(paths.length!==2||!['repository-journals','repository-evidence'].every(n=>paths.includes(path.join(workspace,'.pipeline',n,id))))fail('repository-retention.foreign');
      await verifyHistoricalGroup(workspace,id,files);
    }catch(error){status='unknown';reasons.push('inspection-failed');diagnostics.push({code:error.code??'repository-retention.invalid',subject:id});}
    if(currentRuns.includes(id))reasons.push('current-run');
    const subjects=new Set([id,...files.map(f=>f.hash)]);
    if(inventory.files.some(f=>idFor(relative(f))!==id&&f.references.some(ref=>subjects.has(ref))))reasons.push('retained-reference');
    groups.push({id,status,files,paths,bytes:files.reduce((n,f)=>n+f.bytes,0),completedAt:status==='completed'?Math.floor(Math.max(...files.map(f=>f.mtimeMs))):null,protectionReasons:reasons});
  }
  const marker=inventory.files.some(f=>relative(f)==='.pipeline/repository-operation.json');
  if(marker)diagnostics.push({code:'repository-retention.pending'});
  const bootstrap=bootstrapLockDirectory(workspace);
  if(inventory.directories.some(d=>[bootstrap,bootstrap+'.recovery',bootstrap+'.recovery-resume'].includes(d.path)))
    diagnostics.push({code:'repository-retention.recovery-pending'});
  for(const f of [...inventory.files,...inventory.directories]) {
    const p=relative(f);if(namespaces.some(n=>p.startsWith('.pipeline/'+n+'/'))&&!idFor(p))diagnostics.push({code:'repository-retention.foreign',subject:f.path});
  }
  if(diagnostics.length)for(const g of groups)g.protectionReasons=[...new Set([...g.protectionReasons,'inspection-failed'])];
  if(!diagnostics.length&&!same(inventory,await inspectRepositoryRetentionFiles(workspace)))fail('repository-retention.drift');
  const retention=planRetention({now,policy,journals:groups.map(({id,status,bytes,completedAt,protectionReasons})=>({id,status,bytes,completedAt,protectionReasons}))});
  const body={kind:'repository-retention-preview',workspace,currentRuns,groups,inventory,retention,diagnostics,complete:diagnostics.length===0,
    runtimeVerified:false,automaticActions:false};return {...body,digest:contractDigest(body)};
}
