import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,mkdir,writeFile,readFile,rm,access,readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {stringify} from 'yaml';
import {applyDesiredFiles} from '../src/desired-state/apply-files.js';
import {inspectDesiredInstallation} from '../src/desired-state/doctor.js';
import {openSpecPlan,skillNames} from '../src/integrations/openspec.js';
import {compileDesiredManifest} from '../src/contracts/desired-state.js';
import {editStoreKey,prepareStore} from '../src/integrations/openspec-store.js';
import {contractDigest} from '../src/contracts/semantic.js';
import {sha256} from '../src/source/inventory.js';
const integrity='sha512-IU9ggB7UYMDU47S0R59NH2ngJp+CK2X/r1B8+QU2Fm8LLBPFatQRO1Ia7B8nO3FHbTE7xRXAIs9NcuUF8Beeag==';
async function put(root,name,bytes){await mkdir(path.dirname(path.join(root,name)),{recursive:true});await writeFile(path.join(root,name),bytes);}
const manifest=()=>({schemaVersion:2,id:'probe',version:'1.0.0',integrations:{openspec:{version:'1.14.1',repository:'docs',store:{id:'shared',implementationRepositories:['b','a']}}},adapters:{codex:{providers:['codex'],files:[{source:'entry',target:'AGENTS.md',kind:'file'}],settings:[]}}});
async function fixture(t){
  const workspace=await mkdtemp(path.join(os.tmpdir(),'wpc-store-'));t.after(()=>rm(workspace,{recursive:true,force:true}));
  const source=new Map([['entry',Buffer.from('synthetic')]]);
  for(const name of ['docs','a','b'])await mkdir(path.join(workspace,name));
  const binding={source:{type:'git',transport:'local',path:'../source',ref:'main',subdirectory:'.'},commit:'a'.repeat(40),digest:contractDigest(Object.fromEntries([...source].map(([p,b])=>[p,sha256(b)]))),
    layout:{kind:'multi-repo',repositories:{docs:{path:'docs',role:'documentation'},a:{path:'a',role:'code'},b:{path:'b',role:'library'}},documentation:{repository:'docs',path:'docs'}}};
  return {workspace,source,binding,manifest:JSON.stringify(manifest()),selected:['codex'],protectedPaths:['docs','a','b']};
}
async function runner(command,args,{cwd,env}){
  assert.equal(env.OPENSPEC_TELEMETRY,'0');assert.equal(env.OPENSPEC_NO_UPDATE_CHECK,'1');
  if(['install','ci'].includes(args[1])){
    await put(cwd,'package-lock.json',JSON.stringify({packages:{'node_modules/@fission-ai/openspec':{version:'1.14.1',integrity}}}));
    await put(cwd,'node_modules/@fission-ai/openspec/package.json',JSON.stringify({version:'1.14.1'}));
    await put(cwd,'node_modules/@fission-ai/openspec/bin/openspec.js','// synthetic');return;
  }
  if(args[1]==='store'){
    assert.deepEqual(args.slice(1,3),['store','register']);assert.ok(args.includes('--yes'));assert.ok(!args.includes('setup'));
    const id=args[args.indexOf('--id')+1],root=args[3];
    try{await access(path.join(root,'.openspec-store/store.yaml'));}catch{await put(root,'.openspec-store/store.yaml',stringify({version:1,id}));}
    await put(env.XDG_DATA_HOME,'openspec/stores/registry.yaml',stringify({version:1,stores:{[id]:{backend:{type:'git',local_path:root}}}}));return;
  }
  assert.equal(args[1],'init');for(const name of skillNames)await put(cwd,'.agents/skills/'+name+'/SKILL.md','stock '+name);
  await put(cwd,'.agents/skills/.openspec-target','codex');
}
test('store manifest role/IDs and overlap are bounded and deterministic',async t=>{
  const f=await fixture(t),compile=m=>compileDesiredManifest(JSON.stringify(m),{selected:f.selected});
  assert.deepEqual(openSpecPlan(compile(manifest()),f.binding).store.implementationRepositories,['a','b']);
  for(const ids of [[],['a','a'],['missing'],['docs']]){const m=manifest();m.integrations.openspec.store.implementationRepositories=ids;assert.throws(()=>openSpecPlan(compile(m),f.binding));}
  const bad=structuredClone(f.binding);bad.layout.repositories.b.path='a/nested';assert.throws(()=>openSpecPlan(compile(manifest()),bad));
});
test('same implementation ID cannot silently move its declaration to another root',async t=>{
  const f=await fixture(t),compiled=compileDesiredManifest(f.manifest,{selected:f.selected});
  const previousPlan=openSpecPlan(compiled,f.binding),binding=structuredClone(f.binding);binding.layout.repositories.a.path='moved-a';
  const next=openSpecPlan(compiled,binding);
  await assert.rejects(prepareStore(f.workspace,next,null,{previousPlan}),e=>e.code==='openspec.store-migration-required');
  await assert.rejects(access(path.join(f.workspace,'moved-a')),{code:'ENOENT'});
});
test('YAML editing preserves unrelated bytes, BOM, CRLF and comments',()=>{
  const bytes=Buffer.from('\uFEFF# heading\r\nschema: spec-driven\r\nstore: "old" # owned\r\ncontext: |\r\n  keep\r\n');
  assert.equal(editStoreKey(bytes,'shared').toString(),'\uFEFF# heading\r\nschema: spec-driven\r\nstore: shared # owned\r\ncontext: |\r\n  keep\r\n');
  assert.equal(editStoreKey(bytes,null).toString(),'\uFEFF# heading\r\nschema: spec-driven\r\n# owned\r\ncontext: |\r\n  keep\r\n');
  for(const bytes of ['store: x\nstore: y\n','store: &x a\n','---\nstore: x\n---\nstore: y\n'])assert.throws(()=>editStoreKey(Buffer.from(bytes),'shared'));
  assert.equal(editStoreKey(Buffer.from('{schema: spec-driven, store: old}'),'shared').toString(),'{schema: spec-driven, store: shared}');
  assert.equal(editStoreKey(Buffer.from('{schema: spec-driven, store: old}'),null).toString(),'{schema: spec-driven}');
});
test('owned and borrowed lifecycle preserves all project data and optional backup',async t=>{
  const f=await fixture(t),root=f.workspace;
  await put(root,'a/openspec/config.yaml','\uFEFFschema: spec-driven\r\ncontext: keep\r\n');
  await put(root,'b/openspec/config.yaml','store: shared # borrowed\n');
  await put(root,'docs/openspec/changes/probe/tasks.md','- [ ] preserve');
  await applyDesiredFiles(f,{createDescriptor:true,openSpecRun:runner});
  assert.equal((await inspectDesiredInstallation(root)).ready,true);
  assert.equal(await readFile(path.join(root,'a/openspec/config.yaml'),'utf8'),'\uFEFFschema: spec-driven\r\ncontext: keep\r\nstore: shared\r\n');
  await put(root,'a/openspec/config.yaml','schema: spec-driven\nstore: drift\ncontext: new\n');
  assert.equal((await inspectDesiredInstallation(root)).ready,false);
  const result=await applyDesiredFiles({...f,backup:true},{openSpecRun:runner});
  assert.equal(await readFile(path.join(result.openspec.backupDirectory,'a/openspec/config.yaml'),'utf8'),'schema: spec-driven\nstore: drift\ncontext: new\n');
  await applyDesiredFiles({workspace:root,protectedPaths:f.protectedPaths},{removeExisting:true});
  assert.equal(await readFile(path.join(root,'a/openspec/config.yaml'),'utf8'),'schema: spec-driven\ncontext: new\n');
  assert.equal(await readFile(path.join(root,'b/openspec/config.yaml'),'utf8'),'store: shared # borrowed\n');
  await access(path.join(root,'docs/.openspec-store/store.yaml'));await access(path.join(root,'docs/openspec/changes/probe/tasks.md'));
});

