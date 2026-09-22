import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {lstat,mkdir,open,opendir,rename} from 'node:fs/promises';
import {absoluteRoot,inspectDirectory,pathBudget} from '../workspace/paths.js';
import {fail,parse} from '../contracts/parse.js';
import {contractDigest} from '../contracts/semantic.js';
import {readRecord} from './state.js';
import {withRecoveryLease,assertRecoveryLeaseHeld} from './recovery-lease.js';

const MAX_DEPTH=32,MAX_APPROVALS=64, id=s=>({dev:String(s.dev),ino:String(s.ino)});
const same=(a,b)=>contractDigest(a)===contractDigest(b);
async function directoryId(p){if(!(await inspectDirectory(p)).exists)fail('ancestors.missing');return id(await lstat(p,{bigint:true}));}
async function names(p,limit=4){const values=[];for await(const entry of await opendir(p)){if(values.length>=limit)fail('ancestors.entries');values.push(entry.name);}return values.sort();}
async function absent(p){try{await lstat(p);}catch(e){if(e.code==='ENOENT')return;throw e;}fail('ancestors.destination-exists');}
async function persist(file,value){const h=await open(file,'wx',0o600);try{await h.writeFile(JSON.stringify(value)+'\n');await h.sync();}finally{await h.close();}if(!same((await readRecord(file)).value,value))fail('ancestors.readback');}
function validate(p){
  if(!p || p.schemaVersion!==1 || p.kind!=='repository-parent-preview' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(p.attemptId) ||
    !Array.isArray(p.targets) || !p.targets.length || p.targets.length>MAX_DEPTH)fail('ancestors.preview');
  const wrapper=absoluteRoot(p.wrapper),anchor=absoluteRoot(p.anchor),history=path.join(anchor,'.wpc-ancestors-'+p.attemptId);
  const keys=['anchor','anchorIdentity','attemptId','history','kind','schemaVersion','targets','wrapper'];
  if(!same(Object.keys(p).sort(),keys) || p.wrapper!==wrapper || p.anchor!==anchor || p.history!==history || !same(Object.keys(p.anchorIdentity??{}).sort(),['dev','ino']) ||
    !Object.values(p.anchorIdentity).every(v=>typeof v==='string' && /^\d+$/.test(v)))fail('ancestors.preview');
  let previous=anchor;
  for(const target of p.targets){
    if(absoluteRoot(target)!==target || path.dirname(target)!==previous || target===previous)fail('ancestors.preview');
    pathBudget(target);previous=target;
  }
  if(previous!==path.dirname(wrapper) || path.dirname(wrapper)===wrapper || p.targets[0].toLowerCase()===history.toLowerCase())fail('ancestors.preview');
  pathBudget(wrapper);pathBudget(history);pathBudget(path.join(history,'projection.json'));
  pathBudget(path.join(history,'tree',...p.targets.slice(1).map(t=>path.basename(t))));
  return p;
}
function input(value){return validate(typeof value==='string'?parse(value,'json'):structuredClone(value));}
async function anchor(p){if(!same(await directoryId(p.anchor),p.anchorIdentity))fail('ancestors.anchor-drift');}
function staged(p,index){return path.join(p.history,'tree',...p.targets.slice(1,index+1).map(t=>path.basename(t)));}

export async function prepareRepositoryAncestors(wrapper){
  wrapper=absoluteRoot(wrapper);pathBudget(wrapper);await inspectDirectory(wrapper);
  let current=path.dirname(wrapper),targets=[];
  while(!(await inspectDirectory(current)).exists){
    targets.unshift(current);if(targets.length>MAX_DEPTH)fail('ancestors.depth');current=path.dirname(current);
  }
  if(!targets.length)fail('ancestors.parent-present');
  const attemptId=randomUUID();
  return validate({schemaVersion:1,kind:'repository-parent-preview',wrapper,anchor:current,
    anchorIdentity:await directoryId(current),attemptId,history:path.join(current,'.wpc-ancestors-'+attemptId),targets});
}

