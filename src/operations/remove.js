import {inspectRepair} from './repair.js';
import {readState,observeTargets} from './state.js';
import {resolveChild} from '../workspace/paths.js';
import {requestShape} from './ownership.js';
import {readConfigField,reconcileConfigFields} from './config-fields.js';
import {bindPreview} from './plan.js';
import {contractDigest} from '../contracts/semantic.js';
import {parse,fail} from '../contracts/parse.js';
import {sha256} from '../source/inventory.js';
import {assertLockHeld} from './lock.js';
import {removedWithProviders} from '../providers/common-entry.js';

export function selectRemovalProviders(available,requested=available) {
  if(!Array.isArray(available) || !Array.isArray(requested) || !requested.length ||
      new Set(requested).size!==requested.length || requested.some(id=>typeof id!=='string' || !available.includes(id)))fail('remove.providers');
  const providers=[...requested].sort(),remaining=available.filter(id=>!providers.includes(id)).sort();
  return {providers,remaining,owners:[...providers,...(remaining.length?[]:['shared'])]};
}

export function selectBundleRemoval(active, options={}) {
  const all=options.providers===undefined && options.bundles===undefined;
  const bundleIds=all?Object.keys(active.bundles??{}).sort():options.bundles??[];
  if(!Array.isArray(bundleIds) || new Set(bundleIds).size!==bundleIds.length ||
      bundleIds.some(id=>!Object.hasOwn(active.bundles??{},id)))fail('remove.bundles');
  const grouped=new Set(Object.values(active.bundles??{}).flatMap(b=>b.providers));
  const standalone=all?active.providers.filter(id=>!grouped.has(id)):options.providers??[];
  if(!Array.isArray(standalone) || standalone.some(id=>grouped.has(id)))fail('remove.bundle-required');
  const selection=selectRemovalProviders(active.providers,[...standalone,...bundleIds.flatMap(id=>active.bundles[id].providers)]);
  return {...selection,bundles:[...bundleIds].sort()};
}

