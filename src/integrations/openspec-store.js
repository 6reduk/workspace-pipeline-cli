import path from 'node:path';
import {readFile,lstat,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {parseDocument,isMap,isScalar} from 'yaml';
import {parse,fail,ContractError,MAX_INPUT_BYTES} from '../contracts/parse.js';
import {inspectDirectory,resolveChild} from '../workspace/paths.js';
import {assertLockHeld} from '../operations/lock.js';

const hash=b=>b===null?null:'sha256:'+createHash('sha256').update(b).digest('hex');
const prefix=root=>root==='.'?'':root+'/';
const overlap=(a,b)=>a==='.'||b==='.'||a===b||a.startsWith(b+'/')||b.startsWith(a+'/');
const idPattern=/^[a-z][a-z0-9-]{0,62}(?![\s\S])/;
export const storeRegistry='.pipeline/openspec/data/openspec/stores/registry.yaml';
export function compileStore(spec,binding,root,files=[]){
  if(!spec)return undefined;
  if(typeof spec.id!=='string'||!idPattern.test(spec.id)||!Array.isArray(spec.implementationRepositories)||!spec.implementationRepositories.length||spec.implementationRepositories.length>256||
    new Set(spec.implementationRepositories).size!==spec.implementationRepositories.length)fail('openspec.store-binding');
  const repos=binding?.layout?.repositories,docs=binding?.layout?.documentation?.repository;
  if(!repos||repos[docs]?.path!==root||repos[docs]?.role!=='documentation')fail('openspec.store-binding');
  const bindings=spec.implementationRepositories.slice().sort().map(repository=>{
    const repo=repos[repository];
    if(!idPattern.test(repository)||!repo||!['code','library'].includes(repo.role)||repository===docs)fail('openspec.store-binding');
    return {repository,root:repo.path,path:prefix(repo.path)+'openspec/config.yaml'};
  });
  const roots=[root,...bindings.map(b=>b.root)];
  for(let i=0;i<roots.length;i++)for(let j=0;j<i;j++)if(overlap(roots[i].toLowerCase(),roots[j].toLowerCase()))fail('openspec.store-binding');
  for(const f of files)if(roots.some(r=>overlap((prefix(r)+'openspec').toLowerCase(),f.target.toLowerCase())||overlap((prefix(r)+'.openspec-store').toLowerCase(),f.target.toLowerCase())))fail('openspec.owner-overlap');
  return {id:spec.id,implementationRepositories:bindings.map(b=>b.repository),bindings,identityPath:prefix(root)+'.openspec-store/store.yaml'};
}
function diagnostic(error,subject,repository){
  if(error instanceof ContractError){error.subject=subject;if(repository)error.repository=repository;
    error.hint='Inspect the named repository and path. Resolve unsafe links, invalid YAML or conflicting store identity explicitly, preserving project data; then repeat the same operation. Do not delete ownership records.';}
  return error;
}
export async function storeFile(root,relative,repository){
  try{return await readStoreFile(root,relative);}catch(error){throw diagnostic(error,relative,repository);}
}
async function readStoreFile(root,relative){
  const target=resolveChild(root,relative);await inspectDirectory(path.dirname(target));
  try{const s=await lstat(target);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>MAX_INPUT_BYTES)fail('openspec.store-config-conflict');}
  catch(e){if(e.code==='ENOENT')return null;throw e;}
  return readFile(target);
}
function yaml(bytes){
  const text=bytes?.toString('utf8')??'';
  if(bytes&&!Buffer.from(text).equals(bytes))fail('openspec.store-config-conflict');
  const body=text.replace(/^\uFEFF/,'');
  if(!body.trim()||body.split(/\r?\n/).every(l=>!l.trim()||l.trim().startsWith('#')))return {text,body,value:{},doc:null,offset:text.length-body.length};
  let value;try{value=parse(body);}catch{fail('openspec.store-config-conflict');}
  if(!value||Array.isArray(value)||typeof value!=='object')fail('openspec.store-config-conflict');
  const doc=parseDocument(body,{keepSourceTokens:true});
  if(!isMap(doc.contents))fail('openspec.store-config-conflict');
  const pair=doc.contents.items.find(p=>p.key?.value==='store');
  if(pair&&(!isScalar(pair.value)||typeof pair.value.value!=='string'))fail('openspec.store-config-conflict');
  return {text,body,value,doc,pair,offset:text.length-body.length};
}
function configYaml(bytes,subject,repository){try{return yaml(bytes);}catch(error){throw diagnostic(error,subject,repository);}}
// Replace only the scalar, or remove only its pair; unrelated bytes are retained.
export function editStoreKey(bytes,value){
  if(bytes===null&&value===null)return null;
  const p=yaml(bytes),newline=p.text.includes('\r\n')?'\r\n':'\n';let text=p.text;
  if(p.pair){
    const start=p.pair.value.range[0]+p.offset,end=p.pair.value.range[1]+p.offset;
    if(value!==null){const ending=text.slice(start,end).match(/\r?\n$/)?.[0]??'';text=text.slice(0,start)+value+ending+text.slice(end);}
    else if(p.doc.contents.flow){
      let a=p.pair.key.range[0]+p.offset,b=end;
      const next=text.slice(b).match(/^\s*,\s*/);
      if(next)b+=next[0].length;
      else {const prev=text.slice(0,a).match(/,\s*$/);if(prev)a-=prev[0].length;}
      text=text.slice(0,a)+text.slice(b);
    }else{
      const key=p.pair.key.range[0]+p.offset;
      const line=Math.max(p.offset,text.lastIndexOf('\n',key-1)+1);
      let endLine=end;
      if(text[end-1]!=='\n'){endLine=text.indexOf('\n',end);if(endLine<0)endLine=text.length;else endLine++;}
      const suffix=text.slice(end,endLine),comment=suffix.indexOf('#');
      text=text.slice(0,line)+(comment>=0?suffix.slice(comment):'')+text.slice(endLine);
    }
  }else if(value!==null){
    if(p.doc?.contents.flow){const at=p.doc.contents.range[1]-1+p.offset;text=text.slice(0,at)+(p.doc.contents.items.length?', ':'')+'store: '+value+text.slice(at);}
    else {const match=/(?:^|\n)\.\.\.(?:\r?\n|$)/.exec(text);const at=match?match.index+(text[match.index]==='\n'?1:0):text.length;
      text=text.slice(0,at)+(at>p.offset&&text[at-1]!=='\n'?newline:'')+'store: '+value+newline+text.slice(at);}
  }
  const result=Buffer.from(text),check=yaml(result);
  if(value===null?Object.hasOwn(check.value,'store'):check.value.store!==value)fail('openspec.store-config-conflict');
  return result;
}
async function noLocalRoot(root,b){
  if(!(await inspectDirectory(resolveChild(root,b.root))).exists)fail('openspec.project-missing');
  for(const name of ['openspec/specs','openspec/changes','.openspec-store']){
    const target=resolveChild(root,prefix(b.root)+name);await inspectDirectory(path.dirname(target));
    try{await lstat(target);fail('openspec.store-local-root');}catch(e){if(e.code!=='ENOENT'){e.subject=prefix(b.root)+name;throw e;}}
  }
}
function validateBindings(record,plans){
  const bindings=record?.storeBindings??[];
  if(!Array.isArray(bindings)||bindings.length>512)fail('openspec.record');
  const seen=new Set();
  for(const b of bindings){
    if(!b||seen.has(b.repository)||b.key!=='store'||!['owned','borrowed'].includes(b.ownership)||!idPattern.test(b.value))fail('openspec.record');
    seen.add(b.repository);
    const allowed=plans.flatMap(p=>(p?.store?.bindings??[]).map(e=>({...e,id:p.store.id}))).find(e=>e.repository===b.repository&&e.path===b.path);
    if(!allowed)fail('openspec.store-ownership-missing');
    if(b.value!==allowed.id)fail('openspec.record');
    if(record.status==='pending'&&(!['set','remove','preserve'].includes(b.action)||
      ![b.beforeHash,b.resultHash].every(h=>h===null||typeof h==='string'&&/^sha256:[a-f0-9]{64}$/.test(h))))fail('openspec.record');
  }
  return bindings;
}
export async function prepareStore(root,plan,old,context={}){
  const previous=context.previousPlan;
  for(const b of previous?.store?.bindings??[]){
    const next=plan?.store?.bindings.find(e=>e.repository===b.repository);
    if(next&&next.root!==b.root)fail('openspec.store-migration-required');
  }
  const relevant=Boolean(plan?.store||previous?.store||old?.storeBindings?.length);
  if(!relevant)return null;
  if(old?.plan&&old.status!=='removed'){
    if(old.plan.root!==(plan?.root??previous?.root)||old.plan.store&&plan?.store&&old.plan.store.id!==plan.store.id)fail('openspec.store-migration-required');
  }
  if(previous?.store&&!old)fail('openspec.store-ownership-missing');
  const retired=old?.retiredBindings??[];
  if(!Array.isArray(retired)||retired.length>512)fail('openspec.record');
  // Receipts never choose targets. Only the still-committed previous binding can
  // authorize replay of a retirement across the outer installation commit gap.
  const receipts=retired.filter(b=>previous?.store?.bindings.some(e=>e.repository===b.repository&&e.path===b.path));
  const owned=validateBindings(old?{...old,storeBindings:[...(old.storeBindings??[]),...receipts]}:old,[plan,previous]);
  if(old?.status==='ready'&&previous?.store&&previous.store.bindings.some(b=>!owned.some(e=>e.repository===b.repository&&e.path===b.path)))fail('openspec.store-ownership-missing');
  if(old?.schemaVersion===1&&previous?.store)fail('openspec.store-ownership-missing');
  if(old?.status==='pending'&&JSON.stringify(old.plan)!==JSON.stringify(plan))fail('openspec.store-migration-required');
  const store=plan?.store??previous?.store;
  if(!store)fail('openspec.store-ownership-missing');
  const docsRepository=plan?.repository??previous.repository;
  const docsRoot=plan?.root??previous.root,configPath=prefix(docsRoot)+'openspec/config.yaml',config=await storeFile(root,configPath,docsRepository);
  if(Object.hasOwn(configYaml(config,configPath,docsRepository).value,'store'))throw diagnostic(new ContractError('openspec.store-config-conflict'),configPath,docsRepository);
  const identity=await storeFile(root,store.identityPath,docsRepository);
  if(old?.storeIdentity&&(old.storeIdentity.id!==store.id||old.storeIdentity.path!==store.identityPath||
    !(old.storeIdentity.hash===null||typeof old.storeIdentity.hash==='string'&&/^sha256:[a-f0-9]{64}$/.test(old.storeIdentity.hash))))fail('openspec.record');
  if(identity){let parsed;try{parsed=parse(identity.toString('utf8'));}catch{throw diagnostic(new ContractError('openspec.store-identity-conflict'),store.identityPath,docsRepository);}
    if(parsed?.version!==1||parsed?.id!==store.id)throw diagnostic(new ContractError('openspec.store-identity-conflict'),store.identityPath,docsRepository);}
  const wanted=plan?.store?.bindings??[],all=new Map();
  for(const b of previous?.store?.bindings??[])all.set(b.repository,b);
  for(const b of wanted)all.set(b.repository,b);
  if(old?.status==='pending'&&(owned.length!==all.size||[...all.values()].some(b=>!owned.some(e=>e.repository===b.repository&&e.path===b.path))))fail('openspec.store-ownership-missing');
  const edits=[];
  for(const [repository,b]of all){
    const active=wanted.some(x=>x.repository===repository);
    if(active)await noLocalRoot(root,b);
    const bytes=await storeFile(root,b.path,repository),p=configYaml(bytes,b.path,repository),prior=owned.find(x=>x.repository===repository&&x.path===b.path);
    if(prior&&receipts.includes(prior)){
      if(prior.action!==(prior.ownership==='owned'?'remove':'preserve')||
        !(typeof prior.resultHash==='string'&&/^sha256:[a-f0-9]{64}$/.test(prior.resultHash)||prior.resultHash===null)||hash(bytes)!==prior.resultHash)fail('openspec.store-config-changed');
    }
    if(old?.status==='pending'&&prior){
      if(prior.action!==(prior.ownership==='borrowed'?'preserve':active?'set':'remove'))fail('openspec.record');
      if(prior.action==='preserve'&&prior.beforeHash!==prior.resultHash)fail('openspec.record');
      if(hash(bytes)!==prior.beforeHash&&hash(bytes)!==prior.resultHash)fail('openspec.store-config-changed');
      const result=hash(bytes)===prior.resultHash?bytes:prior.action==='preserve'?bytes:editStoreKey(bytes,prior.action==='remove'?null:prior.value);
      if(hash(result)!==prior.resultHash)fail('openspec.store-config-changed');
      const after=configYaml(result,b.path,repository).value;
      if(prior.action==='remove'?Object.hasOwn(after,'store'):after.store!==prior.value)fail('openspec.record');
      edits.push({...prior,bytes,result,active});continue;
    }
    if(!active&&!prior)fail('openspec.store-ownership-missing');
    const ownership=prior?.ownership??(Object.hasOwn(p.value,'store')?'borrowed':'owned');
    if(ownership==='borrowed'&&p.value.store!==store.id)throw diagnostic(new ContractError('openspec.store-config-conflict'),b.path,repository);
    const action=ownership==='borrowed'?'preserve':active?'set':'remove';
    const result=action==='preserve'?bytes:editStoreKey(bytes,active?store.id:null);
    edits.push({repository,path:b.path,key:'store',value:store.id,ownership,action,beforeHash:hash(bytes),resultHash:hash(result),bytes,result,active});
  }
  return {id:store.id,repository:plan?.repository??previous.repository,root:docsRoot,identityPath:store.identityPath,identityHash:hash(identity),edits};
}
export const storeIntents=prepared=>prepared?.edits.map(({bytes,result,active,...intent})=>intent)??[];
export const storeSummary=prepared=>prepared?{id:prepared.id,repository:prepared.repository,root:prepared.root,preservePlanning:true,
  bindings:prepared.edits.map(e=>({repository:e.repository,path:e.path,ownership:e.ownership,action:e.action==='set'?(e.beforeHash===null?'add':'set'):e.action}))}:null;
