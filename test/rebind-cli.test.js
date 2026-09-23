import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,mkdir,writeFile,readFile,unlink} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {parseCommand,runCli} from '../src/commands/dispatch.js';
import {providerRegistry} from '../src/providers/registry.js';
import {sha256} from '../src/source/inventory.js';
import {acquireWorkspaceLock} from '../src/operations/lock.js';
import {applyPrepared} from '../src/operations/apply.js';

test('rebind parser requires explicit source approval and separate file apply',()=>{
  const root=path.resolve('fixture'),file=path.resolve('proposal.json');
  assert.equal(parseCommand(['rebind','--workspace',root,'--manifest',file]).command,'rebind');
  assert.equal(parseCommand(['update','--workspace',root,'--accept-rebind',file]).rebindFile,file);
  for(const args of [
    ['rebind','--workspace',root],['rebind','--workspace',root,'--manifest',file,'--network'],
    ['rebind','--workspace',root,'--manifest',file,'--apply'],
    ['rebind','--workspace',root,'--manifest',file,'--manifest',file],
    ['update','--workspace',root,'--accept-rebind',file,'--manifest',file],
    ['update','--workspace',root,'--accept-rebind',file,'--apply','--preview',file],
    ...['setup','repair','remove','switch','continue'].map(c=>[c,'--workspace',root,'--accept-rebind',file]),
  ])assert.throws(()=>parseCommand(args));
});

