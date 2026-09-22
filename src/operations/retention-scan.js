import {readdir,lstat} from 'node:fs/promises';
import {inspectHistory} from './history.js';
import {readState,readRecord} from './state.js';
import {planRetention} from './retention.js';
import {absoluteRoot,resolveChild,inspectDirectory} from '../workspace/paths.js';
import {contractDigest} from '../contracts/semantic.js';
import {fail} from '../contracts/parse.js';

const ref=/^\.pipeline\/(?:transactions|journals)\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:\/|$)/;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/;
function references(value,out=new Set()) {
  if(typeof value==='string') {const m=ref.exec(value);if(m)out.add(m[1]);}
  else if(value && typeof value==='object')for(const item of Object.values(value))references(item,out);
  return out;
}

// Conservative read-only scan. Completed is not synonymous with disposable.
// Referenced records remain protected even if the referring record is eligible.
export async function scanRetention(workspace,{policy,now,currentRuns=[]}) {
  workspace=absoluteRoot(workspace);
  if(!Array.isArray(currentRuns) || currentRuns.some(id=>typeof id!=='string' || !uuid.test(id)))fail('retention-scan.current-run');
  planRetention({journals:[],policy,now}); // validate policy before filesystem work
  const history=await inspectHistory(workspace),groups=[],referenced=new Set(),current=new Set(currentRuns),diagnostics=[...history.diagnostics];
  let state=null,unsafe=!history.complete || history.diagnostics.some(d=>d.code!=='history.unfinished'),count=0,total=0;
  try {state=await readState(resolveChild(workspace,'.pipeline/state.json'));for(const id of references(state.value))current.add(id);}
  catch(error){if(error.code!=='record.missing'){unsafe=true;diagnostics.push({code:error.code??'retention-scan.io',subject:'state'});}}
  if((history.entries.length && !state) || (state?.value.active && !state.value.activation) ||
      (state?.value.pending && !history.entries.some(e=>e.pendingDigest===state.value.pending)))unsafe=true;
  const inspectGroup=async item=>{
    const files=[];
    for(const directory of [item.journal,item.recovery?.slice(0,-'/recovery.json'.length)].filter(Boolean)) {
      await inspectDirectory(resolveChild(workspace,directory));
      const names=(await readdir(resolveChild(workspace,directory))).sort();
      if(names.length>10000 || count+names.length>10000)fail('retention-scan.limit');
      for(const name of names) {
        if(directory===item.journal?!/^\d{6}\.json(?![\s\S])/.test(name):name!=='recovery.json')fail('retention-scan.foreign');
        const relative=directory+'/'+name,filename=resolveChild(workspace,relative),info=await lstat(filename);
        if(!info.isFile() || info.isSymbolicLink() || info.nlink!==1)fail('retention-scan.type');
        count++;total+=info.size;if(total>64*1024*1024)fail('retention-scan.limit');
        const record=await readRecord(filename),after=await lstat(filename);
        if(info.size!==after.size || info.mtimeMs!==after.mtimeMs || info.ino!==after.ino || info.dev!==after.dev)fail('retention-scan.drift');
        files.push({path:relative,hash:record.digest,bytes:info.size,mtimeMs:info.mtimeMs});
        if(name==='recovery.json')for(const id of references(record.value))if(id!==item.id)referenced.add(id);
      }
    }
    return files;
  };
  for(const item of history.entries) {
    const group={id:item.id,status:item.status,journalPath:item.journal?resolveChild(workspace,item.journal):null,
      recoveryPath:item.recovery?resolveChild(workspace,item.recovery):null,
      paths:[item.journal,item.recovery?.slice(0,-'/recovery.json'.length)].filter(Boolean),files:[],protectionReasons:[]};
    try{group.files=await inspectGroup(item);}catch(error){unsafe=true;group.protectionReasons.push('inspection-failed');diagnostics.push({code:error.code??'retention-scan.io',subject:item.id});}
    if(['unknown','orphan'].includes(item.status))unsafe=true;
    if(state?.value.pending && item.pendingDigest===state.value.pending)current.add(item.id);
    groups.push(group);
  }
  for(const group of groups) {
    if(currentRuns.includes(group.id))group.protectionReasons.push('current-run');
    if(current.has(group.id))group.protectionReasons.push('current-state');
    if(referenced.has(group.id))group.protectionReasons.push('retained-reference');
    if(unsafe)group.protectionReasons.push('inspection-failed');
    group.protectionReasons=[...new Set(group.protectionReasons)].sort();
    group.bytes=group.files.reduce((n,f)=>n+f.bytes,0);
    // Local metadata age only; never used to select the active transaction.
    group.completedAt=group.status==='journal-completed' && group.files.length?Math.floor(Math.max(...group.files.map(f=>f.mtimeMs))):null;
  }
  const after=await inspectHistory(workspace);
  if(contractDigest(after)!==contractDigest(history))fail('retention-scan.drift');
  for(const group of groups)for(const file of group.files) {
    const filename=resolveChild(workspace,file.path),info=await lstat(filename);
    if(info.size!==file.bytes || info.mtimeMs!==file.mtimeMs || (await readRecord(filename)).digest!==file.hash)fail('retention-scan.drift');
  }
  for(const group of groups)if(!group.protectionReasons.includes('inspection-failed'))for(const directory of group.paths) {
    const expected=group.files.filter(f=>f.path.startsWith(directory+'/')).map(f=>f.path.slice(directory.length+1)).sort();
    if(JSON.stringify((await readdir(resolveChild(workspace,directory))).sort())!==JSON.stringify(expected))fail('retention-scan.drift');
  }
  let stateAfter=null;
  try{stateAfter=(await readState(resolveChild(workspace,'.pipeline/state.json'))).digest;}catch(error){if(error.code!=='record.missing')fail('retention-scan.drift');}
  if(stateAfter!==(state?.digest??null))fail('retention-scan.drift');
  const retention=planRetention({now,policy,journals:groups.map(g=>({id:g.id,
    status:g.status==='journal-completed'?'completed':['uncertain','orphan'].includes(g.status)?g.status:g.status==='open'?'pending':'unknown',
    completedAt:g.completedAt,bytes:g.bytes,protectionReasons:g.protectionReasons}))});
  const body={kind:'retention-filesystem-preview',workspace,stateFileHash:stateAfter,currentRuns:[...currentRuns],groups,retention,
    diagnostics,complete:history.complete && !unsafe,applySupported:false,automaticActions:false};
  return {...body,digest:contractDigest(body)};
}