// Internal preparation. Replay establishes owned scope from the installed
// package; preparation never deletes. Private byte payload.
export async function prepareRemoval(workspace,registry,options={}) {
  requestShape(options,[],['providers','bundles'],'remove.options');
  const inspection=await inspectRepair(workspace,registry);
  if(inspection.entries.some(e=>e.disposition!=='intact'))fail('remove.conflict');
  workspace=inspection.workspace;
  const record=await readState(resolveChild(workspace,'.pipeline/state.json'));
  if(record.digest!==inspection.stateHash)fail('remove.observation-drift');
  const previous=record.value,active=previous.active,selection=selectBundleRemoval(active,options);
  const removed=active.owned.filter(o=>removedWithProviders(o,selection));
  const retained=active.owned.filter(o=>!removedWithProviders(o,selection));
  const observations=await observeTargets(workspace,[...new Set(active.owned.map(o=>o.path))]);
  const current=new Map(observations.map(o=>[o.path,o.bytes])),backups=new Map(),targets=[],outputs=[];
  const backup=async owned=>{
    if(owned.backup===null)fail('remove.backup-missing');
    if(!backups.has(owned.backup)) {
      const [observation]=await observeTargets(workspace,[owned.backup]);
      if(observation.bytes===null)fail('remove.backup-missing');
      backups.set(owned.backup,observation.bytes);
    }
    return backups.get(owned.backup);
  };
  for(const name of [...new Set(removed.map(o=>o.path))].sort()) {
    const owned=removed.filter(o=>o.path===name),before=current.get(name);
    if(before===null)fail('remove.conflict');
    let bytes=null,fields=[],action;
    if(owned[0].kind==='file') {
      if(sha256(before)!==owned[0].managedHash)fail('remove.conflict');
      if(owned[0].beforeHash!==null) {
        bytes=await backup(owned[0]);
        if(sha256(bytes)!==owned[0].beforeHash)fail('remove.backup-mismatch');
      }
      action=bytes===null?'delete':'replace';
    }else {
      const requests=[];
      for(const item of owned) {
        const request={pointer:item.pointer,present:item.beforeHash!==null,managedHash:item.managedHash};
        if(request.present) {
          const found=readConfigField(name,await backup(item),item.pointer);
          if(!found.present)fail('remove.backup-field');
          request.value=found.value;
          if(contractDigest(request.value)!==item.beforeHash)fail('remove.backup-mismatch');
        }
        requests.push(request);
      }
      const result=reconcileConfigFields(name,before,requests);
      fields=result.decisions.map(f=>({pointer:f.pointer,beforeHash:f.currentHash,desiredHash:f.desiredHash}));
      bytes=result.bytes;action='edit-fields';
    }
    const beforeHash=sha256(before),desiredHash=bytes===null?null:sha256(bytes);
    if(beforeHash===desiredHash)continue;
    targets.push({id:'target-'+String(targets.length+1),path:name,owner:owned[0].owner,action,beforeHash,desiredHash,fields});
    if(bytes!==null)outputs.push({path:name,bytes});
  }
  let desired=null;
  if(selection.remaining.length) {
    desired={...structuredClone(active),providers:selection.remaining,owned:structuredClone(retained),
      adapterVersions:Object.fromEntries(selection.remaining.map(id=>[id,active.adapterVersions[id]]))};
    if(desired.bundles) {
      desired.bundles=Object.fromEntries(Object.entries(desired.bundles).filter(([id])=>!selection.bundles.includes(id)));
      if(!Object.keys(desired.bundles).length)delete desired.bundles;
    }
    desired.id='deployment-'+contractDigest({snapshot:desired.snapshot,layout:desired.layout,
      ...(desired.agentsDocument===undefined?{}:{agentsDocument:desired.agentsDocument}),
      providers:desired.providers,owned:desired.owned,...(desired.bundles?{bundles:desired.bundles}:{})}).slice(7);
  }
  const preview=bindPreview({schemaVersion:1,kind:'plan',command:'remove',workspace,beforeStateHash:contractDigest(previous),
    source:structuredClone(active.snapshot),desired,targets},previous,{observations,outputs});
  if((await inspectRepair(workspace,registry)).digest!==inspection.digest)fail('remove.observation-drift');
  for(const fresh of await observeTargets(workspace,observations.map(o=>o.path))) {
    const before=current.get(fresh.path);
    if((fresh.bytes===null?null:sha256(fresh.bytes))!==(before===null?null:sha256(before)))fail('remove.observation-drift');
  }
  for(const [name,bytes] of backups) {
    const [fresh]=await observeTargets(workspace,[name]);
    if(fresh.bytes===null || sha256(fresh.bytes)!==sha256(bytes))fail('remove.observation-drift');
  }
  const body={kind:'prepared-removal',preview,stateFileHash:record.digest,providers:selection.providers,
    ...(selection.bundles.length?{bundles:selection.bundles}:{}),
    backups:[...backups].map(([path,bytes])=>({path,hash:sha256(bytes)})),
    applySupported:true,requiresFreshApproval:true,automaticActions:false,runtime:'not-run'};
  parse(JSON.stringify(body),'json');return {...body,digest:contractDigest(body)};
}

// Record validation is not a write grant; apply must also replay under lock.
export function validateRemovalRecord(prepared,approval) {
  requestShape(prepared,['kind','preview','stateFileHash','providers','backups','applySupported','requiresFreshApproval','automaticActions','runtime','digest'],['bundles'],'remove.prepared');
  requestShape(approval,['decision','preparedDigest'],[],'remove.approval');
  const copy=structuredClone(parse(JSON.stringify(prepared),'json')),decision=structuredClone(approval);
  const {digest,...body}=copy;
  if(copy.kind!=='prepared-removal' || copy.applySupported!==true || copy.requiresFreshApproval!==true ||
      copy.automaticActions!==false || copy.runtime!=='not-run' || contractDigest(body)!==digest)fail('remove.prepared');
  if(decision.decision!=='approve' || decision.preparedDigest!==digest)fail('remove.approval');
  return copy;
}

export async function verifyRemovalApproval(lock,prepared,approval,registry) {
  const copy=validateRemovalRecord(prepared,approval);
  await assertLockHeld(lock);
  if(copy.preview?.plan?.workspace!==lock.workspace)fail('remove.workspace');
  const active=(await readState(resolveChild(lock.workspace,'.pipeline/state.json'))).value.active;
  const members=new Set((copy.bundles??[]).flatMap(id=>active?.bundles?.[id]?.providers??[]));
  const fresh=await prepareRemoval(lock.workspace,registry,{providers:copy.providers.filter(id=>!members.has(id)),
    ...(copy.bundles?{bundles:copy.bundles}:{})});
  if(contractDigest(fresh)!==contractDigest(copy))fail('remove.plan-drift');
  await assertLockHeld(lock);
  return fresh;
}
