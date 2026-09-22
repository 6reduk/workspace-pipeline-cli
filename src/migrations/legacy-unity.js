// Pure preparation; no filesystem, authorization, installation or rollback.
import {parseTOML, getStaticTOMLValue} from 'toml-eslint-parser';
import {parseDocument} from 'yaml';
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {parse, fail, MAX_INPUT_BYTES} from '../contracts/parse.js';
import {utf8} from '../source/inventory.js';
import {contractDigest} from '../contracts/semantic.js';
import {requestShape} from '../operations/ownership.js';
const id='unity-sdd-pipeline@unity-sdd';
const hash=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function toml(text){try{const ast=parseTOML(text,{tomlVersion:'1.0'});return {ast,value:getStaticTOMLValue(ast)};}catch{fail('migration.toml');}}
const keys=k=>k.keys.map(x=>x.type==='TOMLBare'?x.name:x.value);
export function prepareLegacyUnityOptOut(provider,bytes){
 if(!['codex','claude'].includes(provider))fail('migration.provider');
 if(!Buffer.isBuffer(bytes)||bytes.length>MAX_INPUT_BYTES)fail('migration.input');
 const text=utf8(bytes);let value,range,read;
 if(provider==='codex'){
  const parsed=toml(text);value=parsed.value;read=s=>toml(s).value;
  const matches=[];
  const pair=(node,base)=>{if(isDeepStrictEqual([...base,...keys(node.key)],['plugins',id,'enabled']))matches.push(node.value.range);};
  for(const node of parsed.ast.body[0].body){
   if(node.type==='TOMLKeyValue')pair(node,[]);
   else if(node.type==='TOMLTable'&&node.kind==='standard')for(const item of node.body)pair(item,node.resolvedKey);
  }
  if(!object(value.plugins)||!object(value.plugins[id])||typeof value.plugins[id].enabled!=='boolean')fail('migration.activation-missing');
  if(value.plugins[id].enabled){if(matches.length!==1)fail('migration.toml-layout');range=matches[0];}
  value.plugins[id].enabled=false;
 }else{
  value=parse(text,'json');read=s=>parse(s,'json');
  if(!object(value)||!object(value.enabledPlugins)||typeof value.enabledPlugins[id]!=='boolean')fail('migration.activation-missing');
  if(value.enabledPlugins[id])range=parseDocument(text).getIn(['enabledPlugins',id],true)?.range?.slice(0,2);
  value.enabledPlugins[id]=false;
 }
 let output=text;
 if(range){if(text.slice(...range)!=='true')fail('migration.layout');output=text.slice(0,range[0])+'false'+text.slice(range[1]);}
 if(!isDeepStrictEqual(read(output),value))fail('migration.postcondition');
 const after=Buffer.from(output);
 return {provider,path:provider==='codex'?'.codex/config.toml':'.claude/settings.local.json',beforeHash:hash(bytes),afterHash:hash(after),changed:!bytes.equals(after),bytes:after};
}

// Configuration-only phase: entry replacement and installation are deliberately
// NOT encoded here. The outer migration coordinator must prefetch first and bind
// this phase to its complete approved migration, using the existing workspace lock.
export function prepareLegacyUnityDeactivation(observations){
 if(!Array.isArray(observations)||observations.length!==2)fail('migration.observations');
 const found=new Map();
 for(const item of observations){
  requestShape(item,['provider','bytes'],[],'migration.observations');
  if(found.has(item.provider))fail('migration.observations');
  found.set(item.provider,prepareLegacyUnityOptOut(item.provider,item.bytes));
 }
 if(!found.has('codex')||!found.has('claude'))fail('migration.observations');
 const targets=['codex','claude'].map(provider=>{
  const result=found.get(provider),before=observations.find(x=>x.provider===provider).bytes;
  return {provider,path:result.path,beforeHash:result.beforeHash,afterHash:result.afterHash,
   before:before.toString('base64'),after:result.bytes.toString('base64')};
 });
 const body={schemaVersion:1,kind:'legacy-unity-deactivation',targets};
 return {...body,digest:contractDigest(body)};
}

export function validateLegacyUnityDeactivation(record){
 requestShape(record,['schemaVersion','kind','targets','digest'],[],'migration.record');
 if(record.schemaVersion!==1||record.kind!=='legacy-unity-deactivation'||!Array.isArray(record.targets)||record.targets.length!==2)fail('migration.record');
 const observations=record.targets.map(t=>{
  requestShape(t,['provider','path','beforeHash','afterHash','before','after'],[],'migration.record');
  if(Object.values(t).some(v=>typeof v!=='string'))fail('migration.record');
  if(typeof t.before!=='string'||t.before.length>Math.ceil(MAX_INPUT_BYTES/3)*4)fail('migration.record');
  const bytes=Buffer.from(t.before,'base64');
  if(bytes.toString('base64')!==t.before)fail('migration.record');
  return {provider:t.provider,bytes};
 });
 const rebuilt=prepareLegacyUnityDeactivation(observations);
 // Rebuild transformations; a caller-supplied digest alone grants no scope.
 // The strict record reader returns null-prototype JSON objects. Prototype is
 // not persisted identity; validated keys/values and ordering are.
 if(contractDigest(record)!==contractDigest(rebuilt))fail('migration.binding');
 return rebuilt;
}

// Observation classification only, never an instruction to write or restore.
// An after-state could have been written by somebody else: hash equality is not
// ownership or proof that this migration executed it.
export function inspectLegacyUnityDeactivation(record,observations){
 const checked=validateLegacyUnityDeactivation(record);
 if(!Array.isArray(observations)||observations.length!==2)fail('migration.observations');
 const found=new Map();
 for(const item of observations){
  requestShape(item,['provider','bytes'],[],'migration.observations');
  if(!['codex','claude'].includes(item.provider)||found.has(item.provider)||
    (item.bytes!==null&&(!Buffer.isBuffer(item.bytes)||item.bytes.length>MAX_INPUT_BYTES)))fail('migration.observations');
  found.set(item.provider,item.bytes===null?null:hash(item.bytes));
 }
 return checked.targets.map(t=>({provider:t.provider,path:t.path,
  state:found.get(t.provider)===t.beforeHash?(t.beforeHash===t.afterHash?'unchanged-disabled':'before'):
   found.get(t.provider)===t.afterHash?'after':'conflict'}));
}
