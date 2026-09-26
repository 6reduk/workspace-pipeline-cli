import {fail} from '../contracts/parse.js';
import {observeTargets} from '../operations/state.js';
import {sha256} from '../source/inventory.js';
import {compileDesiredSettings} from './settings.js';

const destinations=Object.freeze({
  'codex.workspace':'.codex/config.toml',
  'claude.workspace':'.claude/settings.local.json',
  'claude.mcp':'.mcp.json',
  'grok.workspace':'.grok/config.toml'
});

// Read and compile every configuration before any adapter file is deleted.
// Global configuration is intentionally not resolved through workspace paths.
export async function prepareLocalSettings(workspace,settings) {
  const groups=new Map();
  for(const operation of settings) {
    if(!Object.hasOwn(destinations,operation.target))fail('desired.global-settings-not-integrated');
    if(!groups.has(operation.target))groups.set(operation.target,[]);
    groups.get(operation.target).push(operation);
  }
  const observations=await observeTargets(workspace,[...groups.keys()].map(key=>destinations[key]));
  const result=[];
  for(const [target,operations] of groups) {
    const relative=destinations[target],before=observations.find(o=>o.path===relative).bytes;
    const edited=compileDesiredSettings(target,before,operations);
    result.push({path:relative,beforeHash:before===null?null:sha256(before),
      bytes:edited.bytes,afterHash:sha256(edited.bytes),changed:edited.changed});
  }
  return result;
}

export async function checkLocalSettings(workspace,prepared) {
  const observed=await observeTargets(workspace,prepared.map(item=>item.path));
  for(const item of prepared) {
    const current=observed.find(o=>o.path===item.path);
    if((current.bytes===null?null:sha256(current.bytes))!==item.beforeHash)fail('desired.config-changed');
  }
  return observed;
}
