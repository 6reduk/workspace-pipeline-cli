import path from 'node:path';
import {parse,fail} from '../contracts/parse.js';
import {validateState} from '../contracts/semantic.js';
import {sha256,utf8} from '../source/inventory.js';
import {observeTargets} from '../operations/state.js';
import {writeCheckedFile,deleteCheckedFile} from '../operations/apply.js';

const configTargets={'.codex/config.toml':'codex.workspace','.claude/settings.local.json':'claude.workspace',
  '.mcp.json':'claude.mcp','.grok/config.toml':'grok.workspace'};

export function decodeLegacyState(workspace,bytes) {
  const value=parse(utf8(bytes),'json');validateState(value);
  if(path.resolve(value.workspace)!==path.resolve(workspace))fail('desired.legacy-workspace');
  if(value.pending!==null || !value.active || !['ready','drift','conflict'].includes(value.status))fail('desired.legacy-unfinished');
  const scopes=[],settings=[];
  for(const owned of value.active.owned) {
    if(owned.kind==='file')scopes.push({path:owned.path,kind:'file'});
    else {
      const target=configTargets[owned.path];
      if(!target)fail('desired.legacy-field-target');
      settings.push({target,pointer:owned.pointer,operation:'set',valueHash:owned.managedHash});
    }
  }
  return {value,bytes,hash:sha256(bytes),protectedPaths:Object.values(value.active.layout.repositories).map(repo=>repo.path),
    ownership:{pipeline:{id:value.active.pipelineId,version:value.active.version},scopes,settings}};
}

export async function retireLegacyState(lock,legacy) {
  if(!legacy)return;
  const history='.pipeline/history/state-v1-'+legacy.hash.slice(7)+'.json';
  const [existing]=await observeTargets(lock.workspace,[history]);
  if(existing.bytes===null)await writeCheckedFile(lock,history,null,legacy.bytes);
  else if(sha256(existing.bytes)!==legacy.hash)fail('desired.legacy-history-conflict');
  // Preserve the pre-existing operational record as history, not a backup of
  // overwritten adapter files. Original journals/snapshots are not rewritten.
  await deleteCheckedFile(lock,'.pipeline/state.json',legacy.hash,async()=>{});
}
