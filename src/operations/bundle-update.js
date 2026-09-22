import { fail } from '../contracts/parse.js';
import { contractDigest } from '../contracts/semantic.js';
import { sha256 } from '../source/inventory.js';
import { readConfigField, reconcileConfigFields } from './config-fields.js';

// Only a member removed from a still-selected bundle may retire during update.
// Standalone removal and removal of an entire bundle remain explicit operations.
export function retiredBundleOwnership(previous, selection) {
  const owners=new Set();
  for(const [id,bundle] of Object.entries(previous?.active?.bundles??{})) {
    if(!selection.bundles?.[id])continue;
    for(const member of bundle.providers) if(!selection.providers.includes(member))owners.add(member);
  }
  return (previous?.active?.owned??[]).filter(o=>owners.has(o.owner));
}
export function planObservationPaths(requests, previous, selection) {
  const retired=retiredBundleOwnership(previous,selection);
  return [...new Set([...requests.map(r=>r.path),...retired.flatMap(o=>[o.path,...(o.backup?[o.backup]:[])])])].sort();
}
export function restoreRetired(entries, observations) {
  const outputs=[];
  const bytesAt=name=>{
    if(!observations.has(name) || !Buffer.isBuffer(observations.get(name)))fail('bundle.retirement-missing');
    return observations.get(name);
  };
  for(const name of [...new Set(entries.map(o=>o.path))].sort()) {
    const owned=entries.filter(o=>o.path===name),before=bytesAt(name);
    let bytes=null,fields=[],action;
    if(owned[0].kind==='file') {
      if(sha256(before)!==owned[0].managedHash)fail('ownership.drift');
      if(owned[0].beforeHash!==null) {
        bytes=bytesAt(owned[0].backup);
        if(sha256(bytes)!==owned[0].beforeHash)fail('bundle.backup-mismatch');
      }
      action=bytes===null?'delete':'replace';
    } else {
      const requests=owned.map(o=>{
        const request={pointer:o.pointer,present:o.beforeHash!==null,managedHash:o.managedHash};
        if(request.present) {
          const found=readConfigField(name,bytesAt(o.backup),o.pointer);
          if(!found.present || contractDigest(found.value)!==o.beforeHash)fail('bundle.backup-mismatch');
          request.value=found.value;
        }
        return request;
      });
      const result=reconcileConfigFields(name,before,requests);bytes=result.bytes;
      fields=result.decisions.map(f=>({pointer:f.pointer,beforeHash:f.currentHash,desiredHash:f.desiredHash}));
      action='edit-fields';
    }
    const beforeHash=sha256(before),desiredHash=bytes===null?null:sha256(bytes);
    outputs.push({path:name,owner:owned[0].owner,action,beforeHash,desiredHash,fields,bytes});
  }
  return outputs;
}
