import {parse,fail} from '../contracts/parse.js';
import {utf8} from '../source/inventory.js';
import {reconcileFields} from './ownership.js';
import {readTOMLField,reconcileTOMLFields} from './toml-fields.js';

// The codec is selected by a trusted exact destination, not source-provided code
// or guessed bytes. Historical JSON field paths retain their existing format.
export function readConfigField(name,bytes,pointer) {
  if(['.codex/config.toml','.grok/config.toml'].includes(name))return readTOMLField(bytes,pointer);
  if(bytes===null)return {present:false};
  let node=parse(utf8(bytes),'json');
  for(const part of pointer.slice(1).split('/').map(p=>p.replace(/~1/g,'/').replace(/~0/g,'~'))) {
    if(node===null || typeof node!=='object' || Array.isArray(node))fail('ownership.ancestor');
    if(!Object.hasOwn(node,part))return {present:false};
    node=node[part];
  }
  return {present:true,value:node};
}

export function reconcileConfigFields(name,bytes,requests) {
  if(['.codex/config.toml','.grok/config.toml'].includes(name))return reconcileTOMLFields(bytes,requests);
  const result=reconcileFields(bytes===null?{}:parse(utf8(bytes),'json'),requests);
  return {decisions:result.decisions,bytes:Buffer.from(JSON.stringify(result.value,null,2)+'\n')};
}
