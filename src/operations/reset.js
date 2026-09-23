import {observeRepair} from './repair.js';
import {readState,observeTargets,verifyInstalledSnapshot} from './state.js';
import {selectBundleRemoval} from './remove.js';
import {removedWithProviders} from '../providers/common-entry.js';
import {absoluteRoot,resolveChild} from '../workspace/paths.js';
import {readConfigField,reconcileConfigFields} from './config-fields.js';
import {clearResetTOMLSections} from './toml-fields.js';
import {requestShape} from './ownership.js';
import {bindPreview} from './plan.js';
import {contractDigest} from '../contracts/semantic.js';
import {fail,parse} from '../contracts/parse.js';
import {sha256} from '../source/inventory.js';
import {assertLockHeld} from './lock.js';
import {resetScope,scopeOwns,scopeOwnsRecord,scanResetTrees,resetBackupManifest} from './reset-scope.js';

const hash=b=>b===null?null:sha256(b);
const same=(a,b)=>contractDigest(a)===contractDigest(b);
export function resetOptions(options){
  requestShape(options,[],['to','all','providers','bundles'],'reset.options');
  const to=options.to??'installed';if(!['installed','empty'].includes(to))fail('reset.mode');
  if(options.all!==undefined && options.all!==true)fail('reset.selection');
  if(options.all?(options.providers!==undefined || options.bundles!==undefined):
    !(options.providers?.length || options.bundles?.length))fail('reset.selection');
  return {to,...options.all?{all:true}:{...(options.providers?{providers:[...options.providers]}:{}),...(options.bundles?{bundles:[...options.bundles]}:{})}};
}

