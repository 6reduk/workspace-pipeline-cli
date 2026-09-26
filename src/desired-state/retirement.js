import {compileDesiredManifest} from '../contracts/desired-state.js';
import {compileDesiredSettings} from './settings.js';
import {fail} from '../contracts/parse.js';

const contains=(parent,child)=>parent===child || child.startsWith(parent+'/');

// Revalidate stored ownership through today's scope policy. A historical record
// is not a bypass for repository exclusions or config-field permissions.
export function includeRetiredTargets(previous,compiled,desired,protectedPaths) {
  if(!previous)return {desired,settings:compiled.settings};
  const priorSettings=previous.settings.map(s=>({target:s.target,pointer:s.pointer,operation:'remove'}));
  compileDesiredManifest(JSON.stringify({schemaVersion:2,id:'retirement-check',version:'0.0.0',adapters:{prior:{
    providers:['codex'],files:previous.scopes.map(s=>({source:'unused',target:s.path,kind:s.kind})),settings:priorSettings
  }}}),{selected:['prior'],protectedPaths});
  for(const op of priorSettings)compileDesiredSettings(op.target,null,[op]);
  const settings=[...compiled.settings,...priorSettings.filter(old=>
    previous.settings.find(s=>s.target===old.target && s.pointer===old.pointer).operation==='set' &&
    !compiled.settings.some(s=>s.target===old.target && s.pointer===old.pointer))];
  const all=[...previous.scopes,...desired.scopes];
  // Different spellings of intersecting scopes cannot be resolved portably.
  for(const a of all)for(const b of all) {
    if(contains(a.path.toLowerCase(),b.path.toLowerCase()) && !contains(a.path,b.path))fail('desired.retirement-case-alias');
  }
  const unique=[...new Map(all.map(s=>[s.path,s])).values()];
  const scopes=unique.filter(s=>!unique.some(parent=>parent.path!==s.path && contains(parent.path,s.path)));
  const entries=new Map(desired.entries.map(e=>[e.path,e]));
  // A narrowed former directory still needs structural parents while deleting
  // its obsolete siblings. Those parents are not new ownership grants.
  for(const entry of desired.entries) {
    const parts=entry.path.split('/');
    for(let i=1;i<parts.length;i++) {
      const name=parts.slice(0,i).join('/');
      if(scopes.some(s=>contains(s.path,name)) && !entries.has(name))entries.set(name,{path:name,kind:'directory'});
    }
  }
  return {desired:{scopes,entries:[...entries.values()]},settings};
}
