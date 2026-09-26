import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat,readdir} from 'node:fs/promises';
import {applyDesiredFiles} from '../src/desired-state/apply-files.js';
import {inspectDesiredInstallation} from '../src/desired-state/doctor.js';
import {tryDesiredLifecycle} from '../src/commands/desired-lifecycle.js';
import {contractDigest} from '../src/contracts/semantic.js';
import {sha256} from '../src/source/inventory.js';

async function fixture(t) {
  const root=await mkdtemp(path.join(os.tmpdir(),'wpc-remove-v2-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const workspace=path.join(root,'workspace'),userHome=path.join(root,'profile');
  await mkdir(workspace);await mkdir(userHome);
  await mkdir(path.join(workspace,'project'));await writeFile(path.join(workspace,'project/game.cs'),'game');
  await mkdir(path.join(userHome,'.grok'));await writeFile(path.join(userHome,'.grok/config.toml'),'model = "mine"\n');
  const declaration={schemaVersion:2,id:'example',version:'1.0.0',adapters:{claude:{providers:['claude','grok'],files:[
    {source:'entry.md',target:'CLAUDE.md',kind:'file'},{source:'skills',target:'.claude/skills',kind:'directory'}],settings:[
    {target:'claude.mcp',pointer:'/mcpServers/pipeline',operation:'set',value:{command:'fixture'}},
    {target:'grok.user',pointer:'/compat/claude/skills',operation:'set',value:true}]}}};
  const source=new Map([['entry.md',Buffer.from('entry')],['skills/review/SKILL.md',Buffer.from('review')]]);
  const binding={source:{type:'git',transport:'local',path:'../absent-source',ref:'main',subdirectory:'.'},commit:'a'.repeat(40),
    digest:contractDigest(Object.fromEntries([...source].map(([p,b])=>[p,sha256(b)]))),
    layout:{kind:'single-repo',repositories:{game:{path:'project',role:'code'}},documentation:{repository:'game',path:'docs'}}};
  const input={workspace,manifest:JSON.stringify(declaration),selected:['claude'],protectedPaths:['project'],source,binding};
  await applyDesiredFiles(input,{userHome,createDescriptor:true});
  await writeFile(path.join(workspace,'.claude/skills/custom.md'),'custom');
  await writeFile(path.join(workspace,'.mcp.json'),JSON.stringify({mcpServers:{pipeline:{command:'customized'},mine:{command:'mine'}}}));
  const remove=(options={})=>applyDesiredFiles({workspace,protectedPaths:[],backup:options.backup??false},{userHome,removeExisting:true,...options});
  return {workspace,userHome,input,remove};
}

test('offline removal deletes all owned/custom files, preserves shared fields, global config, descriptor and project',async t=>{
  const {workspace,userHome,remove,input}=await fixture(t);
  const descriptor=await readFile(path.join(workspace,'workspace.json')),global=await readFile(path.join(userHome,'.grok/config.toml'));
  const result=await remove();assert.equal(result.status,'removed');assert.equal(result.backupDirectory,null);
  for(const name of ['CLAUDE.md','.claude/skills'])await assert.rejects(stat(path.join(workspace,name)),{code:'ENOENT'});
  assert.deepEqual(JSON.parse(await readFile(path.join(workspace,'.mcp.json'),'utf8')),{mcpServers:{mine:{command:'mine'}}});
  assert.deepEqual(await readFile(path.join(userHome,'.grok/config.toml')),global);
  assert.deepEqual(await readFile(path.join(workspace,'workspace.json')),descriptor);
  assert.equal(await readFile(path.join(workspace,'project/game.cs'),'utf8'),'game');
  assert.deepEqual(await readdir(path.join(workspace,'.pipeline')),['desired-install.json']);
  assert.equal((await inspectDesiredInstallation(workspace,{userHome})).status,'not-installed');
  assert.equal((await remove()).mutations,0);
  await applyDesiredFiles(input,{userHome});
  assert.equal((await inspectDesiredInstallation(workspace,{userHome})).ready,true);
});
test('removal backup is opt-in and captures custom files and old local config',async t=>{
  const {remove}=await fixture(t),result=await remove({backup:true});
  assert.equal(await readFile(path.join(result.backupDirectory,'.claude/skills/custom.md'),'utf8'),'custom');
  assert.equal(JSON.parse(await readFile(path.join(result.backupDirectory,'.mcp.json'),'utf8')).mcpServers.pipeline.command,'customized');
  assert.equal(result.globalBackupDirectory,null);
});
test('interrupted removal resumes remaining files and local settings without fetching source',async t=>{
  const {workspace,remove,input,userHome}=await fixture(t);
  await assert.rejects(remove({boundary:async event=>{if(event==='after-delete')throw Error('interrupted');}}),/interrupted/);
  assert.equal((await inspectDesiredInstallation(workspace,{userHome})).status,'incomplete');
  await assert.rejects(applyDesiredFiles(input,{userHome}),e=>e.code==='desired.finish-remove-before-update');
  const pending=await readFile(path.join(workspace,'.pipeline/desired-pending.json'));
  for(const verb of ['setup','update','reset']) {
    let errors='';
    const code=await tryDesiredLifecycle([verb,'--workspace',workspace,'--yes'],
      {stdout:async()=>assert.fail('No success output expected'),stderr:async s=>{errors+=s;}},{hostOptions:{userHome}});
    assert.equal(code,2);assert.equal(JSON.parse(errors).error,'desired.finish-remove-before-update');
    assert.match(JSON.parse(errors).hint,/remove/);
    assert.deepEqual(await readFile(path.join(workspace,'.pipeline/desired-pending.json')),pending);
  }
  assert.equal((await remove()).status,'removed');
  assert.equal(JSON.parse(await readFile(path.join(workspace,'.mcp.json'),'utf8')).mcpServers.pipeline,undefined);
});
test('removal interrupted after readback completes its record on retry',async t=>{
  const {workspace,remove}=await fixture(t);
  await assert.rejects(remove({boundary:async event=>{if(event==='before-record')throw Error('record interruption');}}),/record interruption/);
  await assert.rejects(stat(path.join(workspace,'CLAUDE.md')),{code:'ENOENT'});
  assert.equal((await remove()).status,'removed');
  await assert.rejects(stat(path.join(workspace,'.pipeline/desired-pending.json')),{code:'ENOENT'});
});
test('nested repository blocks the entire removal, not just its own subtree',async t=>{
  const {workspace,remove}=await fixture(t);
  await mkdir(path.join(workspace,'.claude/skills/.git'));
  await assert.rejects(remove(),e=>e.code==='desired.unsafe-target');
  assert.equal(await readFile(path.join(workspace,'CLAUDE.md'),'utf8'),'entry');
  assert.equal(await readFile(path.join(workspace,'.claude/skills/custom.md'),'utf8'),'custom');
});
test('removal refuses pending installation and malformed local config without deleting content',async t=>{
  const {workspace,remove}=await fixture(t);
  const state=await readFile(path.join(workspace,'.pipeline/desired-install.json'));
  await writeFile(path.join(workspace,'.pipeline/desired-pending.json'),state);
  await assert.rejects(remove(),e=>e.code==='desired.finish-install-before-remove');
  await rm(path.join(workspace,'.pipeline/desired-pending.json'));
  await writeFile(path.join(workspace,'.mcp.json'),'{broken');
  await assert.rejects(remove());
  assert.equal(await readFile(path.join(workspace,'CLAUDE.md'),'utf8'),'entry');
});
test('removal revalidates old and new repository roots before deletion',async t=>{
  const {workspace,remove}=await fixture(t),file=path.join(workspace,'workspace.json');
  const descriptor=JSON.parse(await readFile(file,'utf8'));
  descriptor.layout.repositories.game.path='.claude/skills';
  await writeFile(file,JSON.stringify(descriptor));
  await assert.rejects(remove());
  assert.equal(await readFile(path.join(workspace,'.claude/skills/custom.md'),'utf8'),'custom');
});
test('public remove preview/cancel are read-only; confirmation removes without Git acquisition',async t=>{
  const {workspace,userHome}=await fixture(t);let out='',err='';
  const options={stdout:async s=>{out+=s;},stderr:async s=>{err+=s;}};
  const call=(flags,interaction={})=>tryDesiredLifecycle(['remove','--workspace',workspace,...flags],options,{hostOptions:{userHome},...interaction});
  assert.equal(await call(['--preview','--json']),0);assert.equal(JSON.parse(out).globalSettings,'preserved');
  assert.ok(JSON.parse(out).files.extra.some(e=>e.path.endsWith('custom.md')));
  out='';assert.equal(await call([],{isTTY:true,confirm:async()=>false}),0);assert.equal(JSON.parse(out).status,'cancelled');
  assert.equal(await readFile(path.join(workspace,'CLAUDE.md'),'utf8'),'entry');
  out='';assert.equal(await call(['--yes']),0);assert.equal(JSON.parse(out).status,'removed');
});
test('public remove refuses installation changed during confirmation',async t=>{
  const {workspace,userHome}=await fixture(t);let err='';
  const result=await tryDesiredLifecycle(['remove','--workspace',workspace],{stdout:async()=>{},stderr:async s=>{err+=s;}},
    {isTTY:true,display:async()=>{},hostOptions:{userHome},confirm:async()=>{
      const file=path.join(workspace,'.pipeline/desired-install.json');
      await writeFile(file,(await readFile(file,'utf8'))+' ');return true;
    }});
  assert.equal(result,2);assert.match(err,/desired.removal-state-changed/);
  assert.equal(await readFile(path.join(workspace,'CLAUDE.md'),'utf8'),'entry');
});