export async function applyStoreKeys(lock,prepared,{backupDirectory,boundary}={}){
  if(!prepared)return;
  for(const e of prepared.edits){
    await assertLockHeld(lock);
    if(hash(await storeFile(lock.workspace,e.path,e.repository))!==hash(e.bytes))throw diagnostic(new ContractError('openspec.store-config-changed'),e.path,e.repository);
    if(hash(e.bytes)!==hash(e.result)){
      if(backupDirectory&&e.bytes!==null){const file=resolveChild(backupDirectory,e.path);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,e.bytes,{flag:'wx',mode:0o600});}
      const file=resolveChild(lock.workspace,e.path);await mkdir(path.dirname(file),{recursive:true});await inspectDirectory(path.dirname(file));
      await writeFile(file,e.result,{mode:0o600});
    }
    await boundary?.('openspec-after-key',e.repository);
    if(hash(await storeFile(lock.workspace,e.path,e.repository))!==e.resultHash)throw diagnostic(new ContractError('openspec.readback'),e.path,e.repository);
  }
}
export async function inspectStoreRegistry(root,prepared){
  const bytes=await storeFile(root,storeRegistry);if(!bytes)fail('openspec.store-registry-stale');
  let value;try{value=parse(bytes.toString('utf8'));}catch{fail('openspec.store-registry-stale');}
  if(value.version!==1||value.stores?.[prepared.id]?.backend?.type!=='git'||
    path.resolve(value.stores[prepared.id].backend.local_path??'')!==resolveChild(root,prepared.root))fail('openspec.store-registry-stale');
}
