import {checkPreview} from './plan.js';
import {readConfigField} from './config-fields.js';
import {contractDigest} from '../contracts/semantic.js';
import {fail} from '../contracts/parse.js';
import {sha256} from '../source/inventory.js';

// Derive incoming backups from the approved post-removal observations, never
// from still-installed old provider bytes. Pure; not an authorization to write.
export function incomingSwitchBackups(preview) {
  const observations=preview.observations.map(o=>({path:o.path,bytes:o.bytes===null?null:Buffer.from(o.bytes,'base64')}));
  const checked=checkPreview(preview,null,observations);
  if(checked.plan.command!=='setup' || !checked.plan.desired)fail('switch-backup.phase');
  const observed=new Map(observations.map(o=>[o.path,o.bytes])),backups=new Map();
  for(const owned of checked.plan.desired.owned) {
    if(owned.backup===null)continue;
    const bytes=observed.get(owned.path);
    if(!Buffer.isBuffer(bytes))fail('switch-backup.missing');
    const hash=sha256(bytes);
    if(owned.kind==='file') {
      if(hash!==owned.beforeHash)fail('switch-backup.before');
    }else {
      const field=readConfigField(owned.path,bytes,owned.pointer);
      if(!field.present || contractDigest(field.value)!==owned.beforeHash)fail('switch-backup.before');
    }
    if(backups.has(owned.backup) && backups.get(owned.backup).hash!==hash)fail('switch-backup.conflict');
    backups.set(owned.backup,{path:owned.backup,hash,bytes:Buffer.from(bytes)});
  }
  return [...backups.values()].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
