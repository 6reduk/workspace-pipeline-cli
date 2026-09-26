import Ajv2020 from 'ajv/dist/2020.js';
import {fail,parse} from '../contracts/parse.js';
import {contractDigest,portablePath} from '../contracts/semantic.js';
import {observeTargets} from '../operations/state.js';
import {writeCheckedFile,deleteCheckedFile} from '../operations/apply.js';
import {sha256,utf8} from '../source/inventory.js';
import {decodeLegacyState,retireLegacyState} from './legacy-state.js';
import {validateDesiredBinding} from './binding.js';

export const installedPath='.pipeline/desired-install.json';
export const pendingPath='.pipeline/desired-pending.json';
const hash={type:'string',pattern:'^sha256:[a-f0-9]{64}$'};
const validate=new Ajv2020({strict:true}).compile({type:'object',additionalProperties:false,
  required:['schemaVersion','operationHash','pipeline','providers','scopes','files','settings'],properties:{
    schemaVersion:{const:1},operationHash:hash,binding:{type:'object'},
    intent:{enum:['remove','removed']},
    adapters:{type:'array',minItems:1,uniqueItems:true,items:{type:'string',pattern:'^[a-z][a-z0-9-]{0,62}$'}},
    pipeline:{type:'object',additionalProperties:false,required:['id','version'],properties:{id:{type:'string'},version:{type:'string'}}},
    providers:{type:'array',uniqueItems:true,items:{enum:['codex','claude','grok','kimi']}},
    scopes:{type:'array',maxItems:10000,items:{type:'object',additionalProperties:false,required:['path','kind'],properties:{path:{type:'string'},kind:{enum:['file','directory']}}}},
    files:{type:'array',maxItems:10000,items:{type:'object',additionalProperties:false,required:['path','kind','hash'],properties:{path:{type:'string'},kind:{enum:['file','directory']},hash:{anyOf:[hash,{type:'null'}]}}}},
    settings:{type:'array',maxItems:1000,items:{type:'object',additionalProperties:false,required:['target','pointer','operation','valueHash'],properties:{target:{type:'string'},pointer:{type:'string'},operation:{enum:['set','remove']},valueHash:{anyOf:[hash,{type:'null'}]}}}}
  }});

// Only desired identities/digests, never old contents or secret setting values.
export function installationRecord(compiled,desired,{protectedPaths,globalConfigPath,binding}) {
  const files=desired.entries.map(e=>({path:e.path,kind:e.kind,hash:e.hash??null}));
  const provenance=binding===undefined?{}:{binding:validateDesiredBinding(binding)};
  return {schemaVersion:1,operationHash:contractDigest({compiled,files,protectedPaths,globalConfigPath,...provenance}),...provenance,
    pipeline:compiled.pipeline,adapters:compiled.adapters,providers:compiled.providers,scopes:desired.scopes,files,
    settings:compiled.settings.map(s=>({target:s.target,pointer:s.pointer,operation:s.operation,
      valueHash:s.operation==='set'?contractDigest(s.value):null}))};
}

export async function readDesiredRecords(workspace,{allowLegacyMigration=false}={}) {
  const observations=await observeTargets(workspace,[installedPath,pendingPath,'.pipeline/state.json']);
  // Migration is explicit; never silently abandon the old lifecycle state.
  const legacyBytes=observations.find(o=>o.path==='.pipeline/state.json').bytes;
  if(legacyBytes!==null && !allowLegacyMigration)fail('desired.legacy-migration-required');
  const result={legacy:legacyBytes===null?null:decodeLegacyState(workspace,legacyBytes)};
  for(const [key,name] of [['installed',installedPath],['pending',pendingPath]]) {
    const bytes=observations.find(o=>o.path===name).bytes;
    if(bytes===null){result[key]=null;continue;}
    const value=parse(utf8(bytes),'json');
    if(!validate(value))fail('desired.record-invalid');
    if(value.intent==='removed' && (key==='pending'||value.scopes.length||value.files.length||value.settings.length||value.providers.length))fail('desired.record-invalid');
    if(value.intent==='remove' && (key==='installed'||value.files.length||value.settings.some(s=>s.operation!=='remove'||s.target==='grok.user')))fail('desired.record-invalid');
    if(value.binding!==undefined)validateDesiredBinding(value.binding);
    for(const e of [...value.scopes,...value.files])portablePath(e.path);
    result[key]={value,hash:sha256(bytes)};
  }
  return result;
}

export function assertDesiredTransition(records,next) {
  if(records.pending?.value.intent==='remove' && next.intent!=='remove')fail('desired.finish-remove-before-update');
  if(records.pending && records.pending.value.operationHash!==next.operationHash)fail('desired.retry-same-source-required');
  const previous=records.installed?.value??records.legacy?.ownership;
  if(!previous || previous.intent==='removed')return;
  if(previous.pipeline.id!==next.pipeline.id)fail('desired.pipeline-switch-not-integrated');
}

const encode=record=>Buffer.from(JSON.stringify(record,null,2)+'\n');
export async function beginDesiredInstall(lock,records,next) {
  if(records.pending)return records.pending.hash;
  return writeCheckedFile(lock,pendingPath,null,encode(next));
}
export async function completeDesiredInstall(lock,records,next,pendingHash) {
  const completed=next.intent==='remove'?{...next,intent:'removed',scopes:[],files:[],settings:[],providers:[]}:next;
  const bytes=encode(completed);
  if(records.installed?.hash!==sha256(bytes))
    await writeCheckedFile(lock,installedPath,records.installed?.hash??null,bytes);
  await retireLegacyState(lock,records.legacy);
  if(pendingHash)await deleteCheckedFile(lock,pendingPath,pendingHash,async()=>{});
}
