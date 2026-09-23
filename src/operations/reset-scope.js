import {opendir,lstat} from 'node:fs/promises';
import {resolveChild,inspectDirectory} from '../workspace/paths.js';
import {portablePath,contractDigest} from '../contracts/semantic.js';
import {fail} from '../contracts/parse.js';
import {cap,LIMITS,sha256} from '../source/inventory.js';
import {removedWithProviders} from '../providers/common-entry.js';

// Installer policy, never paths supplied by a pipeline package. Entire provider
// dot-directories, authentication, permissions and models are NOT reset surfaces.
const surfaces={
  codex:{trees:['.agents/skills','.codex/agents'],fields:{'.codex/config.toml':['/agents','/mcp_servers']}},
  claude:{trees:['.claude/skills','.claude/agents'],fields:{'.mcp.json':['/mcpServers']}},
  grok:{trees:['.grok/skills','.grok/agents'],fields:{'.grok/config.toml':['/mcp_servers']}},
  kimi:{trees:['.kimi-code/skills','.kimi-code/agents'],fields:{'.kimi-code/mcp.json':['/mcpServers']}}
};
export function resetScope(active,selection) {
  const trees=[],fields={};
  for(const id of selection.providers){
    if(!Object.hasOwn(surfaces,id))fail('reset.provider');
    trees.push(...surfaces[id].trees);Object.assign(fields,surfaces[id].fields);
  }
  if(active.owned.some(o=>o.kind==='file' && o.owner==='shared' && removedWithProviders(o,selection) && !['AGENTS.md','CLAUDE.md'].includes(o.path)))fail('reset.shared-scope');
  const files=active.owned.filter(o=>o.kind==='file' && ['AGENTS.md','CLAUDE.md'].includes(o.path) && removedWithProviders(o,selection)).map(o=>o.path);
  return {trees:trees.sort(),fields,files:[...new Set(files)].sort()};
}
export function scopeOwns(scope,name){
  return scope.files.includes(name) || Object.hasOwn(scope.fields,name) || scope.trees.some(t=>name.startsWith(t+'/'));
}
export function scopeOwnsRecord(scope,owned){
  if(!scopeOwns(scope,owned.path))return false;
  return owned.kind==='file'?!Object.hasOwn(scope.fields,owned.path):
    (scope.fields[owned.path]??[]).some(p=>owned.pointer===p || owned.pointer.startsWith(p+'/'));
}
export async function scanResetTrees(workspace,scope){
  const files=[],directories=[],seen=new Set();let count=0;
  async function walk(relative){
    cap(++count,LIMITS.files,'reset.count');
    const full=resolveChild(workspace,relative);
    if(!(await inspectDirectory(full)).exists)return;
    directories.push(relative);
    for await(const entry of await opendir(full)){
      cap(++count,LIMITS.files,'reset.count');
      const name=relative+'/'+entry.name;portablePath(name);
      if(['.git','.pipeline'].includes(entry.name.toLowerCase()))fail('reset.protected-tree');
      const folded=name.toLowerCase();if(seen.has(folded))fail('reset.case-alias');seen.add(folded);
      const stat=await lstat(resolveChild(workspace,name));
      if(stat.isSymbolicLink())fail('reset.link');
      if(stat.isDirectory())await walk(name);
      else if(stat.isFile() && stat.nlink===1)files.push(name);
      else fail('reset.file-type');
    }
  }
  for(const tree of scope.trees)await walk(tree);
  return {files:files.sort(),directories:directories.sort()};
}
// During recovery allow only the approved before/result pathname union. Unknown
// files require a new decision; reset never expands deletion authority silently.
export async function assertResetTreeScope(workspace,reset,plan,final=false){
  const actual=await scanResetTrees(workspace,reset.scope);
  const allowed=new Set(reset.tree.files);
  for(const t of plan.targets)if(reset.scope.trees.some(p=>t.path.startsWith(p+'/'))){
    if(t.desiredHash!==null)allowed.add(t.path);else if(final)allowed.delete(t.path);
  }
  if(actual.files.some(p=>!allowed.has(p)) || (final && (actual.files.length!==allowed.size || [...allowed].some(p=>!actual.files.includes(p)))))fail('reset.tree-drift');
  const allowedDirs=new Set(reset.tree.directories);
  for(const name of allowed){
    for(const tree of reset.scope.trees)if(name.startsWith(tree+'/')){
      let parent=name.slice(0,name.lastIndexOf('/'));
      while(parent.length>=tree.length){allowedDirs.add(parent);parent=parent.slice(0,parent.lastIndexOf('/'));}
    }
  }
  if(actual.directories.some(p=>!allowedDirs.has(p)))fail('reset.tree-drift');
}
export function resetBackupManifest(preview,selection,mode){
  const seed=contractDigest({plan:preview.plan,selection,mode});
  const directory='.pipeline/backups/reset/'+seed.slice(7);
  const backup={directory,files:preview.plan.targets.filter(t=>t.beforeHash!==null).map((t,i)=>({
    source:t.path,path:directory+'/'+i+'.bin',hash:t.beforeHash
  }))};
  return {...backup,manifest:{path:directory+'/manifest.json',hash:sha256(resetBackupBytes(backup))}};
}
export const resetBackupBytes=backup=>Buffer.from(JSON.stringify({schemaVersion:1,files:backup.files},null,2)+'\n');
