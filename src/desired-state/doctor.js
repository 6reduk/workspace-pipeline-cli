import {homedir} from 'node:os';
import {parseTOML,getStaticTOMLValue} from 'toml-eslint-parser';
import {parse,fail,ContractError,MAX_INPUT_BYTES} from '../contracts/parse.js';
import {contractDigest} from '../contracts/semantic.js';
import {absoluteRoot} from '../workspace/paths.js';
import {observeTargets} from '../operations/state.js';
import {readTOMLField} from '../operations/toml-fields.js';
import {utf8} from '../source/inventory.js';
import {readDesiredRecords,installedPath,pendingPath} from './records.js';
import {includeRetiredTargets} from './retirement.js';
import {inspectDesiredFiles} from './inventory.js';
import {parseDesiredWorkspace} from './source.js';
import {inspectDesiredLock} from './lock-recovery.js';

const paths={
  'codex.workspace':'.codex/config.toml','claude.workspace':'.claude/settings.local.json',
  'claude.mcp':'.mcp.json','grok.workspace':'.grok/config.toml','grok.user':'.grok/config.toml'
};
function field(bytes,setting) {
  if(bytes===null)return {present:false};
  if(bytes.length>MAX_INPUT_BYTES)fail('desired.config-size');
  if(['codex.workspace','grok.workspace'].includes(setting.target))return readTOMLField(bytes,setting.pointer);
  let value;
  if(setting.target==='grok.user') {
    try{value=getStaticTOMLValue(parseTOML(utf8(bytes),{tomlVersion:'1.0'}));}catch{fail('desired.config-syntax');}
  } else value=parse(utf8(bytes),'json');
  for(const part of setting.pointer.slice(1).split('/')) {
    if(value===null || typeof value!=='object' || Array.isArray(value))fail('desired.config-ancestor');
    if(!Object.hasOwn(value,part))return {present:false};
    value=value[part];
  }
  return {present:true,value};
}

// Read-only and local: no source fetch, lock, settings change, harness or MCP.
// null routes old-format installations to the existing doctor implementation.
export async function inspectDesiredInstallation(workspace,{userHome=homedir(),protectedPaths=[]}={}) {
  workspace=absoluteRoot(workspace);
  const markers=await observeTargets(workspace,[installedPath,pendingPath]);
  if(markers.every(item=>item.bytes===null))return null;
  const records=await readDesiredRecords(workspace),record=(records.pending??records.installed).value;
  if(record.intent==='removed')return {workspace,ready:false,status:'not-installed',
    pipeline:{...record.pipeline,providers:[]},binding:record.binding??null,configuration:'not-installed',
    diagnostics:[{code:'desired.not-installed',subject:installedPath}],globalSettings:'preserved',
    limits:'Delivery removed; saved workspace declaration and shared user settings were preserved. No runtime checks.'};
  const diagnostics=[];
  const locks=[];
  for(const global of [false,...(record.settings.some(s=>s.target==='grok.user')?[true]:[])]) {
    const target=global?'global':'workspace';
    try {
      const observed=await inspectDesiredLock(workspace,{userHome,global});
      locks.push({target,path:observed.path,status:observed.status});
      if(observed.status!=='absent')diagnostics.push({code:'desired.'+target+'-lock-present',subject:observed.path});
    }catch(error){
      locks.push({target,status:'unverified'});
      diagnostics.push({code:error instanceof ContractError?error.code:'desired.lock-read',subject:target+' lock'});
    }
  }
  const protectedRoots=new Set(protectedPaths);
  if(record.binding) {
    for(const repo of Object.values(record.binding.layout.repositories))protectedRoots.add(repo.path);
    try {
      const [entry]=await observeTargets(workspace,['workspace.json']);
      if(entry.bytes===null)diagnostics.push({code:'desired.workspace-missing',subject:'workspace.json'});
      else {
        const descriptor=parseDesiredWorkspace(utf8(entry.bytes));
        for(const repo of Object.values(descriptor.layout.repositories))protectedRoots.add(repo.path);
        if(contractDigest(descriptor.pipeline)!==contractDigest(record.binding.source) ||
            contractDigest(descriptor.layout)!==contractDigest(record.binding.layout) ||
            (record.adapters && contractDigest([...descriptor.adapters].sort())!==contractDigest([...record.adapters].sort())))
          diagnostics.push({code:'desired.workspace-different',subject:'workspace.json'});
      }
    }catch(error){
      diagnostics.push({code:'desired.workspace-invalid',subject:'workspace.json',
        reason:error instanceof ContractError?error.code:'desired.workspace-read'});
    }
  }
  const desired={scopes:record.scopes,entries:record.files};
  includeRetiredTargets(record,{settings:[]},desired,[...protectedRoots]);
  const files=await inspectDesiredFiles(workspace,desired);
  if(records.pending)diagnostics.push({code:'desired.installation-incomplete',subject:pendingPath});
  for(const [category,items] of Object.entries(files)) {
    if(!['extra','modified','missing','blocked'].includes(category))continue;
    for(const item of items)diagnostics.push({code:'desired.file-'+category,subject:item.path,...(item.reason?{reason:item.reason}:{})});
  }
  const cache=new Map(),settings=[];
  for(const setting of record.settings) {
    try {
      if(!cache.has(setting.target)) {
        const [observed]=await observeTargets(setting.target==='grok.user'?absoluteRoot(userHome):workspace,[paths[setting.target]]);
        cache.set(setting.target,observed.bytes);
      }
      const found=field(cache.get(setting.target),setting);
      const matches=setting.operation==='remove'?!found.present:found.present && contractDigest(found.value)===setting.valueHash;
      settings.push({target:setting.target,pointer:setting.pointer,status:matches?'pass':'different'});
      if(!matches)diagnostics.push({code:'desired.setting-different',subject:setting.target,pointer:setting.pointer});
    }catch(error){
      settings.push({target:setting.target,pointer:setting.pointer,status:'unverified'});
      diagnostics.push({code:error instanceof ContractError?error.code:'desired.config-read',subject:setting.target,pointer:setting.pointer});
    }
  }
  return {workspace,ready:diagnostics.length===0,status:records.pending?'incomplete':diagnostics.length?'drift':'ready',
    pipeline:{...record.pipeline,providers:record.providers},binding:record.binding??null,configuration:diagnostics.length?'fail':'pass',
    diagnostics,files,settings,locks,backupDefault:false,
    limits:'Installed-record comparison only; no source authenticity, runtime, model-visible skills or MCP certification.'};
}
