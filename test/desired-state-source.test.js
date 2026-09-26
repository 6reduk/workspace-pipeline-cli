import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {verifyDesiredPackage} from '../src/source/desired-package.js';
import {prepareDesiredWorkspace,parseDesiredWorkspace} from '../src/desired-state/source.js';
import {applyDesiredFiles} from '../src/desired-state/apply-files.js';
import {tryDesiredLifecycle} from '../src/commands/desired-lifecycle.js';

const manifest=()=>({schemaVersion:2,id:'example',version:'1.0.0',adapters:{claude:{providers:['claude'],settings:[],files:[{source:'entry.md',target:'CLAUDE.md',kind:'file'}]}}});
function git(root,args) {
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^GIT_/i.test(key)));
  Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'});
  const result=spawnSync('git',['-C',root,'-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],{env,encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);return result.stdout.trim();
}
test('desired Git package computes inventory and rejects missing declared source',async()=>{
  const files=new Map([['pipeline.json',Buffer.from(JSON.stringify(manifest()))],['entry.md',Buffer.from('entry')]]);
  const entries=()=>[...files].map(([path,bytes])=>({path,size:bytes.length,mode:'100644',type:'blob'}));
  const verified=await verifyDesiredPackage(entries(),async e=>files.get(e.path));
  assert.match(verified.digest,/^sha256:/);assert.equal(verified.files.size,2);
  files.delete('entry.md');await assert.rejects(verifyDesiredPackage(entries(),async e=>files.get(e.path)),e=>e.code==='desired.source-missing');
});
test('local Git committed source prepares and installs without preview file or worktree edits',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'wpc-desired-git-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const repo=path.join(root,'source'),workspace=path.join(root,'workspace');await mkdir(repo);await mkdir(workspace);
  git(repo,['init','--initial-branch=main','--template=']);
  git(repo,['config','user.name','Fixture']);git(repo,['config','user.email','fixture@example.invalid']);
  await writeFile(path.join(repo,'pipeline.json'),JSON.stringify(manifest()));await writeFile(path.join(repo,'entry.md'),'committed');
  git(repo,['add','--all']);git(repo,['commit','-m','fixture']);const commit=git(repo,['rev-parse','HEAD']);
  await writeFile(path.join(repo,'entry.md'),'uncommitted');
  const descriptor={schemaVersion:2,pipeline:{type:'git',transport:'local',path:'../source',ref:'main',subdirectory:'.'},adapters:['claude'],
    layout:{kind:'single-repo',repositories:{game:{path:'project',role:'code'}},documentation:{repository:'game',path:'docs'}}};
  const prepared=await prepareDesiredWorkspace(workspace,JSON.stringify(descriptor),{tempRoot:root});
  assert.equal(prepared.provenance.commit,commit);
  await writeFile(path.join(workspace,'workspace.json'),JSON.stringify(descriptor));
  let output='',errors='',display='';
  const options={stdout:async s=>{output+=s;},stderr:async s=>{errors+=s;}};
  const interaction={isTTY:true,confirm:async()=>false,display:async s=>{display+=s;},hostOptions:{tempRoot:root}};
  assert.equal(await tryDesiredLifecycle(['setup','--workspace',workspace],options,interaction),0);
  assert.equal(JSON.parse(output).status,'cancelled');
  await assert.rejects(readFile(path.join(workspace,'CLAUDE.md')),{code:'ENOENT'});
  output='';
  assert.equal(await tryDesiredLifecycle(['setup','--workspace',workspace,'--yes'],options,interaction),0,errors);
  assert.equal(JSON.parse(output).status,'applied');assert.match(display,/Backup: OFF/);
  const installed=JSON.parse(await readFile(path.join(workspace,'.pipeline/desired-install.json'),'utf8'));
  assert.deepEqual(installed.binding,{...prepared.provenance,layout:descriptor.layout});
  assert.equal(await readFile(path.join(workspace,'CLAUDE.md'),'utf8'),'committed');
  assert.equal(await readFile(path.join(repo,'entry.md'),'utf8'),'uncommitted');
  output='';
  assert.equal(await tryDesiredLifecycle(['update','--workspace',workspace,'--yes'],options,interaction),0,errors);
  assert.equal(JSON.parse(output).status,'unchanged');
  const executable=spawnSync(process.execPath,[fileURLToPath(new URL('../src/cli.js',import.meta.url)),
    'update','--workspace',workspace,'--yes','--json'],{encoding:'utf8',windowsHide:true});
  assert.equal(executable.status,0,executable.stderr);
  assert.equal(JSON.parse(executable.stdout).status,'unchanged');
  const fresh=path.join(root,'fresh');await mkdir(fresh);
  const setup=['setup','--workspace',fresh,'--source',repo,'--ref','main','--adapters','claude'];
  output='';assert.equal(await tryDesiredLifecycle([...setup,'--preview'],options,interaction),0,errors);
  assert.equal(JSON.parse(output).descriptor.action,'create');
  await assert.rejects(readFile(path.join(fresh,'workspace.json')),{code:'ENOENT'});
  output='';assert.equal(await tryDesiredLifecycle(setup,options,interaction),0,errors);
  assert.equal(JSON.parse(output).status,'cancelled');
  await assert.rejects(readFile(path.join(fresh,'workspace.json')),{code:'ENOENT'});
  output='';assert.equal(await tryDesiredLifecycle([...setup,'--yes'],options,interaction),0,errors);
  assert.equal(JSON.parse(output).status,'applied');
  const created=JSON.parse(await readFile(path.join(fresh,'workspace.json'),'utf8'));
  assert.equal(created.pipeline.path,'../source');assert.equal(created.schemaVersion,2);
  output='';assert.equal(await tryDesiredLifecycle(['update','--workspace',fresh,'--yes'],options,interaction),0,errors);
  assert.equal(JSON.parse(output).status,'unchanged');
  errors='';assert.equal(await tryDesiredLifecycle([...setup,'--yes'],options,interaction),2);
  assert.match(errors,/desired.setup-already-configured/);
  assert.match(JSON.parse(errors).hint,/doctor, then update/);
  assert.match(JSON.parse(errors).hint,/reset/);
  for(const verb of ['setup','update','reset']) {
    errors='';output='';
    assert.equal(await tryDesiredLifecycle([verb,'--workspace',fresh,'--network','--yes'],options,interaction),2);
    assert.equal(JSON.parse(errors).error,'cli.arguments');assert.equal(output,'');
    assert.equal(await readFile(path.join(fresh,'CLAUDE.md'),'utf8'),'committed');
  }
  const race=path.join(root,'race');await mkdir(race);
  errors='';
  assert.equal(await tryDesiredLifecycle(['setup','--workspace',race,'--source',repo,'--adapters','claude'],options,
    {...interaction,confirm:async()=>{await writeFile(path.join(race,'workspace.json'),'concurrent user bytes');return true;}}),2);
  assert.equal(await readFile(path.join(race,'workspace.json'),'utf8'),'concurrent user bytes');
  await assert.rejects(readFile(path.join(race,'CLAUDE.md')),{code:'ENOENT'});
  const interrupted=path.join(root,'interrupted');await mkdir(interrupted);
  const interruptedSetup=['setup','--workspace',interrupted,'--source',repo,'--ref','main','--adapters','claude','--yes'];
  errors='';output='';
  assert.equal(await tryDesiredLifecycle(interruptedSetup,options,{...interaction,hostOptions:{tempRoot:root,
    boundary:async event=>{if(event==='before-content')throw Error('fixture interruption');}}}),2);
  const pendingFile=path.join(interrupted,'.pipeline/desired-pending.json');
  const pendingBefore=await readFile(pendingFile);
  errors='';output='';
  assert.equal(await tryDesiredLifecycle(interruptedSetup,options,interaction),2);
  assert.equal(JSON.parse(errors).error,'desired.setup-already-configured');
  assert.match(JSON.parse(errors).hint,/doctor, then update/);
  assert.deepEqual(await readFile(pendingFile),pendingBefore);
  output='';errors='';
  assert.equal(await tryDesiredLifecycle(['update','--workspace',interrupted,'--yes'],options,interaction),0,errors);
  assert.equal(await readFile(path.join(interrupted,'CLAUDE.md'),'utf8'),'committed');
  await assert.rejects(readFile(pendingFile),{code:'ENOENT'});
});
test('descriptor rejects executable extension and overlapping repository roots',()=>{
  const descriptor={schemaVersion:2,pipeline:{type:'git',transport:'local',path:'../source',ref:'main',subdirectory:'.'},adapters:['claude'],
    layout:{kind:'multi-repo',repositories:{game:{path:'project',role:'code'},docs:{path:'project/docs',role:'documentation'}},documentation:{repository:'docs',path:'.'}}};
  assert.throws(()=>parseDesiredWorkspace(JSON.stringify(descriptor)),e=>e.code==='desired.repository-overlap');
  descriptor.hooks=['bad'];assert.throws(()=>parseDesiredWorkspace(JSON.stringify(descriptor)),e=>e.code==='desired.workspace-schema');
});
