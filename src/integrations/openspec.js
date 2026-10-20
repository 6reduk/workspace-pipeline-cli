import path from 'node:path';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,readdir,lstat,unlink,rmdir,mkdtemp} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fail,parse,ContractError} from '../contracts/parse.js';
import {inspectDirectory} from '../workspace/paths.js';
import {assertLockHeld} from '../operations/lock.js';
import {compileStore,prepareStore,storeIntents,storeSummary,applyStoreKeys,inspectStoreRegistry,storeFile} from './openspec-store.js';

export const OPENSPEC_VERSION='1.14.1';
const integrity='sha512-IU9ggB7UYMDU47S0R59NH2ngJp+CK2X/r1B8+QU2Fm8LLBPFatQRO1Ia7B8nO3FHbTE7xRXAIs9NcuUF8Beeag==';
const home='.pipeline/openspec',recordPath=home+'/installation.json';
// Observed npm paths include @scopes and non-manifest filenames. Keep the same
// containment boundary without weakening the public manifest path grammar.
function resolveChild(root,relative){
  if(relative!=='.'&&(typeof relative!=='string'||/[\\:\u0000-\u001f\u007f]/.test(relative)||
    relative.split('/').some(p=>!p||p==='.'||p==='..'||p.toLowerCase()==='.git')))fail('openspec.path');
  const target=path.resolve(root,...relative.split('/')),rel=path.relative(root,target);
  if(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))fail('openspec.path');
  return target;
}
export const skillNames=['apply-change','archive-change','explore','propose','sync-specs','update-change'].map(n=>'openspec-'+n);
const digest=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
const overlap=(a,b)=>a===b||a.startsWith(b+'/')||b.startsWith(a+'/');
const allScopes=['.agents/skills/.openspec-target',...['.agents','.claude'].flatMap(p=>skillNames.map(n=>`${p}/skills/${n}`))];
export function openSpecPlan(compiled,binding) {
  if(!compiled.openspec)return null;
  const spec=compiled.openspec;
  if(spec.version!==OPENSPEC_VERSION)fail('openspec.unsupported-version');
  const repository=binding?.layout?.repositories?.[spec.repository];
  if(!repository)fail('openspec.repository');
  const tools=[...(compiled.providers.includes('codex')?['codex']:[]),...(compiled.providers.some(p=>p==='claude'||p==='grok')?['claude']:[])];
  if(!tools.length||compiled.providers.includes('kimi'))fail('openspec.unsupported-provider');
  const scopes=tools.flatMap(t=>skillNames.map(n=>`${t==='codex'?'.agents':'.claude'}/skills/${n}`));
  if(tools.includes('codex'))scopes.push('.agents/skills/.openspec-target');
  for(const mapping of compiled.files)if(scopes.some(s=>overlap(s.toLowerCase(),mapping.target.toLowerCase())))fail('openspec.owner-overlap');
  const store=compileStore(spec.store,binding,repository.path,compiled.files);
  return {version:spec.version,repository:spec.repository,root:repository.path,tools,scopes:scopes.sort(),...(store?{store}:{})};
}
export function openSpecContext(records,binding){
  const previous=records?.installed?.value,initial=records?.pending?.value;
  const selected=binding??previous?.binding??initial?.binding;
  const previousPlan=previous?.openspec&&previous.intent!=='removed'?openSpecPlan({openspec:previous.openspec,providers:previous.providers,files:[]},previous.binding):null;
  return {binding:selected,previousBinding:previous?.binding,previousPlan};
}
async function checkedFile(root,relative){
  const f=resolveChild(root,relative);await inspectDirectory(path.dirname(f));
  try{const s=await lstat(f);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)fail('openspec.unsafe-file');}
  catch(e){if(e.code==='ENOENT')return null;throw e;}
  return readFile(f);
}
async function put(root,relative,bytes){
  const f=resolveChild(root,relative);await checkedFile(root,relative);
  await mkdir(path.dirname(f),{recursive:true});await inspectDirectory(path.dirname(f));
  await writeFile(f,bytes,{mode:0o600});
}
async function readRecord(root){
  const bytes=await checkedFile(root,recordPath);if(bytes===null)return null;
  const r=parse(bytes.toString('utf8'),'json');
  if(![1,2].includes(r.schemaVersion)||!['pending','ready','removed'].includes(r.status)||!Array.isArray(r.scopes)||
    (r.dependencyLockHash!=null&&!/^sha256:[a-f0-9]{64}$/.test(r.dependencyLockHash))||
    r.scopes.some(s=>!allScopes.includes(s))||new Set(r.scopes).size!==r.scopes.length||
    !Array.isArray(r.files)||r.files.some(f=>typeof f.path!=='string'||!/^sha256:[a-f0-9]{64}$/.test(f.hash)||
      !(r.scopes.some(s=>f.path===s||f.path.startsWith(s+'/'))||f.path===home+'/README.md')))fail('openspec.record');
  for(const f of r.files)resolveChild(root,f.path);
  if(r.schemaVersion===1&&(r.storeBindings||r.storeIdentity||r.plan?.store))fail('openspec.record');
  if(r.schemaVersion===2&&(!Array.isArray(r.storeBindings)||r.storeBindings.length>512))fail('openspec.record');
  return r;
}
export async function preflightOpenSpec(root,plan,compiled,context={}){
  const old=await readRecord(root);
  if(!old&&(await inspectDirectory(resolveChild(root,home))).exists&&(await readdir(resolveChild(root,home))).length)
    fail('openspec.foreign-runtime');
  for(const scope of old?.scopes??[])for(const f of compiled?.files??[])
    if(overlap(scope.toLowerCase(),f.target.toLowerCase()))fail('openspec.owner-overlap');
  if(plan){
    if(!(await inspectDirectory(resolveChild(root,plan.root))).exists)fail('openspec.project-missing');
    for(const scope of plan.scopes){
      if(!old?.scopes.includes(scope)&&(await tree(root,scope)).length)fail('openspec.foreign-integration');
    }
    const prefix=(plan.root==='.'?'':plan.root+'/')+'openspec';
    await checkedFile(root,prefix+'/config.yaml');
    for(const n of ['specs','changes'])await inspectDirectory(resolveChild(root,prefix+'/'+n));
  }
  for(const scope of old?.scopes??[])await tree(root,scope);
  await prepareStore(root,plan,old,context);
  return old;
}
export async function describeOpenSpecStore(root,plan,context={}){
  return storeSummary(await prepareStore(root,plan,await readRecord(root),context));
}
// Inspection only: absence of ownership metadata never authorizes deletion.
export async function inspectRemovedOpenSpec(root){
  const diagnostics=[];
  for(const scope of allScopes){
    try{
      await inspectDirectory(path.dirname(resolveChild(root,scope)));
      await lstat(resolveChild(root,scope));
      diagnostics.push({code:'openspec.removal-residue',subject:scope});
    }catch(e){if(e.code!=='ENOENT')diagnostics.push({code:e.code??'openspec.inspection',subject:scope});}
  }
  return diagnostics;
}
export async function assertOpenSpecRemoval(root,context={}){
  const old=await preflightOpenSpec(root,null,undefined,context);
  if((!old||old.status==='removed')&&(await inspectRemovedOpenSpec(root)).length)
    fail('openspec.removal-residue');
}
async function tree(root,relative){
  const files=[];let count=0,total=0;
  async function visit(p){
    if(++count>5000)fail('openspec.file-limit');
    const file=resolveChild(root,p);await inspectDirectory(path.dirname(file));let s;
    try{s=await lstat(file);}catch(e){if(e.code==='ENOENT')return;throw e;}
    if(s.isSymbolicLink()||(!s.isFile()&&!s.isDirectory())||(s.isFile()&&s.nlink!==1))fail('openspec.unsafe-file');
    if(s.isDirectory()){for(const n of await readdir(file))await visit(p+'/'+n);}
    else{total+=s.size;if(total>16*1024*1024)fail('openspec.byte-limit');files.push({path:p,bytes:await readFile(file)});}
  }
  await visit(relative);return files;
}
// Fixed roots only, enumerated deletion; never traverse npm .bin symlinks.
async function erase(root,relative,{runtime=false}={}){
  if(!runtime&&!allScopes.includes(relative))fail('openspec.delete-scope');
  if(runtime&&!['tool','stage','config','data'].some(n=>relative===home+'/'+n))fail('openspec.delete-scope');
  async function visit(p){
    const f=resolveChild(root,p);await inspectDirectory(path.dirname(f));let s;
    try{s=await lstat(f);}catch(e){if(e.code==='ENOENT')return;throw e;}
    if(s.isSymbolicLink()){if(!runtime)fail('openspec.unsafe-file');await unlink(f);return;}
    if(s.isDirectory()){for(const n of await readdir(f))await visit(p+'/'+n);await rmdir(f);}
    else if(s.isFile())await unlink(f);else fail('openspec.unsafe-file');
  }
  await visit(relative);
}
export async function execute(command,args,{cwd,env}){
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let size=0,reason=null,stderr='';
    const timeout=setTimeout(()=>{reason='openspec.command-timeout';child.kill();},180000);
    for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{size+=b.length;if(size>4*1024*1024){reason='openspec.output-limit';child.kill();}});
    child.stderr.on('data',b=>{stderr=(stderr+b.toString('utf8')).slice(-4096);});
    child.on('error',e=>{clearTimeout(timeout);reject(Object.assign(new Error('OpenSpec command failed'),{code:'openspec.command-start',cause:e}));});
    child.on('close',code=>{clearTimeout(timeout);if(reason||code!==0){
      // Only known error identifiers may leave the subprocess boundary. Raw
      // output may contain URLs, credentials or user paths despite empty npmrc.
      const known=stderr.match(/\b(?:EAI_AGAIN|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|E401|E403|E404|EINTEGRITY|ENOSPC|EACCES|EPERM)\b/);
      reject(Object.assign(new Error('OpenSpec command failed'),{code:reason??'openspec.command-failed',
        commandDiagnostic:{phase:['ci','install'].includes(args[1])?'npm-install':'openspec-init',exitCode:code,reason:known?.[0]??'unclassified'}}));
    }else resolve();});
  });
}
function isolatedEnv(root){return {...process.env,XDG_CONFIG_HOME:resolveChild(root,home+'/config'),
  XDG_DATA_HOME:resolveChild(root,home+'/data'),OPENSPEC_TELEMETRY:'0',OPENSPEC_NO_UPDATE_CHECK:'1'};}