for(const interrupted of [false,true])test('public rebind and skill rename preserve ownership; interrupted='+interrupted,async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wpc-rebind-cli-'));
  const wrapper=path.join(root,'workspace'),source=path.join(root,'source');
  await mkdir(wrapper);await mkdir(source);
  const pipeline={schemaVersion:1,id:'sample',version:'1.0.0',resources:'resources',inventory:'inventory.json',
    agentsDocument:{mode:'default'},providers:{codex:{skills:'skills',agents:null,mcp:null,entryInstructions:null,requires:[]}}};
  const files={'pipeline.json':JSON.stringify(pipeline),'resources/process.md':'Do not execute tasks.',
    'skills/unity-review/SKILL.md':'---\nname: unity-review\ndescription: Inert fixture\n---\nNo actions requested.\n'};
  for(const [name,bytes] of Object.entries(files)) {
    const p=path.join(source,name);await mkdir(path.dirname(p),{recursive:true});await writeFile(p,bytes);
  }
  await writeFile(path.join(source,'inventory.json'),JSON.stringify(Object.fromEntries(Object.entries(files).map(([p,b])=>[p,sha256(Buffer.from(b))]))));
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^GIT_/i.test(k)));
  Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'});
  for(const args of [['init','--initial-branch=main','--template='],['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture']]) {
    const r=spawnSync('git',['-C',source,'-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],{env,encoding:'utf8',windowsHide:true});
    assert.equal(r.status,0,r.stderr);
  }
  const manifest={schemaVersion:1,pipeline:{type:'git',transport:'local',path:'source',ref:'main',subdirectory:'.'},providers:['codex'],
    layout:{kind:'single-repo',repositories:{game:{path:'project',role:'code'}},documentation:{repository:'game',path:'docs'}}};
  const old=path.join(root,'old.json'),next=path.join(wrapper,'workspace.json');
  await writeFile(old,JSON.stringify(manifest));
  await writeFile(next,JSON.stringify({...manifest,pipeline:{...manifest.pipeline,path:'../source'}}));
  async function run(args) {
    let out='',err='';const code=await runCli(args,{registry:providerRegistry,stdout:s=>{out+=s;},stderr:s=>{err+=s;}});
    return {code,out,err};
  }
  const preparedFile=path.join(root,'prepared.json'),proposalFile=path.join(root,'proposal.json');
  let r=await run(['setup','--workspace',wrapper,'--manifest',old]);assert.equal(r.code,0,r.err);
  await writeFile(preparedFile,r.out);
  r=await run(['setup','--workspace',wrapper,'--apply','--preview',preparedFile]);assert.equal(r.code,0,r.err);
  const statePath=path.join(wrapper,'.pipeline/state.json'),before=await readFile(statePath,'utf8');
  // Rename a source skill while keeping the provider selected.
  const oldSkill=path.join(wrapper,'.agents/skills/unity-review/SKILL.md');
  const oldSkillBytes=await readFile(oldSkill);
  files['skills/sdx-review/SKILL.md']=files['skills/unity-review/SKILL.md'].replace('name: unity-review','name: sdx-review');
  delete files['skills/unity-review/SKILL.md'];
  await unlink(path.join(source,'skills/unity-review/SKILL.md'));
  await mkdir(path.join(source,'skills/sdx-review'));
  await writeFile(path.join(source,'skills/sdx-review/SKILL.md'),files['skills/sdx-review/SKILL.md']);
  await writeFile(path.join(source,'inventory.json'),JSON.stringify(Object.fromEntries(Object.entries(files).map(([p,b])=>[p,sha256(Buffer.from(b))]))));
  for(const args of [['add','--all'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','rename fixture skill']]) {
    const r=spawnSync('git',['-C',source,'-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],{env,encoding:'utf8',windowsHide:true});
    assert.equal(r.status,0,r.stderr);
  }
  const outputFailure=await runCli(['rebind','--workspace',wrapper,'--manifest',next],{
    stdout:()=>{throw Error('closed output');},stderr:()=>{},registry:providerRegistry});
  assert.equal(outputFailure,2);
  assert.equal(await readFile(statePath,'utf8'),before);
  r=await run(['update','--workspace',wrapper,'--manifest',next]);assert.match(r.err,/source-rebind-required/);
  r=await run(['rebind','--workspace',wrapper,'--manifest',next]);assert.equal(r.code,0,r.err);
  assert.equal(JSON.parse(r.out).sourceAccessAuthorized,false);
  await writeFile(proposalFile,r.out);
  const originalNext=await readFile(next,'utf8');await writeFile(next,originalNext+'\n');
  r=await run(['update','--workspace',wrapper,'--accept-rebind',proposalFile]);assert.match(r.err,/rebind.drift/);
  await writeFile(next,originalNext);
  const proposal=JSON.parse(await readFile(proposalFile,'utf8'));
  await writeFile(proposalFile,JSON.stringify({kind:'rebind-preview'}));
  r=await run(['update','--workspace',wrapper,'--accept-rebind',proposalFile]);assert.match(r.err,/rebind.proposal/);
  await writeFile(proposalFile,JSON.stringify({...proposal,workspace:root}));
  r=await run(['update','--workspace',wrapper,'--accept-rebind',proposalFile]);assert.match(r.err,/rebind.drift/);
  await writeFile(proposalFile,JSON.stringify({...proposal,beforeStateHash:'sha256:'+'0'.repeat(64)}));
  r=await run(['update','--workspace',wrapper,'--accept-rebind',proposalFile]);assert.match(r.err,/rebind.drift/);
  await writeFile(proposalFile,JSON.stringify(proposal));
  await writeFile(oldSkill,'user customization');
  r=await run(['update','--workspace',wrapper,'--accept-rebind',proposalFile]);assert.match(r.err,/ownership.drift/);
  assert.equal(await readFile(oldSkill,'utf8'),'user customization');
  await writeFile(oldSkill,oldSkillBytes);
  const userFile=path.join(wrapper,'.agents/skills/unity-review/notes.md');await writeFile(userFile,'keep user addition');
  r=await run(['update','--workspace',wrapper,'--accept-rebind',proposalFile]);assert.equal(r.code,0,r.err);
  assert.ok(JSON.parse(r.out).preview.plan.targets.some(t=>t.path==='.agents/skills/unity-review/SKILL.md' && t.action==='delete'));
  assert.equal(await readFile(statePath,'utf8'),before);
  await writeFile(preparedFile,r.out);
  await writeFile(oldSkill,'changed after preview');
  r=await run(['update','--workspace',wrapper,'--apply','--preview',preparedFile]);
  assert.notEqual(r.code,0);
  assert.equal(await readFile(oldSkill,'utf8'),'changed after preview');
  assert.equal(await readFile(statePath,'utf8'),before);
  await writeFile(oldSkill,oldSkillBytes);
  if(interrupted) {
    const prepared=JSON.parse(await readFile(preparedFile,'utf8'));
    const lock=await acquireWorkspaceLock(wrapper);let journal;
    try {
      const stopped=await applyPrepared(lock,prepared,{decision:'approve',preparedDigest:prepared.digest},
        providerRegistry,JSON.parse(before),{onJournal:event=>{journal=event.relative;},
          ioBoundary:event=>{if(event.purpose==='target' && event.phase==='deleted')throw Error('synthetic stop after deletion');}});
      assert.equal(stopped.status,'needs-reconciliation');
    }finally{await lock.release();}
    const recovery=journal.replace('/journals/','/transactions/')+'/recovery.json';
    const historical=await readFile(path.join(wrapper,recovery));
    r=await run(['continue','--workspace',wrapper,'--recovery',recovery]);assert.equal(r.code,0,r.err);
    assert.ok(JSON.parse(r.out).preview.plan.targets.some(t=>t.path==='.agents/skills/unity-review/SKILL.md' && t.action==='verify-absent'));
    await writeFile(preparedFile,r.out);
    r=await run(['continue','--workspace',wrapper,'--apply','--preview',preparedFile]);assert.equal(r.code,0,r.err);
    assert.deepEqual(await readFile(path.join(wrapper,recovery)),historical);
  } else {
    r=await run(['update','--workspace',wrapper,'--apply','--preview',preparedFile]);assert.equal(r.code,0,r.err);
  }
  assert.equal(JSON.parse(await readFile(statePath,'utf8')).active.snapshot.origin.path,next);
  await assert.rejects(readFile(oldSkill),e=>e.code==='ENOENT');
  assert.ok((await readFile(path.join(wrapper,'.agents/skills/sdx-review/SKILL.md'),'utf8')).includes('sdx-review'));
  assert.equal(await readFile(userFile,'utf8'),'keep user addition');
  assert.equal(await readFile(old,'utf8'),JSON.stringify(manifest));
  r=await run(['update','--workspace',wrapper,'--accept-rebind',proposalFile]);assert.match(r.err,/rebind.drift/);
  r=await run(['doctor','--workspace',wrapper]);assert.equal(r.code,0,r.err);
});
