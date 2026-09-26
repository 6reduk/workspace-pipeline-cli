import path from 'node:path';
import {createHash} from 'node:crypto';
import {lstat,readdir,readFile} from 'node:fs/promises';
import {fail} from '../contracts/parse.js';
import {portablePath} from '../contracts/semantic.js';
import {absoluteRoot,inspectDirectory,resolveChild} from '../workspace/paths.js';

const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const order=(a,b)=>a.path<b.path?-1:a.path>b.path?1:0;
const maxFiles=10000,maxBytes=64*1024*1024;

// Compiled manifest and authenticated source map are supplied by the caller.
// This function performs no writes and copies source buffers before returning.
export function materializeDesiredFiles(compiled,source) {
  if(!compiled || compiled.schemaVersion!==2 || !Array.isArray(compiled.files) || !(source instanceof Map))fail('desired.input');
  const entries=new Map(),aliases=new Map();let bytes=0;
  function add(name,kind,content) {
    portablePath(name);
    const key=name.toLowerCase(),old=entries.get(name);
    if(aliases.has(key) && aliases.get(key)!==name)fail('desired.case-alias');
    if(old){if(kind==='directory' && old.kind===kind)return;fail('desired.materialized-overlap');}
    aliases.set(key,name);const entry={path:name,kind};
    if(kind==='file') {
      if(!Buffer.isBuffer(content))fail('desired.source-bytes');
      bytes+=content.length;if(bytes>maxBytes)fail('desired.byte-limit');
      entry.bytes=Buffer.from(content);entry.hash=hash(entry.bytes);
    }
    entries.set(name,entry);if(entries.size>maxFiles)fail('desired.file-limit');
  }
  for(const mapping of compiled.files) {
    portablePath(mapping.source);portablePath(mapping.target);
    if(mapping.kind==='file') {
      if(!source.has(mapping.source))fail('desired.source-missing');
      add(mapping.target,'file',source.get(mapping.source));
    } else if(mapping.kind==='directory') {
      add(mapping.target,'directory');let found=false;
      for(const [name,content] of source) {
        portablePath(name);if(!name.startsWith(mapping.source+'/'))continue;
        found=true;const suffix=name.slice(mapping.source.length+1),parts=suffix.split('/');
        for(let i=1;i<parts.length;i++)add(mapping.target+'/'+parts.slice(0,i).join('/'),'directory');
        add(mapping.target+'/'+suffix,'file',content);
      }
      // Git has no empty directory entries: a missing source must not become
      // an empty desired tree that deletes all installed contents.
      if(!found)fail('desired.source-missing');
    } else fail('desired.kind');
  }
  return {scopes:compiled.files.map(({target,kind})=>({path:target,kind})),entries:[...entries.values()].sort(order)};
}

// Read-only observation, not a lease or write authorization. Apply must hold
// its lock and recheck safety. Only declared file scopes are traversed.
export async function inspectDesiredFiles(workspace,desired) {
  workspace=absoluteRoot(workspace);
  if(!(await inspectDirectory(workspace)).exists)fail('desired.workspace-missing');
  const actual=new Map(),blocked=[];let totalBytes=0,count=0;
  async function visit(relative,absolute,depth=0) {
    if(++count>maxFiles || depth>64)fail('desired.file-limit');
    let stat;
    try{stat=await lstat(absolute);}catch(error){if(error.code==='ENOENT')return;throw error;}
    if(stat.isSymbolicLink()){blocked.push({path:relative,reason:'link'});return;}
    if(stat.isDirectory()) {
      await inspectDirectory(absolute);actual.set(relative,{path:relative,kind:'directory'});
      const names=await readdir(absolute),seen=new Set();
      for(const name of names.sort()) {
        const child=relative+'/'+name,key=name.toLowerCase();
        if(seen.has(key)){blocked.push({path:child,reason:'case-alias'});continue;}
        seen.add(key);
        if(key==='.git'){blocked.push({path:child,reason:'nested-repository'});continue;}
        await visit(child,path.join(absolute,name),depth+1);
      }
    } else if(stat.isFile()) {
      if(stat.nlink>1){blocked.push({path:relative,reason:'hardlink'});return;}
      totalBytes+=stat.size;if(totalBytes>maxBytes)fail('desired.byte-limit');
      const bytes=await readFile(absolute);
      if(bytes.length!==stat.size)fail('desired.observation-changed');
      actual.set(relative,{path:relative,kind:'file',hash:hash(bytes)});
    } else blocked.push({path:relative,reason:'special-file'});
  }
  for(const scope of desired.scopes) {
    const absolute=resolveChild(workspace,scope.path),parent=await inspectDirectory(path.dirname(absolute));
    if(!parent.exists)continue;
    const matches=(await readdir(parent.path)).filter(n=>n.toLowerCase()===path.basename(absolute).toLowerCase());
    if(matches.length>1 || (matches.length===1 && matches[0]!==path.basename(absolute))) {
      blocked.push({path:scope.path,reason:'case-alias'});continue;
    }
    await visit(scope.path,absolute);
  }
  const expected=new Map(desired.entries.map(e=>[e.path,e]));
  const extra=[],modified=[],missing=[],unchanged=[];
  for(const [name,want] of expected) {
    const have=actual.get(name);
    if(!have){missing.push({path:name,kind:want.kind});continue;}
    if(have.kind!==want.kind || (want.kind==='file' && have.hash!==want.hash))
      modified.push({path:name,kind:want.kind,currentKind:have.kind,beforeHash:have.hash??null,desiredHash:want.hash??null});
    else unchanged.push({path:name,kind:want.kind});
  }
  for(const [name,have] of actual)if(!expected.has(name))extra.push(have);
  return {extra:extra.sort(order),modified:modified.sort(order),missing:missing.sort(order),
    unchanged:unchanged.sort(order),blocked:blocked.sort(order),ready:blocked.length===0,
    backupDefault:false,scope:'declared-file-targets-only'};
}