for(const kind of ['identity-hash','identity-missing','owned-key'])test(`real doctor CLI reports ${kind} with repository path hint and no writes`,async t=>{
  const f=await fixture(t);await applyDesiredFiles(f,{createDescriptor:true,openSpecRun:runner});
  assert.equal((await inspectDesiredInstallation(f.workspace)).ready,true);
  const identity=kind.startsWith('identity'),subject=identity?'docs/.openspec-store/store.yaml':'a/openspec/config.yaml';
  if(kind==='identity-missing')await rm(path.join(f.workspace,subject));
  else await put(f.workspace,subject,identity?'version: 1\nid: shared\nnote: PRIVATE_DOCTOR_SENTINEL\n':'store: drifted\ncontext: PRIVATE_DOCTOR_SENTINEL\n');
  async function snapshot(){
    const files={};async function walk(relative){
      for(const e of await readdir(path.join(f.workspace,relative),{withFileTypes:true})){
        const name=path.posix.join(relative,e.name);
        if(e.isDirectory()){files[name+'/']='directory';await walk(name);}else files[name]=sha256(await readFile(path.join(f.workspace,name)));
      }
    }await walk('');return files;
  }
  const before=await snapshot(),cli=fileURLToPath(new URL('../src/cli.js',import.meta.url));
  function run(json){
    const result=spawnSync(process.execPath,[cli,'doctor','--workspace',f.workspace,...(json?['--json']:[])],{cwd:f.workspace,encoding:'utf8',windowsHide:true,timeout:60000});
    assert.equal(result.status,1,result.stderr||String(result.error));
    assert.doesNotMatch(result.stdout+result.stderr,/PRIVATE_DOCTOR_SENTINEL/);
    return result.stdout;
  }
  const report=JSON.parse(run(true)),code=identity?'openspec.store-identity-conflict':'openspec.store-config-drift';
  assert.equal(report.ready,false);
  const d=report.diagnostics.find(d=>d.code===code);assert.ok(d);
  assert.equal(d.subject,subject);assert.equal(d.repository,identity?'docs':'a');assert.ok(d.hint.length>20);
  assert.notEqual(d.subject,'.pipeline/openspec/installation.json');
  const human=run(false);assert.ok(human.includes(subject));assert.ok(human.includes(`[${d.repository}]`));assert.ok(human.includes(d.hint));
  assert.deepEqual(await snapshot(),before);
});
test('local roots, invalid or foreign config fail before adapter writes',async t=>{
  for(const kind of ['specs','changes','identity','foreign','duplicate']){
    const f=await fixture(t);
    if(kind==='specs'||kind==='changes')await mkdir(path.join(f.workspace,'a/openspec',kind),{recursive:true});
    else if(kind==='identity')await mkdir(path.join(f.workspace,'a/.openspec-store'));
    else await put(f.workspace,'a/openspec/config.yaml',kind==='foreign'?'store: foreign\n':'store: shared\nstore: shared\n');
    await assert.rejects(applyDesiredFiles(f,{openSpecRun:runner}));
    await assert.rejects(access(path.join(f.workspace,'AGENTS.md')),{code:'ENOENT'});
  }
});
test('pending failure retains retirement intents and rejects concurrent third state',async t=>{
  const f=await fixture(t);await applyDesiredFiles(f,{createDescriptor:true,openSpecRun:runner});
  const m=manifest();m.integrations.openspec.store.implementationRepositories=['a'];const next={...f,manifest:JSON.stringify(m)};
  let failed=false;await assert.rejects(applyDesiredFiles(next,{openSpecRun:runner,boundary:event=>{if(event==='openspec-after-key'&&!failed){failed=true;throw new Error('injected');}}}),/injected/);
  await put(f.workspace,'a/openspec/config.yaml','store: shared\ncontext: concurrent\n');
  await assert.rejects(applyDesiredFiles(next,{openSpecRun:runner}),e=>e.code==='openspec.store-config-changed');
  await put(f.workspace,'a/openspec/config.yaml','store: shared\n');
  await applyDesiredFiles(next,{openSpecRun:runner});
  assert.equal(await readFile(path.join(f.workspace,'b/openspec/config.yaml'),'utf8'),'');
  assert.equal((await inspectDesiredInstallation(f.workspace)).ready,true);
});
test('initial pending after register or key is retryable without ownership adoption',async t=>{
  for(const stage of ['openspec-after-pending','openspec-after-register','openspec-after-key','openspec-before-ready']){
    const f=await fixture(t);let failed=false;
    await assert.rejects(applyDesiredFiles(f,{createDescriptor:true,openSpecRun:runner,boundary:event=>{if(event===stage&&!failed){failed=true;throw new Error('injected');}}}),/injected/);
    await applyDesiredFiles(f,{openSpecRun:runner});
    const record=JSON.parse(await readFile(path.join(f.workspace,'.pipeline/openspec/installation.json'),'utf8'));
    assert.ok(record.storeBindings.every(b=>b.ownership==='owned'));assert.equal((await inspectDesiredInstallation(f.workspace)).ready,true);
  }
});
test('store rename blocked; shared to single preserves identity and removes owned declarations',async t=>{
  const f=await fixture(t);await applyDesiredFiles(f,{createDescriptor:true,openSpecRun:runner});
  const m=manifest();m.integrations.openspec.store.id='other';await assert.rejects(applyDesiredFiles({...f,manifest:JSON.stringify(m)},{openSpecRun:runner}),e=>e.code==='openspec.store-migration-required');
  delete m.integrations.openspec.store;await applyDesiredFiles({...f,manifest:JSON.stringify(m)},{openSpecRun:runner});
  assert.equal(await readFile(path.join(f.workspace,'a/openspec/config.yaml'),'utf8'),'');await access(path.join(f.workspace,'docs/.openspec-store/store.yaml'));
  assert.equal((await inspectDesiredInstallation(f.workspace)).ready,true);
});
test('outer-record crash resumes completed retirements without losing ownership',async t=>{
  for(const mode of ['retire','single','remove']){
    const f=await fixture(t);await applyDesiredFiles(f,{createDescriptor:true,openSpecRun:runner});
    const m=manifest();if(mode==='retire')m.integrations.openspec.store.implementationRepositories=['a'];
    else if(mode==='single')delete m.integrations.openspec.store;
    const next=mode==='remove'?{workspace:f.workspace,protectedPaths:f.protectedPaths}:{...f,manifest:JSON.stringify(m)};
    const options={openSpecRun:runner,...(mode==='remove'?{removeExisting:true}:{})};
    // Force the content path where the outer before-record hook is exercised.
    await put(f.workspace,'AGENTS.md','drift');
    await assert.rejects(applyDesiredFiles(next,{...options,boundary:event=>{if(event==='before-record')throw new Error('outer crash');}}),/outer crash/);
    await applyDesiredFiles(next,options);
    assert.equal(await readFile(path.join(f.workspace,'b/openspec/config.yaml'),'utf8'),'');
    assert.equal((await inspectDesiredInstallation(f.workspace)).status,mode==='remove'?'not-installed':'ready');
  }
});
