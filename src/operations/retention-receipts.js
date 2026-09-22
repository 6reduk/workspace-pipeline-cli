import {readdir,lstat} from 'node:fs/promises';
import {readRecord,readState} from './state.js';
import {inspectHistory} from './history.js';
import {absoluteRoot,resolveChild,inspectDirectory} from '../workspace/paths.js';
import {requestShape} from './ownership.js';
import {planRetention} from './retention.js';
import {planCombinedRetention} from './retention-combined.js';
import {contractDigest} from '../contracts/semantic.js';
import {fail} from '../contracts/parse.js';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/;
const hash=/^sha256:[a-f0-9]{64}(?![\s\S])/;
const integer=n=>Number.isSafeInteger(n)&&n>=0;
function equalSet(a,b) {
  return Array.isArray(a)&&Array.isArray(b)&&new Set(a).size===a.length&&
    new Set(b).size===b.length&&a.length===b.length&&a.every(x=>b.includes(x));
}
// Recognizes the currently produced journal-cleanup receipt only. Future receipt
// schemas remain protected until their own provenance rules are implemented.
export function completedCleanupReceipt(r,workspace,id) {
  requestShape(r,['schemaVersion','kind','runId','workspace','previewDigest','policy','status','recoverable',
    'groups','removedFiles','removedDirectories','completedGroups','currentFile','error','reclaimedBytes'],
    ['authorization','receiptUpdate'],'retention-receipts.shape');
  if(![1,2].includes(r.schemaVersion)||r.kind!=='retention-result'||r.runId!==id||!uuid.test(id)||r.workspace!==workspace||
      !hash.test(r.previewDigest)||r.recoverable!==false||!['completed','failed','in-progress'].includes(r.status))fail('retention-receipts.binding');
  const combined=r.schemaVersion===2;
  if(combined)planCombinedRetention({journals:[],receipts:[],policy:r.policy,now:0});
  else planRetention({journals:[],policy:r.policy,now:0});
  if(r.authorization!==undefined) {
    const automatic=r.authorization?.decision==='workspace-policy';
    requestShape(r.authorization,automatic?['decision','policyHash']:['decision','previewDigest'],[],'retention-receipts.authorization');
    if(automatic?!hash.test(r.authorization.policyHash):r.authorization.decision!=='approve'||r.authorization.previewDigest!==r.previewDigest)
      fail('retention-receipts.authorization');
  }
  // Incomplete known records are retained; no claim of successful deletion.
  if(r.status!=='completed')return false;
  if(r.error!==null||r.currentFile!==null||(r.receiptUpdate!==undefined&&r.receiptUpdate!=='saved')||
      !integer(r.reclaimedBytes)||!Array.isArray(r.groups))fail('retention-receipts.completion');
  if(r.groups.length>r.policy.maxDeletesPerRun)fail('retention-receipts.completion');
  const ids=[],files=[],directories=[];let bytes=0;
  for(const group of r.groups) {
    requestShape(group,combined?['id','type','paths','files']:['id','paths','files'],[],'retention-receipts.group');
    const receiptGroup=combined&&group.type==='cleanup-receipt';
    if(combined&&!['journal','cleanup-receipt'].includes(group.type))fail('retention-receipts.group');
    if(!uuid.test(group.id)||!equalSet(group.paths,receiptGroup?[]:['.pipeline/journals/'+group.id,'.pipeline/transactions/'+group.id])||!Array.isArray(group.files))
      fail('retention-receipts.group');
    if(receiptGroup&&(group.id===r.runId||group.files.length!==1))fail('retention-receipts.group');
    ids.push(combined?group.type+':'+group.id:group.id);directories.push(...group.paths);let recovery=0,events=0;
    for(const file of group.files) {
      requestShape(file,['path','hash','bytes','mtimeMs'],[],'retention-receipts.file');
      if(typeof file.path!=='string'||!hash.test(file.hash)||!integer(file.bytes)||!Number.isFinite(file.mtimeMs)||file.mtimeMs<0)
        fail('retention-receipts.file');
      if(receiptGroup) {
        if(file.path!=='.pipeline/cleanup/'+group.id+'.json')fail('retention-receipts.file');
      }else if(file.path==='.pipeline/transactions/'+group.id+'/recovery.json')recovery++;
      else if(file.path.startsWith('.pipeline/journals/'+group.id+'/')&&/^\d{6}\.json(?![\s\S])/.test(file.path.slice(('.pipeline/journals/'+group.id+'/').length)))events++;
      else fail('retention-receipts.file');
      files.push(file.path);bytes+=file.bytes;if(!integer(bytes))fail('retention-receipts.bytes');
    }
    if(!receiptGroup&&(recovery!==1||events<1))fail('retention-receipts.group');
  }
  if(!equalSet(ids,r.completedGroups)||!equalSet(files,r.removedFiles)||!equalSet(directories,r.removedDirectories)||bytes!==r.reclaimedBytes)
    fail('retention-receipts.completion');
  return true;
}