export async function prepareReset(workspace,registry,options){
  const selectionRequest=resetOptions(options);workspace=absoluteRoot(workspace);
  const {inspection,requests}=await observeRepair(workspace,registry);
  const record=await readState(resolveChild(workspace,'.pipeline/state.json'));
  if(record.digest!==inspection.stateHash)fail('reset.observation-drift');
  const previous=record.value,active=previous.active;
  const selection=selectBundleRemoval(active,selectionRequest.all?{}:selectionRequest);
  const scope=resetScope(active,selection);
  // Protect repository destinations, including absent repositories and docs roots.
  const protectedPaths=[...Object.values(active.layout.repositories).map(r=>r.path)];
  const docs=active.layout.documentation;
  protectedPaths.push(active.layout.repositories[docs.repository].path+'/'+docs.path);
  const overlap=(a,b)=>a.toLowerCase()===b.toLowerCase() || a.toLowerCase().startsWith(b.toLowerCase()+'/') || b.toLowerCase().startsWith(a.toLowerCase()+'/');
  if([...scope.trees,...scope.files,...Object.keys(scope.fields)].some(p=>protectedPaths.some(r=>overlap(p,r))))fail('reset.repository-overlap');
  const tree=await scanResetTrees(workspace,scope);
  const selected=o=>removedWithProviders(o,selection);
  if(active.owned.some(o=>selected(o) && !scopeOwnsRecord(scope,o)))fail('reset.unsupported-owned-scope');
  if(active.owned.some(o=>!selected(o) && scopeOwnsRecord(scope,o)))fail('reset.shared-conflict');
  if(inspection.entries.some(e=>!selected(e) && e.disposition!=='intact'))fail('reset.unselected-drift');
  const names=[...new Set([...tree.files,...scope.files,...Object.keys(scope.fields),...active.owned.map(o=>o.path),
    ...requests.filter(selected).map(r=>r.path)])].sort();
  const observations=await observeTargets(workspace,names),current=new Map(observations.map(o=>[o.path,o.bytes]));
  const desiredBytes=new Map(),owned=active.owned.filter(o=>!selected(o)).map(o=>structuredClone(o));
  for(const name of [...tree.files,...scope.files])desiredBytes.set(name,null);
  // Remove only known provider sections; model/auth/permissions and foreign
  // sections survive. Malformed documents fail rather than getting wiped whole.
  for(const [name,pointers] of Object.entries(scope.fields)){
    const before=current.get(name);let bytes=before;
    if(name.endsWith('.toml')){
      desiredBytes.set(name,clearResetTOMLSections(before,pointers.map(p=>p.slice(1))));continue;
    }
    for(const pointer of pointers){
      const found=readConfigField(name,bytes,pointer);
      if(found.present)bytes=reconcileConfigFields(name,bytes,[{pointer,present:false,managedHash:contractDigest(found.value)}]).bytes;
    }
    desiredBytes.set(name,bytes);
  }
  if(selectionRequest.to==='installed')for(const request of requests.filter(selected)){
    if(!scopeOwns(scope,request.path))fail('reset.unsupported-owned-scope');
    if(request.kind==='file'){
      desiredBytes.set(request.path,request.bytes);
      owned.push({path:request.path,owner:request.owner,kind:'file',pointer:null,beforeHash:null,managedHash:sha256(request.bytes),backup:null});
    }else{
      const fields=request.fields.map(f=>f.present?{pointer:f.pointer,present:true,value:f.value}:{pointer:f.pointer,present:false});
      if(fields.some(f=>!(scope.fields[request.path]??[]).some(p=>f.pointer===p || f.pointer.startsWith(p+'/'))))fail('reset.unsupported-owned-scope');
      const result=reconcileConfigFields(request.path,desiredBytes.get(request.path)??null,fields);
      desiredBytes.set(request.path,result.bytes);
      for(const f of result.decisions)if(f.desiredHash!==null)owned.push({path:request.path,owner:request.owner,kind:'field',pointer:f.pointer,beforeHash:null,managedHash:f.desiredHash,backup:null});
    }
  }
  const targets=[],outputs=[];
  for(const [name,bytes] of [...desiredBytes].sort(([a],[b])=>a.localeCompare(b))){
    const before=current.get(name)??null;if(hash(before)===hash(bytes))continue;
    const owner=active.owned.find(o=>o.path===name && selected(o))?.owner??selection.providers.find(id=>scopeOwns(resetScope(active,{providers:[id],remaining:active.providers.filter(p=>p!==id),owners:[id]}),name));
    if(!owner)fail('reset.owner');
    targets.push({id:'target-'+(targets.length+1),path:name,owner,action:bytes===null?'delete':before===null?'create':'replace',
      beforeHash:hash(before),desiredHash:hash(bytes),fields:[]});
    if(bytes!==null)outputs.push({path:name,bytes});
  }
  let desired=structuredClone(active);
  if(selectionRequest.to==='empty'){
    desired.providers=selection.remaining;
    desired.adapterVersions=Object.fromEntries(selection.remaining.map(p=>[p,active.adapterVersions[p]]));
    if(desired.bundles){desired.bundles=Object.fromEntries(Object.entries(desired.bundles).filter(([id])=>!selection.bundles.includes(id)));if(!Object.keys(desired.bundles).length)delete desired.bundles;}
    if(!selection.remaining.length)desired=null;
  }
  if(desired){desired.owned=owned;desired.id='deployment-'+contractDigest({resetFrom:record.digest,deployment:{...desired,id:null}}).slice(7);}
  const preview=bindPreview({schemaVersion:1,kind:'plan',command:'reset',workspace,beforeStateHash:contractDigest(previous),
    source:structuredClone(active.snapshot),desired,targets},previous,{observations,outputs});
  const backup=resetBackupManifest(preview,selectionRequest,selectionRequest.to);
  const body={kind:'prepared-reset',preview,stateFileHash:record.digest,reset:{selection:selectionRequest,scope,tree,backup},
    applySupported:true,requiresFreshApproval:true,automaticActions:false,runtime:'not-run'};
  if(!same(tree,await scanResetTrees(workspace,scope)))fail('reset.tree-drift');
  for(const fresh of await observeTargets(workspace,names))if(hash(fresh.bytes)!==hash(current.get(fresh.path)))fail('reset.observation-drift');
  await verifyInstalledSnapshot(previous);
  if((await readState(resolveChild(workspace,'.pipeline/state.json'))).digest!==record.digest)fail('reset.observation-drift');
  parse(JSON.stringify(body),'json');return {...body,digest:contractDigest(body)};
}

export function validateResetRecord(prepared,approval){
  requestShape(prepared,['kind','preview','stateFileHash','reset','applySupported','requiresFreshApproval','automaticActions','runtime','digest'],[],'reset.prepared');
  requestShape(approval,['decision','preparedDigest'],[],'reset.approval');
  const copy=parse(JSON.stringify(prepared),'json'),{digest,...body}=copy;
  if(copy.kind!=='prepared-reset' || copy.preview?.plan?.command!=='reset' || copy.runtime!=='not-run' ||
    copy.applySupported!==true || copy.requiresFreshApproval!==true || copy.automaticActions!==false || contractDigest(body)!==digest)fail('reset.prepared');
  if(approval.decision!=='approve' || approval.preparedDigest!==digest)fail('reset.approval');
  validateResetContext(copy.reset,copy.preview);
  return structuredClone(copy);
}
export function validateResetContext(reset,preview){
  requestShape(reset,['selection','scope','tree','backup'],[],'reset.context');
  resetOptions(reset.selection);
  if(!same(reset.backup,resetBackupManifest(preview,reset.selection,reset.selection.to)))fail('reset.backup-binding');
}
export async function verifyResetApproval(lock,prepared,approval,registry){
  const copy=validateResetRecord(prepared,approval);await assertLockHeld(lock);
  if(copy.preview.plan.workspace!==lock.workspace)fail('reset.workspace');
  const fresh=await prepareReset(lock.workspace,registry,copy.reset.selection);
  if(!same(fresh,copy))fail('reset.plan-drift');
  await assertLockHeld(lock);return fresh;
}
