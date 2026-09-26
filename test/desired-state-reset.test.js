import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tryDesiredLifecycle} from '../src/commands/desired-lifecycle.js';

async function fixture(t,{interrupt=false}={}) {
  const root=await mkdtemp(path.join(os.tmpdir(),'wpc-reset-v2-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const repo=path.join(root,'source'),workspace=path.join(root,'workspace');
  await mkdir(repo);await mkdir(workspace);
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^GIT_/i.test(k)));
  Object.assign(env,{GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'});
  function git(args) {
    const r=spawnSync('git',['-C',repo,'-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],
      {env,encoding:'utf8',windowsHide:true,timeout:30000});
    assert.equal(r.status,0,r.stderr);return r.stdout.trim();
  }
  git(['init','--initial-branch=main','--template=']);git(['config','user.name','Fixture']);git(['config','user.email','fixture@example.invalid']);
  const manifest={schemaVersion:2,id:'example',version:'1.0.0',adapters:{codex:{providers:['codex'],settings:[],
    files:[{source:'skills',target:'.agents/skills',kind:'directory'}]}}};
  await mkdir(path.join(repo,'skills'));await writeFile(path.join(repo,'skills/a.md'),'installed');
  await writeFile(path.join(repo,'pipeline.json'),JSON.stringify(manifest));
  git(['add','--all']);git(['commit','-m','first']);const commit=git(['rev-parse','HEAD']);
  async function call(command,flags=['--yes'],interaction={}) {
    let out='',err='';
    const code=await tryDesiredLifecycle([command,'--workspace',workspace,...flags],
      {stdout:async s=>{out+=s;},stderr:async s=>{err+=s;}},
      {display:async()=>{},hostOptions:{tempRoot:root},...interaction});
    return {code,out,err,value:out?JSON.parse(out):null};
  }
  const initial=await call('setup',['--source',repo,'--ref','main','--adapters','codex','--yes'],interrupt?
    {hostOptions:{tempRoot:root,boundary:async event=>{if(event==='before-content')throw Error('interruption');}}}:{});
  assert.equal(initial.code,interrupt?2:0,initial.err);
  return {root,repo,workspace,git,call,commit};
}

test('reset uses installed commit despite branch movement; update still uses original branch',async t=>{
  const {repo,workspace,git,call,commit}=await fixture(t);
  await writeFile(path.join(repo,'skills/a.md'),'new release');git(['add','--all']);git(['commit','-m','second']);
  const latest=git(['rev-parse','HEAD']);assert.notEqual(latest,commit);
  await writeFile(path.join(workspace,'.agents/skills/a.md'),'custom');
  await writeFile(path.join(workspace,'.agents/skills/custom.md'),'extra');
  const descriptor=await readFile(path.join(workspace,'workspace.json'));
  let r=await call('reset',['--preview']);assert.equal(r.code,0,r.err);
  assert.equal(r.value.reset.commit,commit);assert.equal(r.value.reset.mode,'installed');
  assert.equal(await readFile(path.join(workspace,'.agents/skills/a.md'),'utf8'),'custom');
  r=await call('reset',[],{isTTY:true,confirm:async()=>false});assert.equal(r.value.status,'cancelled');
  r=await call('reset');assert.equal(r.code,0,r.err);assert.equal(r.value.backupDirectory,null);
  assert.equal(await readFile(path.join(workspace,'.agents/skills/a.md'),'utf8'),'installed');
  await assert.rejects(stat(path.join(workspace,'.agents/skills/custom.md')),{code:'ENOENT'});
  assert.deepEqual(await readFile(path.join(workspace,'workspace.json')),descriptor);
  r=await call('update');assert.equal(r.code,0,r.err);assert.equal(r.value.provenance.commit,latest);
  assert.equal(await readFile(path.join(workspace,'.agents/skills/a.md'),'utf8'),'new release');
});
test('reset resumes a handled interrupted installation after branch moves',async t=>{
  const {repo,workspace,git,call,commit}=await fixture(t,{interrupt:true});
  await writeFile(path.join(repo,'skills/a.md'),'new release');git(['add','--all']);git(['commit','-m','second']);
  const r=await call('reset');assert.equal(r.code,0,r.err);
  assert.equal(r.value.reset.mode,'pending-installation');assert.equal(r.value.provenance.commit,commit);
  assert.equal(await readFile(path.join(workspace,'.agents/skills/a.md'),'utf8'),'installed');
  await assert.rejects(stat(path.join(workspace,'.pipeline/desired-pending.json')),{code:'ENOENT'});
});
test('reset refuses wrong digest or changed declaration before replacing custom content',async t=>{
  const {workspace,call}=await fixture(t);
  await writeFile(path.join(workspace,'.agents/skills/a.md'),'custom');
  const filename=path.join(workspace,'.pipeline/desired-install.json'),record=JSON.parse(await readFile(filename,'utf8'));
  record.binding.digest='sha256:'+'0'.repeat(64);await writeFile(filename,JSON.stringify(record));
  let r=await call('reset');assert.equal(r.code,2);assert.match(r.err,/desired.reset-source-mismatch/);
  const file=path.join(workspace,'workspace.json'),descriptor=JSON.parse(await readFile(file,'utf8'));
  descriptor.pipeline.ref='changed';await writeFile(file,JSON.stringify(descriptor));
  r=await call('reset');assert.equal(r.code,2);assert.match(r.err,/desired.reset-workspace-different/);
  assert.equal(await readFile(path.join(workspace,'.agents/skills/a.md'),'utf8'),'custom');
});
test('reset rechecks recorded installation after confirmation and honors optional backup',async t=>{
  const {workspace,call}=await fixture(t);
  await writeFile(path.join(workspace,'.agents/skills/a.md'),'custom');
  let r=await call('reset',[],{isTTY:true,confirm:async()=>{
    const file=path.join(workspace,'.pipeline/desired-install.json');
    await writeFile(file,(await readFile(file,'utf8'))+' ');return true;
  }});
  assert.equal(r.code,2);assert.match(r.err,/desired.installation-state-changed/);
  assert.equal(await readFile(path.join(workspace,'.agents/skills/a.md'),'utf8'),'custom');
  r=await call('reset',['--yes','--backup']);assert.equal(r.code,0,r.err);
  assert.equal(await readFile(path.join(r.value.backupDirectory,'.agents/skills/a.md'),'utf8'),'custom');
});