function references(value,out) {
  if(typeof value==='string') {
    for(const m of value.replaceAll('\\','/').matchAll(/\.pipeline\/cleanup\/([a-f0-9-]{36})\.json/g))if(uuid.test(m[1]))out.add(m[1]);
  }else if(value&&typeof value==='object')for(const part of Object.values(value))references(part,out);
}

export async function scanCleanupReceipts(workspace,{currentRuns=[]}={}) {
  workspace=absoluteRoot(workspace);
  if(!Array.isArray(currentRuns)||currentRuns.some(id=>typeof id!=='string'||!uuid.test(id)))fail('retention-receipts.current-run');
  const directory=resolveChild(workspace,'.pipeline/cleanup'),records=[],diagnostics=[],bindings=[],referenced=new Set();
  const history=await inspectHistory(workspace);let complete=history.complete&&history.diagnostics.length===0,total=0,stateHash=null;
  try {
    const state=await readState(resolveChild(workspace,'.pipeline/state.json'));
    stateHash=state.digest;
    bindings.push({path:'.pipeline/state.json',hash:state.digest});references(state.value,referenced);
  }catch(e){if(e.code!=='record.missing'){complete=false;diagnostics.push({code:e.code??'retention-receipts.io',subject:'state'});}}
  if(stateHash===null&&history.entries.length)complete=false;
  for(const entry of history.entries)if(entry.recovery) {
    try{const r=await readRecord(resolveChild(workspace,entry.recovery));bindings.push({path:entry.recovery,hash:r.digest});references(r.value,referenced);}
    catch(e){complete=false;diagnostics.push({code:e.code??'retention-receipts.io',subject:entry.id});}
  }
  const names=(await inspectDirectory(directory)).exists?(await readdir(directory)).sort():[];
  if(names.length>1000)fail('retention-receipts.limit');
  for(const name of names) {
    if(!name.endsWith('.json')||!uuid.test(name.slice(0,-5))){complete=false;diagnostics.push({code:'retention-receipts.foreign',subject:'.pipeline/cleanup'});continue;}
    const id=name.slice(0,-5),relative='.pipeline/cleanup/'+name,filename=resolveChild(workspace,relative);
    const item={id,path:relative,status:'unknown',completedAt:null,bytes:0,hash:null,mtimeMs:null,protectionReasons:[]};
    try {
      const before=await lstat(filename);total+=before.size;if(total>64*1024*1024)fail('retention-receipts.limit');
      if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1)fail('retention-receipts.type');
      const r=await readRecord(filename),after=await lstat(filename);
      if(before.ino!==after.ino||before.dev!==after.dev||before.size!==after.size||before.mtimeMs!==after.mtimeMs)fail('retention-receipts.drift');
      item.bytes=before.size;item.hash=r.digest;item.mtimeMs=before.mtimeMs;
      item.status=completedCleanupReceipt(r.value,workspace,id)?'completed':'uncertain';
      if(item.status==='completed')item.completedAt=Math.floor(before.mtimeMs);
    }catch(e){complete=false;diagnostics.push({code:e.code??'retention-receipts.io',subject:id});item.protectionReasons.push('inspection-failed');}
    if(currentRuns.includes(id))item.protectionReasons.push('current-run');
    if(referenced.has(id))item.protectionReasons.push('retained-reference');
    records.push(item);
  }
  // Repeat identities: this is a preview, not a lock or deletion permission.
  for(const binding of [...bindings,...records.filter(r=>r.hash!==null)]) {
    if((await readRecord(resolveChild(workspace,binding.path))).digest!==binding.hash)fail('retention-receipts.drift');
    if(binding.mtimeMs!==undefined) {
      const info=await lstat(resolveChild(workspace,binding.path));
      if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size!==binding.bytes||info.mtimeMs!==binding.mtimeMs)fail('retention-receipts.drift');
    }
  }
  let stateAfter=null;
  try{stateAfter=(await readState(resolveChild(workspace,'.pipeline/state.json'))).digest;}
  catch(e){if(e.code!=='record.missing'&&(stateHash!==null||complete))fail('retention-receipts.drift');}
  if(stateAfter!==stateHash)fail('retention-receipts.drift');
  if(contractDigest(await inspectHistory(workspace))!==contractDigest(history))fail('retention-receipts.drift');
  const afterNames=(await inspectDirectory(directory)).exists?(await readdir(directory)).sort():[];
  if(!equalSet(names,afterNames))fail('retention-receipts.drift');
  if(!complete)for(const r of records)if(!r.protectionReasons.includes('inspection-failed'))r.protectionReasons.push('inspection-failed');
  const body={kind:'cleanup-receipts-inventory',workspace,records,bindings,diagnostics,complete,
    requiresLockedRecheck:true,automaticActions:false};
  return {...body,digest:contractDigest(body)};
}