async function preparePackage(root,run){
  const lock=await checkedFile(root,home+'/dependency-lock.json');
  if(lock!==null&&parse(lock.toString('utf8'),'json').packages?.['node_modules/@fission-ai/openspec']?.integrity!==integrity)fail('openspec.package-lock');
  // Rebuild from the previous dependency lock, not a potentially modified runtime.
  await erase(root,home+'/tool',{runtime:true});
  const tool=resolveChild(root,home+'/tool');await mkdir(tool,{recursive:true});
  await put(root,home+'/tool/package.json',Buffer.from(JSON.stringify({private:true,dependencies:{'@fission-ai/openspec':OPENSPEC_VERSION}})));
  if(lock!==null)await put(root,home+'/tool/package-lock.json',lock);
  const npm=process.env.npm_execpath?.endsWith('npm-cli.js')?process.env.npm_execpath:path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
  try{await readFile(npm);}catch{fail('openspec.npm-unavailable');}
  for(const f of ['empty.npmrc','empty-global.npmrc'])await put(root,home+'/'+f,Buffer.from(''));
  const flags=['--ignore-scripts','--no-audit','--no-fund','--fetch-retries=0','--fetch-timeout=30000',
    '--registry=https://registry.npmjs.org','--prefix',tool,'--userconfig',resolveChild(root,home+'/empty.npmrc'),
    '--globalconfig',resolveChild(root,home+'/empty-global.npmrc')];
  await run(process.execPath,[npm,lock?'ci':'install',...flags],{cwd:tool,env:isolatedEnv(root)});
  const value=parse((await checkedFile(root,home+'/tool/package-lock.json')).toString('utf8'),'json');
  const pkg=parse((await checkedFile(root,home+'/tool/node_modules/@fission-ai/openspec/package.json')).toString('utf8'),'json');
  if(value.packages?.['node_modules/@fission-ai/openspec']?.integrity!==integrity||pkg.version!==OPENSPEC_VERSION)fail('openspec.package-integrity');
  await put(root,home+'/dependency-lock.json',await checkedFile(root,home+'/tool/package-lock.json'));
}
export async function syncOpenSpec(lock,plan,{backup=false,openSpecRun=execute,boundary,...context}={}){
  const root=lock.workspace,old=await preflightOpenSpec(root,plan,undefined,context);
  if(!plan)await assertOpenSpecRemoval(root,context);
  if(!plan&&!old)return null;
  if(!plan&&old.status==='removed')return {status:'removed'};
  await assertLockHeld(lock);
  if(plan&&old?.dependencyLockHash){
    const saved=await checkedFile(root,home+'/dependency-lock.json');
    if(saved===null||digest(saved)!==old.dependencyLockHash)fail('openspec.lock-drift');
  }
  const scopes=[...new Set([...(old?.scopes??[]),...(plan?.scopes??[])])];
  const prepared=await prepareStore(root,plan,old,context);
  const recordVersion=prepared||old?.schemaVersion===2?2:1;
  const extra=recordVersion===2?{storeBindings:storeIntents(prepared),storeIdentity:prepared?{id:prepared.id,path:prepared.identityPath,hash:prepared.identityHash}:null}:{};
  for(const scope of scopes)await tree(root,scope);
  await put(root,recordPath,Buffer.from(JSON.stringify({schemaVersion:recordVersion,status:'pending',plan,scopes,files:old?.files??[],dependencyLockHash:old?.dependencyLockHash??null,...extra},null,2)+'\n'));
  await boundary?.('openspec-after-pending');
  let backupDirectory=null;
  if(backup&&(scopes.length||prepared?.edits.length)){
    const parent=resolveChild(root,'.pipeline/backups');await inspectDirectory(parent);await mkdir(parent,{recursive:true});
    backupDirectory=await mkdtemp(path.join(parent,'openspec-'));
    for(const scope of scopes)for(const f of await tree(root,scope)){
      await mkdir(path.dirname(path.join(backupDirectory,f.path)),{recursive:true});await writeFile(path.join(backupDirectory,f.path),f.bytes,{flag:'wx',mode:0o600});
    }
  }
  const files=[];
  if(plan){
    await preparePackage(root,openSpecRun);
    await put(root,home+'/config/openspec/config.json',Buffer.from(JSON.stringify({profile:'core',delivery:'skills',telemetry:{enabled:false}})));
    await erase(root,home+'/stage',{runtime:true});
    const stage=resolveChild(root,home+'/stage');await mkdir(stage,{recursive:true});
    await openSpecRun(process.execPath,[resolveChild(root,home+'/tool/node_modules/@fission-ai/openspec/bin/openspec.js'),
      'init','--tools',plan.tools.join(','),'--profile','core','--no-animation'],{cwd:stage,env:isolatedEnv(root)});
    for(const scope of plan.scopes){const entries=await tree(stage,scope);if(!entries.length)fail('openspec.generated-missing');files.push(...entries);}
    const config=(plan.root==='.'?'':plan.root+'/')+'openspec/config.yaml';
    if(await checkedFile(root,config)===null)await put(root,config,Buffer.from('schema: spec-driven\n'));
    for(const name of ['specs','changes']){const dir=resolveChild(root,(plan.root==='.'?'':plan.root+'/')+'openspec/'+name);await inspectDirectory(dir);await mkdir(dir,{recursive:true});}
    if(plan.store){
      if(digestNullable(await storeFile(root,prepared.identityPath))!==prepared.identityHash)fail('openspec.store-config-changed');
      // The registry is private derived state. Recreate it to repair moved workspaces.
      await erase(root,home+'/data',{runtime:true});
      await openSpecRun(process.execPath,[resolveChild(root,home+'/tool/node_modules/@fission-ai/openspec/bin/openspec.js'),
        'store','register',resolveChild(root,plan.root),'--id',plan.store.id,'--yes','--json'],{cwd:resolveChild(root,plan.root),env:isolatedEnv(root)});
      await boundary?.('openspec-after-register');
      const observed=await prepareStore(root,plan,await readRecord(root),context);
      if(!observed?.identityHash)fail('openspec.store-identity-conflict');
      extra.storeIdentity={id:prepared.id,path:prepared.identityPath,hash:observed.identityHash};
      await inspectStoreRegistry(root,prepared);
    }else if(prepared)await erase(root,home+'/data',{runtime:true});
    const prefix=path.relative(resolveChild(root,plan.root),resolveChild(root,home+'/tool')).replaceAll('\\','/');
    files.push({path:home+'/README.md',bytes:Buffer.from(`# Local OpenSpec ${plan.version}\n\n`+
      (plan.store?`For planning use repository \`${plan.root}\`; for implementation use the explicitly selected service below, never the wrapper.\n`:`Run OpenSpec commands from repository \`${plan.root}\`, not the wrapper.\n`)+
      `Use \`npm exec --prefix "${prefix}" --offline -- openspec <arguments>\` for upstream CLI examples.\n`+
      'Do not patch generated skills. Do not initialize a second root in the wrapper.\n'+
      `For this command process only: OPENSPEC_TELEMETRY=0, OPENSPEC_NO_UPDATE_CHECK=1; `+
      `XDG_CONFIG_HOME and XDG_DATA_HOME are the wrapper's ${home}/config and ${home}/data.\n`+
      'Specs, changes and project config are user documents, not replaceable adapter files.\n')});
    if(plan.store){
      const route=files.find(f=>f.path===home+'/README.md');
      route.bytes=Buffer.concat([route.bytes,Buffer.from('\n## Shared store '+plan.store.id+'\n\nPlanning repository: `'+plan.repository+'` (`'+plan.root+'`).\n'+
        plan.store.bindings.map(b=>`- ${b.repository}: cwd \`${b.root}\`; \`npm exec --prefix "${path.relative(resolveChild(root,b.root),resolveChild(root,home+'/tool')).replaceAll('\\','/')}" --offline -- openspec <arguments>\``).join('\n')+
        '\nSelect the explicitly authorized service before implementation. Never choose a service from wrapper cwd or infer expanded scope from shared tasks. After switching cwd, reread status/instructions and record repo, task, blockers, checks and next step in the existing handoff. Tasks are shared, not automatically filtered.\n')]);
    }
  }
  await applyStoreKeys(lock,prepared,{backupDirectory,boundary});
  await assertLockHeld(lock);
  for(const scope of scopes)await erase(root,scope);
  for(const f of files)await put(root,f.path,f.bytes);
  if(!plan){
    for(const dir of ['tool','stage','config','data'])await erase(root,home+'/'+dir,{runtime:true});
    for(const file of ['README.md','dependency-lock.json','empty.npmrc','empty-global.npmrc'])
      if(await checkedFile(root,home+'/'+file)!==null)await unlink(resolveChild(root,home+'/'+file));
  }
  for(const f of files)if(digest(await checkedFile(root,f.path))!==digest(f.bytes))fail('openspec.readback');
  const dependencyLockHash=plan?digest(await checkedFile(root,home+'/dependency-lock.json')):null;
  await boundary?.('openspec-before-ready');
  if(prepared){
    const verified=await prepareStore(root,plan,await readRecord(root),context);
    for(const e of verified.edits)if(digestNullable(e.bytes)!==e.resultHash)fail('openspec.readback');
    if(plan?.store){
      if(verified.identityHash!==extra.storeIdentity.hash)fail('openspec.store-identity-conflict');
      await inspectStoreRegistry(root,verified);
    }
  }
  if(recordVersion===2){
    extra.storeBindings=(prepared?.edits??[]).filter(e=>e.active).map(({repository,path,key,value,ownership})=>({repository,path,key,value,ownership}));
    extra.retiredBindings=storeIntents(prepared).filter(e=>!(prepared?.edits.find(b=>b.repository===e.repository)?.active));
  }
  await put(root,recordPath,Buffer.from(JSON.stringify({schemaVersion:recordVersion,status:plan?'ready':'removed',plan,scopes:plan?.scopes??[],files:files.map(f=>({path:f.path,hash:digest(f.bytes)})),dependencyLockHash,...extra},null,2)+'\n'));
  return {status:plan?'ready':'removed',version:plan?.version,backupDirectory,...(prepared?{store:storeSummary(prepared)}:{})};
}
const digestNullable=b=>b===null?null:digest(b);
export async function inspectOpenSpec(root,expected,binding,providers){
  const diagnostics=[];let record,store;
  try{
    record=await readRecord(root);
    if(!expected&&(!record||record.status==='removed'))return null;
    if(!record||record.status!=='ready')fail('openspec.incomplete');
    if(!expected||record.plan?.version!==expected.version||record.plan?.repository!==expected.repository)fail('openspec.declaration-different');
    const desired=openSpecPlan({openspec:expected,providers,files:[]},binding);
    if(JSON.stringify(record.plan.store)!==JSON.stringify(desired.store))fail('openspec.declaration-different');
    if(desired.store){
      const prepared=await prepareStore(root,desired,record,{binding,previousPlan:desired});store=storeSummary(prepared);
      if(!prepared.identityHash||prepared.identityHash!==record.storeIdentity?.hash)throw Object.assign(new ContractError('openspec.store-identity-conflict'),{
        subject:prepared.identityPath,repository:prepared.repository,
        hint:'Inspect the store identity change against the installed record. Restore the intended identity or explicitly reconcile it before repeating update. Preserve planning documents; do not delete ownership records.'});
      for(const e of prepared.edits)if(e.beforeHash!==e.resultHash)diagnostics.push({code:'openspec.store-config-drift',subject:e.path,repository:e.repository,
        hint:'Inspect the owned store key at this path. Run update to restore the declared value; use --backup if you need a copy of the current configuration. Unrelated YAML fields are preserved.'});
      await inspectStoreRegistry(root,prepared);
    }
    if(record.plan.root!==desired.root||JSON.stringify(record.scopes)!==JSON.stringify(desired.scopes))fail('openspec.declaration-different');
    for(const scope of desired.scopes){
      const required=scope.endsWith('.openspec-target')?scope:scope+'/SKILL.md';
      if(!record.files.some(f=>f.path===required))fail('openspec.record');
    }
    if(!record.files.some(f=>f.path===home+'/README.md'))fail('openspec.record');
    const savedLock=await checkedFile(root,home+'/dependency-lock.json');
    if(savedLock===null||digest(savedLock)!==record.dependencyLockHash)fail('openspec.lock-drift');
    for(const f of record.files){const b=await checkedFile(root,f.path);if(b===null||digest(b)!==f.hash)diagnostics.push({code:'openspec.file-different',subject:f.path});}
    for(const scope of record.scopes)for(const f of await tree(root,scope))if(!record.files.some(e=>e.path===f.path))diagnostics.push({code:'openspec.file-extra',subject:f.path});
    const b=await checkedFile(root,home+'/tool/package-lock.json');
    if(b===null||digest(b)!==record.dependencyLockHash||parse(b.toString('utf8'),'json').packages?.['node_modules/@fission-ai/openspec']?.integrity!==integrity)fail('openspec.package-lock');
    const p=await checkedFile(root,home+'/tool/node_modules/@fission-ai/openspec/package.json');
    if(p===null||parse(p.toString('utf8'),'json').version!==expected.version)fail('openspec.package-missing');
    if(await checkedFile(root,home+'/tool/node_modules/@fission-ai/openspec/bin/openspec.js')===null)fail('openspec.package-missing');
  }catch(e){diagnostics.push({code:e.code??'openspec.inspection',subject:e.subject??recordPath,...(e.repository?{repository:e.repository}:{}),...(e.hint?{hint:e.hint}:{})});}
  return {version:expected?.version??record?.plan?.version,status:diagnostics.length?'not-ready':'ready',diagnostics,...(store?{store}:{}),
    limits:'Metadata and generated files only; not full node_modules integrity or model/runtime certification.'};
}
