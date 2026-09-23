// Compiled user-profile policy, outside workspace ownership. Packages cannot
// choose global paths or arbitrary keys. No harness, model or MCP is launched.
import path from 'node:path';
import {homedir} from 'node:os';
import {lstat,readFile,mkdir,rename,unlink,open} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {parseTOML,getStaticTOMLValue} from 'toml-eslint-parser';
import {fail} from '../contracts/parse.js';
import {contractDigest} from '../contracts/semantic.js';
import {sha256,utf8} from '../source/inventory.js';
export const compatKeys=Object.freeze(['skills','rules','agents','mcps','hooks']);
const keys=node=>node.keys.map(k=>k.name??k.value);
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&!(v instanceof Date);
function document(bytes){
  if(bytes!==null&&(!Buffer.isBuffer(bytes)||bytes.length>1024*1024))fail('grok-compat.size');
  const text=bytes===null?'':utf8(bytes);
  let ast,value;try{ast=parseTOML(text,{tomlVersion:'1.0'});value=getStaticTOMLValue(ast);}catch{fail('grok-compat.syntax');}
  if(value.compat!==undefined&&!object(value.compat))fail('grok-compat.shape');
  if(value.compat?.claude!==undefined&&!object(value.compat.claude))fail('grok-compat.shape');
  if(value.claude_compat?.imported===true)fail('grok-compat.import-marker');
  for(const k of compatKeys)if(value.compat?.claude?.[k]!==undefined&&typeof value.compat.claude[k]!=='boolean')fail('grok-compat.shape');
  return {text,ast,value};
}
export function enableClaudeCompat(bytes){
  const {text,ast,value}=document(bytes),edits=[],seen=new Set();
  const changes=compatKeys.filter(k=>value.compat?.claude?.[k]!==true);
  if(!changes.length)return {bytes:bytes??Buffer.alloc(0),changes};
  let table=null,parentTable=null;
  function pair(node,base){
    const p=[...base,...keys(node.key)];if(p[0]!=='compat')return;
    if(p.length===1||(p.length===2&&p[1]==='claude'))fail('grok-compat.inline-ancestor');
    if(p.length===3&&p[1]==='claude'&&compatKeys.includes(p[2])){
      seen.add(p[2]);if(changes.includes(p[2]))edits.push([...node.value.range,'true']);
    }
  }
  for(const node of ast.body[0].body){
    if(node.type==='TOMLKeyValue')pair(node,[]);
    else if(node.type==='TOMLTable'){
      if(node.resolvedKey.join('.')==='compat.claude'){if(node.kind!=='standard')fail('grok-compat.shape');table=node;}
      if(node.resolvedKey.length===1&&node.resolvedKey[0]==='compat'){if(node.kind!=='standard')fail('grok-compat.shape');parentTable=node;}
      for(const item of node.body)pair(item,node.resolvedKey);
    }
  }
  const missing=compatKeys.filter(k=>!seen.has(k)),nl=text.includes('\r\n')?'\r\n':'\n';
  if(missing.length){
    const selected=table??parentTable;
    if(selected){const end=text.indexOf('\n',selected.key.range[1]),pos=end<0?text.length:end+1;
      edits.push([pos,pos,(end<0?nl:'')+missing.map(k=>`${table?'':'claude.'}${k} = true${nl}`).join('')]);
    }else edits.push([0,0,missing.map(k=>`compat.claude.${k} = true${nl}`).join('')]);
  }
  let result=text;for(const [start,end,replacement]of edits.sort((a,b)=>b[0]-a[0]))result=result.slice(0,start)+replacement+result.slice(end);
  const expected=structuredClone(value);expected.compat??={};expected.compat.claude??={};for(const k of compatKeys)expected.compat.claude[k]=true;
  // The strict decoder consumes a leading UTF-8 BOM; preserve it on re-encode.
  const bom=bytes?.subarray(0,3).equals(Buffer.from([0xef,0xbb,0xbf]));
  const output=Buffer.from((bom?'\uFEFF':'')+result);if(!isDeepStrictEqual(document(output).value,expected))fail('grok-compat.postcondition');
  return {bytes:output,changes};
}
async function stat(p){try{return await lstat(p);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function safe(p){
  let current=path.parse(p).root;
  for(const segment of path.relative(current,p).split(path.sep)){
    current=path.join(current,segment);const s=await stat(current);
    if(s&&(s.isSymbolicLink()||(!s.isDirectory()&&current!==p)))fail('grok-compat.path');
  }
}
async function read(p){
  await safe(p);const s=await stat(p);if(!s)return null;
  if(!s.isFile()||s.nlink!==1||s.size>1024*1024)fail('grok-compat.file');
  const bytes=await readFile(p),after=await lstat(p);
  if(after.ino!==s.ino||after.dev!==s.dev||after.size!==bytes.length||after.mtimeMs!==s.mtimeMs)fail('grok-compat.drift');
  return bytes;
}
const digest=b=>b===null?null:sha256(b);
async function record(p,value){const h=await open(p,'wx',0o600);try{await h.writeFile(JSON.stringify(value,null,2)+'\n');await h.sync();}finally{await h.close();}}
const warning='User-wide Claude compatibility affects every Grok workspace, including user hooks/MCP. Removing one workspace does not disable it.';
export function createClaudeCompatibility({env=process.env,home=homedir()}={}){
  function profile(){const base=env.GROK_HOME||path.join(env.USERPROFILE||env.HOME||home,'.grok');if(!path.isAbsolute(base))fail('grok-compat.home');return path.resolve(base);}
  async function executable(){
    const filename=process.platform==='win32'?'grok.exe':'grok';
    const candidates=[path.join(env.USERPROFILE||env.HOME||home,'.grok','bin',filename),...(env.PATH||'').split(path.delimiter).filter(p=>path.isAbsolute(p)).map(p=>path.join(p,filename))];
    for(const p of candidates)if((await stat(p))?.isFile())return p;return null;
  }
  async function inspect(){
    const base=profile(),target=path.join(base,'config.toml');await safe(base);
    if(!await stat(base)&&!await executable())return {kind:'grok-claude-prerequisite',profile:base,path:target,status:'not-present',beforeHash:null,resultHash:null,changes:[],blockers:[],warning};
    const before=await read(target),edited=enableClaudeCompat(before),blockers=[];
    for(const key of compatKeys){const name=`GROK_CLAUDE_${key.toUpperCase()}_ENABLED`;if(Object.keys(env).some(k=>k.toUpperCase()===name&&!['1','true'].includes(String(env[k]).toLowerCase())))blockers.push('environment:'+name);}
    for(const name of ['managed_config.toml','requirements.toml'])if(await stat(path.join(base,name)))blockers.push('policy:'+name);
    if(await stat(path.join(base,'workspace-pipeline-compat.lock')))blockers.push('global-lock');
    if(await stat(path.join(base,'workspace-pipeline-compat-recovery.lock')))blockers.push('global-recovery-lock');
    return {kind:'grok-claude-prerequisite',profile:base,path:target,status:blockers.length?'blocked':edited.changes.length?'needs-apply':'configured',beforeHash:digest(before),resultHash:digest(edited.bytes),changes:edited.changes,blockers,warning,verification:'config-only; native effective state and runtime not verified'};
  }
  async function check(expected){const actual=await inspect();if(contractDigest(actual)!==contractDigest(expected))fail('grok-compat.preview-drift');if(actual.status==='blocked')fail('grok-compat.blocked');return actual;}
  async function apply(expected){
    const plan=await check(expected);if(plan.status!=='needs-apply')return {...plan,changed:false};
    const base=profile(),lockPath=path.join(base,'workspace-pipeline-compat.lock');await safe(base);await mkdir(base,{recursive:true,mode:0o700});await safe(base);
    const token=randomUUID(),lock=await open(lockPath,'wx',0o600);let temporary,backupDir,lockBytes;
    try{
      lockBytes=Buffer.from(JSON.stringify({pid:process.pid,token,createdAt:new Date().toISOString()})+'\n');await lock.writeFile(lockBytes);await lock.sync();
      if(await stat(path.join(base,'workspace-pipeline-compat-recovery.lock')))fail('grok-compat.recovery-active');
      const before=await read(plan.path);if(digest(before)!==plan.beforeHash)fail('grok-compat.preview-drift');
      const output=enableClaudeCompat(before).bytes;if(digest(output)!==plan.resultHash)fail('grok-compat.preview-drift');
      backupDir=path.join(base,'workspace-pipeline-backups',token);await safe(backupDir);await mkdir(backupDir,{recursive:true,mode:0o700});
      if(before!==null){const b=await open(path.join(backupDir,'config.before.toml'),'wx',0o600);try{await b.writeFile(before);await b.sync();}finally{await b.close();}}
      if(before!==null&&digest(await read(path.join(backupDir,'config.before.toml')))!==plan.beforeHash)fail('grok-compat.backup');
      await record(path.join(backupDir,'operation.json'),{schemaVersion:1,kind:'grok-claude-compatibility',plan,pid:process.pid,token,scope:compatKeys,restoration:'Explicit only; never overwrite later user edits'});
      temporary=path.join(base,`workspace-pipeline-${token}.tmp`);const h=await open(temporary,'wx',0o600);try{await h.writeFile(output);await h.sync();}finally{await h.close();}
      if(digest(await read(plan.path))!==plan.beforeHash)fail('grok-compat.preview-drift');await rename(temporary,plan.path);temporary=null;
      if(digest(await read(plan.path))!==plan.resultHash)fail('grok-compat.readback');
      await record(path.join(backupDir,'completed.json'),{resultHash:plan.resultHash});
      return {...plan,status:'configured',changed:true,backupDir};
    }finally{await lock.close();if(temporary)await unlink(temporary).catch(()=>{});if(lockBytes&&(await read(lockPath))?.equals(lockBytes))await unlink(lockPath);}
  }
  async function recovery(){
    const base=profile(),lockPath=path.join(base,'workspace-pipeline-compat.lock'),bytes=await read(lockPath);
    if(bytes===null)fail('grok-compat.no-lock');
    let owner;try{owner=JSON.parse(utf8(bytes));}catch{fail('grok-compat.lock-record');}
    if(Object.keys(owner).sort().join(',')!=='createdAt,pid,token'||!Number.isSafeInteger(owner.pid)||owner.pid<1||
      !/^[a-f0-9-]{36}$/.test(owner.token)||typeof owner.createdAt!=='string')fail('grok-compat.lock-record');
    try{process.kill(owner.pid,0);fail('grok-compat.owner-running');}catch(e){if(e.code!=='ESRCH')throw e;}
    if(await stat(path.join(base,'workspace-pipeline-compat-recovery.lock')))fail('grok-compat.recovery-active');
    return {kind:'grok-compat-lock-recovery',profile:base,path:lockPath,lockHash:sha256(bytes),owner,
      configHash:digest(await read(path.join(base,'config.toml'))),backupDir:path.join(base,'workspace-pipeline-backups',owner.token),
      warning:'Removes only this dead-process installer lock. Does not restore or rewrite config, backups or workspace.'};
  }
  async function recover(expected){
    const actual=await recovery();if(contractDigest(actual)!==contractDigest(expected))fail('grok-compat.preview-drift');
    const guardPath=path.join(profile(),'workspace-pipeline-compat-recovery.lock'),guard=await open(guardPath,'wx',0o600);
    const guardBytes=Buffer.from(JSON.stringify({pid:process.pid,token:randomUUID()}));
    try{
      await guard.writeFile(guardBytes);await guard.sync();
      const bytes=await read(actual.path);if(digest(bytes)!==actual.lockHash||digest(await read(path.join(profile(),'config.toml')))!==actual.configHash)fail('grok-compat.preview-drift');
      try{process.kill(actual.owner.pid,0);fail('grok-compat.owner-running');}catch(e){if(e.code!=='ESRCH')throw e;}
      await unlink(actual.path);return {...actual,status:'lock-released',next:'Run repair preview/apply; preserve backups and inspect whether the prior config write completed.'};
    }finally{await guard.close();if((await read(guardPath))?.equals(guardBytes))await unlink(guardPath);}
  }
  async function verify(workspace){
    const binary=await executable();if(!binary)return {status:'not-available',runtime:'not-run'};
    if(!path.isAbsolute(workspace))fail('grok-compat.workspace');
    try{
      const {stdout}=await promisify(execFile)(binary,['inspect','--json'],{cwd:workspace,env,windowsHide:true,encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024});
      const data=JSON.parse(stdout),cells=data.externalCompat?.cells;
      const effective=compatKeys.map(surface=>({surface,enabled:Array.isArray(cells)&&cells.filter(c=>c.vendor==='claude'&&c.surface===surface).length===1&&cells.find(c=>c.vendor==='claude'&&c.surface===surface).enabled===true}));
      return {status:effective.every(c=>c.enabled)?'verified':'blocked',effective,projectTrusted:data.projectTrusted===true,
        runtime:'not-run',method:'native inspect only; no trust grant, model or MCP invocation'};
    }catch{return {status:'blocked',code:'grok-compat.native-inspect',runtime:'not-run'};}
  }
  return Object.freeze({inspect,check,apply,recovery,recover,verify});
}
