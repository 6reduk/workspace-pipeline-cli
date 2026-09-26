import {readFileSync} from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import {fail, parse} from './parse.js';
import {portablePath} from './semantic.js';

const schema = JSON.parse(readFileSync(new URL('../../schemas/pipeline-v2.schema.json', import.meta.url), 'utf8'));
const validate = new Ajv2020({strict:true, strictRequired:false, ownProperties:true}).compile(schema);
const configPaths = ['workspace.json', '.codex/config.toml', '.claude/settings.local.json', '.mcp.json', '.grok/config.toml'];
const overlap = (a,b) => a===b || a.startsWith(b+'/') || b.startsWith(a+'/');
const folded = value => value.toLowerCase();

// Pure compilation only: no filesystem access to source/workspace, no authority
// to apply. Filesystem/reparse checks and config-field permissions belong to the
// later materialization boundary. Accept serialized data, never executable objects.
export function compileDesiredManifest(text, {selected, protectedPaths=[]}={}) {
  const manifest = parse(text, 'json');
  if (!validate(manifest)) fail('desired.schema');
  if (!Array.isArray(selected) || !selected.length || new Set(selected).size!==selected.length ||
      selected.some(id=>typeof id!=='string' || !Object.hasOwn(manifest.adapters,id))) fail('desired.selection');
  if (!Array.isArray(protectedPaths)) fail('desired.protected-paths');
  for (const p of protectedPaths) portablePath(p);
  const files=[], settings=[], providers=new Set();
  // Validate paths even in unselected adapters; reject a malformed source early.
  // Common payload is installed once regardless of selected provider count.
  // $shared cannot be a user adapter ID under the schema's identifier rule.
  const deliveries=[['$shared',{providers:[],files:manifest.files??[],settings:[]}],...Object.entries(manifest.adapters)];
  for (const [id,adapter] of deliveries) {
    for (const file of adapter.files) {
      portablePath(file.source); portablePath(file.target);
      const target=folded(file.target);
      if (['.git','.pipeline',...configPaths,...protectedPaths].some(p=>overlap(target,folded(p)))) fail('desired.scope');
    }
    for (const item of adapter.settings) {
      if (!item.pointer.startsWith('/') || /~(?![01])/.test(item.pointer)) fail('desired.pointer');
      const tokens=item.pointer.slice(1).split('/').map(p=>p.replace(/~1/g,'/').replace(/~0/g,'~'));
      if (tokens.some(p=>!p || ['__proto__','constructor','prototype'].includes(p))) fail('desired.pointer');
    }
    if (id!=='$shared' && !selected.includes(id)) continue;
    for (const provider of adapter.providers) {
      if (providers.has(provider)) fail('desired.provider-overlap');
      providers.add(provider);
    }
    files.push(...adapter.files.map(f=>({...f,adapter:id})));
    settings.push(...adapter.settings.map(s=>({...s,adapter:id})));
  }
  for (let i=0;i<files.length;i++) for (let j=0;j<i;j++) {
    if (overlap(folded(files[i].target),folded(files[j].target))) fail('desired.target-overlap');
  }
  for (let i=0;i<settings.length;i++) for (let j=0;j<i;j++) {
    if (settings[i].target===settings[j].target && overlap(settings[i].pointer,settings[j].pointer)) fail('desired.field-overlap');
  }
  return {schemaVersion:2, pipeline:{id:manifest.id,version:manifest.version},
    adapters:[...selected].sort(),providers:[...providers].sort(),
    files:files.sort((a,b)=>a.target.localeCompare(b.target,'en')),
    settings:settings.sort((a,b)=>(a.target+a.pointer).localeCompare(b.target+b.pointer,'en'))};
}