async function projection(p){
  const r=await readRecord(path.join(p.history,'projection.json')),v=r.value;
  if(!same(Object.keys(v).sort(),['directories','previewDigest','schemaVersion']) || v.schemaVersion!==1 ||
    v.previewDigest!==contractDigest(p) || !Array.isArray(v.directories) || v.directories.length!==p.targets.length)fail('ancestors.projection');
  for(let i=0;i<v.directories.length;i++){
    const d=v.directories[i];if(!same(Object.keys(d).sort(),['identity','target']) || d.target!==p.targets[i] ||
      !same(Object.keys(d.identity??{}).sort(),['dev','ino']) || !Object.values(d.identity).every(x=>typeof x==='string' && /^\d+$/.test(x)))fail('ancestors.projection');
  }
  return r;
}
async function checkTree(p,v,applied){
  for(let i=0;i<p.targets.length;i++){
    const dir=applied?p.targets[i]:staged(p,i);
    if(!same(await directoryId(dir),v.directories[i].identity))fail('ancestors.directory-drift');
    const expected=i+1<p.targets.length?[path.basename(p.targets[i+1])]:[];
    if(!same(await names(dir),expected))fail('ancestors.foreign-entry');
  }
}
function receipt(p,v){return {schemaVersion:1,previewDigest:contractDigest(p),projectionDigest:contractDigest(v),
  status:'parent-directories-created',wrapper:p.wrapper,targets:p.targets,repositoryEffectsPerformed:false,pipelineActivated:false};}
async function observe(p){
  await anchor(p);const historyIdentity=await directoryId(p.history);
  const request=await readRecord(path.join(p.history,'request.json'));
  if(!same(request.value,p))fail('ancestors.request-drift');
  const record=await projection(p);
  const hasStage=(await inspectDirectory(staged(p,0))).exists,hasTarget=(await inspectDirectory(p.targets[0])).exists;
  if(hasStage===hasTarget)fail('ancestors.location');
  await checkTree(p,record.value,hasTarget);
  const entries=await names(p.history,MAX_APPROVALS+4),base=['projection.json','request.json',...(hasStage?['tree']:[])].sort();
  const resultFile=path.join(p.history,'receipt.json');let result=null;
  if(entries.includes('receipt.json')){result=await readRecord(resultFile);if(hasStage || !same(result.value,receipt(p,record.value)))fail('ancestors.receipt');base.push('receipt.json');base.sort();}
  const stable={schemaVersion:1,previewDigest:contractDigest(p),historyIdentity,requestDigest:request.digest,projectionDigest:record.digest};
  const continuationApprovals=[];
  const approvals=entries.filter(n=>/^authorization-\d{4}\.json$/.test(n));
  if(approvals.length>MAX_APPROVALS)fail('ancestors.approval-limit');
  for(let i=0;i<approvals.length;i++){
    const name='authorization-'+String(i+1).padStart(4,'0')+'.json';if(approvals[i]!==name)fail('ancestors.approval-chain');
    const saved=await readRecord(path.join(p.history,name)),a=saved.value,{digest,...body}=a.observation??{};
    if(!same(Object.keys(a).sort(),['decision','observation','schemaVersion','sequence']) || a.schemaVersion!==1 ||
      a.decision!=='approve-remaining-parent-actions' || a.sequence!==i+1 || contractDigest(body)!==digest ||
      !same(Object.keys(body).sort(),[...Object.keys(stable),'status','receiptDigest','continuationApprovals'].sort()) ||
      !same(Object.fromEntries(Object.keys(stable).map(k=>[k,body[k]])),stable) ||
      !['staged','applied-receipt-missing'].includes(body.status) || body.receiptDigest!==null ||
      !same(body.continuationApprovals,continuationApprovals))fail('ancestors.approval-chain');
    continuationApprovals.push({name,digest:saved.digest});base.push(name);
  }
  if(!same(entries,base.sort()))fail('ancestors.history-entry');
  const value={...stable,status:result?'completed':hasTarget?'applied-receipt-missing':'staged',receiptDigest:result?.digest??null,continuationApprovals};
  return {...value,digest:contractDigest(value)};
}
export async function inspectRepositoryAncestors(preview){const p=input(preview),a=await observe(p),b=await observe(p);if(!same(a,b))fail('ancestors.drift');return b;}

