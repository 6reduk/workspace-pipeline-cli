import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {mkdtemp,mkdir,writeFile,readFile,rm,access,symlink} from 'node:fs/promises';
import {compileDesiredManifest} from '../src/contracts/desired-state.js';
import {applyDesiredFiles} from '../src/desired-state/apply-files.js';
import {inspectDesiredInstallation} from '../src/desired-state/doctor.js';
import {openSpecPlan,skillNames,execute} from '../src/integrations/openspec.js';
import {formatResult} from '../src/commands/output.js';
import {tryDesiredRemove} from '../src/commands/desired-remove.js';
import {tryDesiredLifecycle} from '../src/commands/desired-lifecycle.js';
import {contractDigest} from '../src/contracts/semantic.js';
import {sha256} from '../src/source/inventory.js';
const integrity='sha512-IU9ggB7UYMDU47S0R59NH2ngJp+CK2X/r1B8+QU2Fm8LLBPFatQRO1Ia7B8nO3FHbTE7xRXAIs9NcuUF8Beeag==';
async function put(base,p,content){await mkdir(path.dirname(path.join(base,p)),{recursive:true});await writeFile(path.join(base,p),content);}
const manifest=()=>({schemaVersion:2,id:'example',version:'1.0.0',integrations:{openspec:{version:'1.14.1',repository:'game'}},adapters:{both:{providers:['codex','claude','grok'],settings:[],files:[{source:'entry.md',target:'AGENTS.md',kind:'file'}]}}});
async function fixture(t){
  const workspace=await mkdtemp(path.join(os.tmpdir(),'wpc-os-'));t.after(()=>rm(workspace,{recursive:true,force:true}));
  await mkdir(path.join(workspace,'project'));
  const source=new Map([['entry.md',Buffer.from('Read .pipeline/openspec/README.md before OpenSpec operations.\n')]]);
  const binding={source:{type:'git',transport:'local',path:'../source',ref:'main',subdirectory:'.'},commit:'a'.repeat(40),
    digest:contractDigest(Object.fromEntries([...source].map(([p,b])=>[p,sha256(b)]))),
    layout:{kind:'single-repo',repositories:{game:{path:'project',role:'code'}},documentation:{repository:'game',path:'docs'}}};
  return {workspace,source,binding,manifest:JSON.stringify(manifest()),selected:['both'],protectedPaths:['project']};
}
// No network and no model/harness: simulate the trusted subprocess boundary.
async function runner(command,args,{cwd,env}){
  assert.equal(env.OPENSPEC_TELEMETRY,'0');assert.equal(env.OPENSPEC_NO_UPDATE_CHECK,'1');
  if(args[1]==='install'||args[1]==='ci'){
    assert.ok(args.includes('--ignore-scripts'));
    await put(cwd,'package-lock.json',JSON.stringify({lockfileVersion:3,packages:{'node_modules/@fission-ai/openspec':{version:'1.14.1',integrity}}}));
    await put(cwd,'node_modules/@fission-ai/openspec/package.json',JSON.stringify({version:'1.14.1'}));
    await put(cwd,'node_modules/@fission-ai/openspec/bin/openspec.js','// fixture bin\n');
    return;
  }
  assert.equal(args[1],'init');
  const tools=args[args.indexOf('--tools')+1].split(',');
  for(const tool of tools)for(const name of skillNames)await put(cwd,`${tool==='codex'?'.agents':'.claude'}/skills/${name}/SKILL.md`,'upstream '+name+'\n');
  if(tools.includes('codex'))await put(cwd,'.agents/skills/.openspec-target','codex');
}
test('manifest declaration is bounded, provider-derived, and rejects competing ownership',async t=>{
  const f=await fixture(t),compile=m=>compileDesiredManifest(JSON.stringify(m),{selected:['both'],protectedPaths:['project']});
  assert.deepEqual(openSpecPlan(compile(manifest()),f.binding).tools,['codex','claude']);
  for(const mutate of [m=>m.integrations.openspec.version='latest',m=>m.integrations.openspec.command='cmd',m=>m.integrations.other={}]){
    const m=manifest();mutate(m);assert.throws(()=>compile(m));
  }
  const m=manifest();m.adapters.both.files.push({source:'skills',target:'.agents/skills',kind:'directory'});
  assert.throws(()=>openSpecPlan(compile(m),f.binding),e=>e.code==='openspec.owner-overlap');
  const missing=manifest();missing.integrations.openspec.repository='missing';
  assert.throws(()=>openSpecPlan(compile(missing),f.binding),e=>e.code==='openspec.repository');
});
test('setup/update/doctor/remove preserve planning and unrelated skills',async t=>{
  const f=await fixture(t),root=f.workspace;
  await put(root,'project/openspec/config.yaml','schema: spec-driven\ncontext: preserve\n');
  await put(root,'project/openspec/changes/probe/tasks.md','- [ ] blocked\n');
  await put(root,'.agents/skills/user/SKILL.md','user-owned');
  const result=await applyDesiredFiles(f,{createDescriptor:true,openSpecRun:runner});assert.equal(result.openspec.status,'ready');
  assert.equal((await inspectDesiredInstallation(root)).ready,true);
  await put(root,'.agents/skills/openspec-propose/extra.md','custom');
  assert.ok((await inspectDesiredInstallation(root)).diagnostics.some(d=>d.code==='openspec.file-extra'));
  const updated=await applyDesiredFiles({...f,backup:true},{openSpecRun:runner});
  assert.equal(updated.backupDirectory,updated.openspec.backupDirectory);
  assert.equal(await readFile(path.join(updated.backupDirectory,'.agents/skills/openspec-propose/extra.md'),'utf8'),'custom');
  assert.ok(formatResult(updated).includes(updated.backupDirectory));
  await assert.rejects(access(path.join(root,'.agents/skills/openspec-propose/extra.md')),{code:'ENOENT'});
  assert.equal((await inspectDesiredInstallation(root)).ready,true);
  await applyDesiredFiles({workspace:root,protectedPaths:['project']},{removeExisting:true});
  assert.equal(await readFile(path.join(root,'project/openspec/config.yaml'),'utf8'),'schema: spec-driven\ncontext: preserve\n');
  assert.equal(await readFile(path.join(root,'project/openspec/changes/probe/tasks.md'),'utf8'),'- [ ] blocked\n');
  assert.equal(await readFile(path.join(root,'.agents/skills/user/SKILL.md'),'utf8'),'user-owned');
  await assert.rejects(access(path.join(root,'.pipeline/openspec/tool')),{code:'ENOENT'});
  assert.equal((await inspectDesiredInstallation(root)).status,'not-installed');
});
test('generator failure is incomplete and retry completes same operation',async t=>{
  const f=await fixture(t);
  const faulty=async(...args)=>{if(args[1][1]==='init')throw new Error('synthetic failure');return runner(...args);};
  await assert.rejects(applyDesiredFiles(f,{createDescriptor:true,openSpecRun:faulty}),/synthetic failure/);
  assert.equal((await inspectDesiredInstallation(f.workspace)).ready,false);
  await applyDesiredFiles(f,{openSpecRun:runner});
  assert.equal((await inspectDesiredInstallation(f.workspace)).ready,true);
});
test('foreign OpenSpec payload is rejected before adapter mutation',async t=>{
  const f=await fixture(t);
  await put(f.workspace,'AGENTS.md','existing');await put(f.workspace,'.agents/skills/openspec-propose/SKILL.md','foreign');
  await assert.rejects(applyDesiredFiles(f,{createDescriptor:true,openSpecRun:runner}),e=>e.code==='openspec.foreign-integration');
  assert.equal(await readFile(path.join(f.workspace,'AGENTS.md'),'utf8'),'existing');
});
test('dropping declaration removes integration but retains project artifacts',async t=>{
  const f=await fixture(t);await applyDesiredFiles(f,{createDescriptor:true,openSpecRun:runner});
  const m=manifest();delete m.integrations;await applyDesiredFiles({...f,manifest:JSON.stringify(m)});
  await access(path.join(f.workspace,'project/openspec/config.yaml'));
  await assert.rejects(access(path.join(f.workspace,'.agents/skills/openspec-propose')),{code:'ENOENT'});
  assert.equal((await inspectDesiredInstallation(f.workspace)).ready,true);
});
test('corrupted internal locks are not trusted as installation input',async t=>{
  const f=await fixture(t);await applyDesiredFiles(f,{createDescriptor:true,openSpecRun:runner});
  const lock=path.join(f.workspace,'.pipeline/openspec/dependency-lock.json');
  await writeFile(lock,'{}');
  assert.ok((await inspectDesiredInstallation(f.workspace)).diagnostics.some(d=>d.code==='openspec.lock-drift'));
  await assert.rejects(applyDesiredFiles(f,{openSpecRun:runner}),e=>e.code==='openspec.lock-drift');
  assert.equal(await readFile(path.join(f.workspace,'project/openspec/config.yaml'),'utf8'),'schema: spec-driven\n');
});
test('update cannot transfer OpenSpec ownership silently to broad adapter mappings',async t=>{
  const f=await fixture(t);await applyDesiredFiles(f,{createDescriptor:true,openSpecRun:runner});
  const m=manifest();delete m.integrations;
  m.adapters.both.files.push({source:'entry.md',target:'.agents/skills/openspec-propose/SKILL.md',kind:'file'});
  await assert.rejects(applyDesiredFiles({...f,manifest:JSON.stringify(m)}),e=>e.code==='openspec.owner-overlap');
  assert.equal((await inspectDesiredInstallation(f.workspace)).ready,true);
});
test('linked planning directory blocks setup without touching the destination',async t=>{
  const f=await fixture(t),destination=path.join(f.workspace,'elsewhere');
  await mkdir(destination);await writeFile(path.join(destination,'keep.md'),'keep');
  await symlink(destination,path.join(f.workspace,'project/openspec'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(applyDesiredFiles(f,{createDescriptor:true,openSpecRun:runner}),e=>e.code==='layout.link');
  assert.equal(await readFile(path.join(destination,'keep.md'),'utf8'),'keep');
  await assert.rejects(access(path.join(f.workspace,'AGENTS.md')),{code:'ENOENT'});
});
test('unowned private runtime is not silently deleted',async t=>{
  const f=await fixture(t);await put(f.workspace,'.pipeline/openspec/tool/user.txt','keep');
  await assert.rejects(applyDesiredFiles(f,{createDescriptor:true,openSpecRun:runner}),e=>e.code==='openspec.foreign-runtime');
  assert.equal(await readFile(path.join(f.workspace,'.pipeline/openspec/tool/user.txt'),'utf8'),'keep');
});
test('lost runtime refuses remove and declaration drop before adapter mutations',async t=>{
  const f=await fixture(t);await applyDesiredFiles(f,{createDescriptor:true,openSpecRun:runner});
  await rm(path.join(f.workspace,'.pipeline/openspec'),{recursive:true});
  const before=await readFile(path.join(f.workspace,'AGENTS.md'));
  await assert.rejects(applyDesiredFiles({workspace:f.workspace,protectedPaths:['project']},{removeExisting:true}),e=>e.code==='openspec.removal-residue');
  for(const flag of ['--preview','--yes']){
    let error='';
    assert.equal(await tryDesiredRemove(['remove','--workspace',f.workspace,flag],{stdout:()=>{},stderr:s=>{error+=s;}}),2);
    assert.equal(JSON.parse(error).error,'openspec.removal-residue');
  }
  const m=manifest();delete m.integrations;
  await assert.rejects(applyDesiredFiles({...f,manifest:JSON.stringify(m)}),e=>e.code==='openspec.removal-residue');
  assert.deepEqual(await readFile(path.join(f.workspace,'AGENTS.md')),before);
  assert.equal((await inspectDesiredInstallation(f.workspace)).ready,false);
});
test('removed installation reports residual skills and rejects repeated removal',async t=>{
  const f=await fixture(t);await applyDesiredFiles(f,{createDescriptor:true,openSpecRun:runner});
  await applyDesiredFiles({workspace:f.workspace,protectedPaths:['project']},{removeExisting:true});
  // Include an empty directory: it must not vanish from residue inspection.
  await mkdir(path.join(f.workspace,'.claude/skills/openspec-propose'));
  const doctor=await inspectDesiredInstallation(f.workspace);
  assert.ok(doctor.diagnostics.some(d=>d.code==='openspec.removal-residue'));
  let error='';
  assert.equal(await tryDesiredRemove(['remove','--workspace',f.workspace,'--yes'],{stdout:()=>{},stderr:s=>{error+=s;}}),2);
  assert.equal(JSON.parse(error).error,'openspec.removal-residue');
  await assert.rejects(applyDesiredFiles({workspace:f.workspace,protectedPaths:['project']},{removeExisting:true}),e=>e.code==='openspec.removal-residue');
});
test('adapter and OpenSpec backups both remain discoverable',async t=>{
  const f=await fixture(t);await applyDesiredFiles(f,{createDescriptor:true,openSpecRun:runner});
  await put(f.workspace,'AGENTS.md','custom entry');
  await put(f.workspace,'.claude/skills/openspec-propose/SKILL.md','custom skill');
  const result=await applyDesiredFiles({...f,backup:true},{openSpecRun:runner});
  assert.notEqual(result.backupDirectory,result.openspec.backupDirectory);
  assert.equal(await readFile(path.join(result.backupDirectory,'AGENTS.md'),'utf8'),'custom entry');
  assert.equal(await readFile(path.join(result.openspec.backupDirectory,'.claude/skills/openspec-propose/SKILL.md'),'utf8'),'custom skill');
  for(const directory of [result.backupDirectory,result.openspec.backupDirectory])assert.ok(formatResult(result).includes(directory));
});
test('subprocess failure retains only an allowlisted reason, never raw secrets',async()=>{
  await assert.rejects(execute(process.execPath,['-e',"process.stderr.write('npm error code ENOTFOUND https://user:secret@example.test private-token');process.exit(1)"],{cwd:process.cwd(),env:process.env}),e=>{
    assert.equal(e.commandDiagnostic.reason,'ENOTFOUND');assert.equal(e.commandDiagnostic.exitCode,1);
    assert.doesNotMatch(JSON.stringify(e),/secret|private-token|example\.test/);return true;
  });
});
test('public update preview and apply both reject dropped integration with lost metadata',async t=>{
  const f=await fixture(t),source=path.join(f.workspace,'source');
  await mkdir(source);
  const git=(...args)=>execFileSync('git',['-C',source,...args],{stdio:'pipe',windowsHide:true});
  git('init','--initial-branch=main','--template=');
  const commit=()=>{git('add','pipeline.json','entry.md');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath='+source,'-c','commit.gpgsign=false','commit','-m','Synthetic source');};
  const m=manifest();await put(source,'pipeline.json',JSON.stringify(m));await put(source,'entry.md',f.source.get('entry.md'));commit();
  const invoke=async args=>{
    let out='',error='';
    const code=await tryDesiredLifecycle([...args,'--workspace',f.workspace],{stdout:s=>{out+=s;},stderr:s=>{error+=s;}},{hostOptions:{openSpecRun:runner}});
    return {code,out,error};
  };
  assert.equal((await invoke(['setup','--source',source,'--adapters','both','--yes'])).code,0);
  await rm(path.join(f.workspace,'.pipeline/openspec'),{recursive:true});
  delete m.integrations;await put(source,'pipeline.json',JSON.stringify(m));commit();
  const names=['AGENTS.md','workspace.json','.pipeline/desired-install.json','.claude/skills/openspec-propose/SKILL.md','project/openspec/config.yaml'];
  const before=await Promise.all(names.map(n=>readFile(path.join(f.workspace,n))));
  for(const flag of ['--preview','--yes']){
    const result=await invoke(['update',flag]);assert.equal(result.code,2);assert.equal(result.out,'');
    assert.equal(JSON.parse(result.error).error,'openspec.removal-residue');
    assert.deepEqual(await Promise.all(names.map(n=>readFile(path.join(f.workspace,n)))),before);
    await assert.rejects(access(path.join(f.workspace,'.pipeline/desired-pending.json')),{code:'ENOENT'});
  }
});