async function finish(p,initial,lease,ioBoundary){
  async function check(){assertRecoveryLeaseHeld(lease);const next=await inspectRepositoryAncestors(p);if(!same(next,initial))fail('ancestors.drift');}
  if(initial.status==='completed')return {status:'parent-directories-created',history:p.history,requiresRepositoryPreview:true,repositoryEffectsPerformed:false,pipelineActivated:false};
  await check();
  if(initial.status==='staged'){
    await absent(p.targets[0]);await rename(staged(p,0),p.targets[0]);
    await ioBoundary('ancestors-published',{history:p.history});
    const next=await inspectRepositoryAncestors(p);
    if(next.status!=='applied-receipt-missing' || !same(next.historyIdentity,initial.historyIdentity) ||
      next.requestDigest!==initial.requestDigest || next.projectionDigest!==initial.projectionDigest)fail('ancestors.drift');
    initial=next;
  }
  await check();const v=(await projection(p)).value;await persist(path.join(p.history,'receipt.json'),receipt(p,v));
  await ioBoundary('ancestors-receipt-persisted',{history:p.history});
  const final=await inspectRepositoryAncestors(p);if(final.status!=='completed' || !same(final.historyIdentity,initial.historyIdentity) ||
    final.requestDigest!==initial.requestDigest || final.projectionDigest!==initial.projectionDigest)fail('ancestors.readback');
  return {status:'parent-directories-created',history:p.history,requiresRepositoryPreview:true,repositoryEffectsPerformed:false,pipelineActivated:false};
}
export async function applyRepositoryAncestors(preview,{ioBoundary=async()=>{}}={}){
  const p=input(preview);
  return withRecoveryLease(p.targets[0],async lease=>{
    await anchor(p);await absent(p.targets[0]);await absent(p.history);
    await mkdir(p.history,{mode:0o700});const historyId=await directoryId(p.history);
    async function checkHistory(){assertRecoveryLeaseHeld(lease);await anchor(p);await absent(p.targets[0]);if(!same(await directoryId(p.history),historyId))fail('ancestors.history-drift');}
    await ioBoundary('ancestors-history-created',{history:p.history});await checkHistory();
    await persist(path.join(p.history,'request.json'),p);
    await ioBoundary('ancestors-request-retained',{history:p.history});
    const directories=[];
    for(let i=0;i<p.targets.length;i++){
      await checkHistory();if(!same((await readRecord(path.join(p.history,'request.json'))).value,p))fail('ancestors.request-drift');
      await mkdir(staged(p,i),{mode:0o700});directories.push({target:p.targets[i],identity:await directoryId(staged(p,i))});
      await ioBoundary('ancestors-staged-directory',{history:p.history,index:i});
    }
    const planned={schemaVersion:1,previewDigest:contractDigest(p),directories};
    await checkHistory();await persist(path.join(p.history,'projection.json'),planned);
    await ioBoundary('ancestors-projection-retained',{history:p.history});
    await checkHistory();if(!same((await projection(p)).value,planned))fail('ancestors.projection-drift');
    return finish(p,await inspectRepositoryAncestors(p),lease,ioBoundary);
  });
}
export async function finishRepositoryAncestors(preview,observationDigest,{ioBoundary=async()=>{}}={}){
  const p=input(preview);return withRecoveryLease(p.targets[0],async lease=>{
    const current=await inspectRepositoryAncestors(p);if(current.digest!==observationDigest)fail('ancestors.approval-drift');
    if(current.status==='completed')return finish(p,current,lease,ioBoundary);
    const sequence=current.continuationApprovals.length+1;if(sequence>MAX_APPROVALS)fail('ancestors.approval-limit');
    assertRecoveryLeaseHeld(lease);
    if(!same(await inspectRepositoryAncestors(p),current))fail('ancestors.drift');
    const name='authorization-'+String(sequence).padStart(4,'0')+'.json';
    const authorization={schemaVersion:1,sequence,decision:'approve-remaining-parent-actions',observation:current};
    await persist(path.join(p.history,name),authorization);
    await ioBoundary('ancestors-continuation-authorized',{history:p.history,sequence});
    if(!same((await readRecord(path.join(p.history,name))).value,authorization))fail('ancestors.approval-drift');
    const next=await inspectRepositoryAncestors(p),{digest:unused,...withoutDigest}=next;
    if(!same({...withoutDigest,continuationApprovals:current.continuationApprovals},(({digest,...v})=>v)(current)) ||
      next.continuationApprovals.length!==sequence)fail('ancestors.drift');
    return finish(p,next,lease,ioBoundary);
  });
}
