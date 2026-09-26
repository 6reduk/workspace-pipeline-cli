import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,mkdir,readFile,writeFile,rm,stat,readdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {applyDesiredFiles} from '../src/desired-state/apply-files.js';
import {inspectDesiredLock,recoverDesiredLock} from '../src/desired-state/lock-recovery.js';
import {tryDesiredLifecycle} from '../src/commands/desired-lifecycle.js';
import {acquireWorkspaceLock} from '../src/operations/lock.js';
import {acquireRecoveryLease} from '../src/operations/recovery-lease.js';
import {inspectDesiredInstallation} from '../src/desired-state/doctor.js';

async function fixture(t) {
  const root=await mkdtemp(path.join(os.tmpdir(),'wpc-desired-recover-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const workspace=path.join(root,'workspace'),userHome=path.join(root,'profile');
  await mkdir(workspace);await mkdir(userHome);await mkdir(path.join(workspace,'project'));
  await writeFile(path.join(workspace,'project/game.cs'),'game');
  const manifest=JSON.stringify({schemaVersion:2,id:'test',version:'1.0.0',adapters:{claude:{providers:['claude','grok'],
    files:[{source:'entry.md',target:'CLAUDE.md',kind:'file'}],settings:[
      {target:'grok.user',pointer:'/compat/claude/skills',operation:'set',value:true}]}}});
  const input={workspace,manifest,selected:['claude'],protectedPaths:['project'],source:new Map([['entry.md',Buffer.from('delivered')]])};
  await applyDesiredFiles(input,{userHome});
  await writeFile(path.join(workspace,'CLAUDE.md'),'customized');
  return {root,workspace,userHome,input};
}
async function crashedWriter(t,fixture) {
  const script=`import {applyDesiredFiles} from ${JSON.stringify(new URL('../src/desired-state/apply-files.js',import.meta.url).href)};
    const p=JSON.parse(process.argv[1]);p.input.source=new Map([['entry.md',Buffer.from('delivered')]]);
    await applyDesiredFiles(p.input,{userHome:p.userHome,boundary:async event=>{
      if(event==='after-delete'){process.send('ready');setInterval(()=>{},1000);await new Promise(()=>{});}
    }});`;
  const child=spawn(process.execPath,['--input-type=module','-e',script,JSON.stringify({input:{...fixture.input,source:undefined},userHome:fixture.userHome})],
    {windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
  let stderr='';child.stderr.on('data',b=>{stderr+=b;});
  const exited=once(child,'exit');let stopped=false;
  async function stop(){if(!stopped){stopped=true;if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;}}
  t.after(stop);
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('child timeout: '+stderr)),30000);
    child.once('message',m=>{clearTimeout(timer);m==='ready'?resolve():reject(Error('unexpected message'));});
    child.once('exit',()=>{clearTimeout(timer);reject(Error('child exited: '+stderr));});
    child.once('error',e=>{clearTimeout(timer);reject(e);});
  });
  await stop();return child.pid;
}

test('killed writer: recover workspace and explicit global lock, preserve pending/config, then retry',async t=>{
  const f=await fixture(t),pid=await crashedWriter(t,f);
  const pending=await readFile(path.join(f.workspace,'.pipeline/desired-pending.json'));
  const config=await readFile(path.join(f.userHome,'.grok/config.toml'));
  for(const global of [false,true]) {
    const options={userHome:f.userHome,global};
    const observed=await inspectDesiredLock(f.workspace,options);
    assert.equal(observed.status,'stopped-owner-observed');assert.equal(observed.lock.owner.pid,pid);
    const result=await recoverDesiredLock(f.workspace,observed,options);
    assert.equal(result.status,'lock-retired');
    assert.equal(result.archive,undefined);
    const names=await readdir(path.dirname(observed.path));
    assert.equal(names.some(n=>n.includes('-retiring-')||n==='recovered-locks'),false);
    await assert.rejects(stat(observed.path),{code:'ENOENT'});
  }
  assert.deepEqual(await readFile(path.join(f.workspace,'.pipeline/desired-pending.json')),pending);
  assert.deepEqual(await readFile(path.join(f.userHome,'.grok/config.toml')),config);
  assert.equal(await readFile(path.join(f.workspace,'project/game.cs'),'utf8'),'game');
  await applyDesiredFiles(f.input,{userHome:f.userHome});
  assert.equal(await readFile(path.join(f.workspace,'CLAUDE.md'),'utf8'),'delivered');
});
test('live owner is never retired and legacy/unknown purpose is refused',async t=>{
  const f=await fixture(t),lock=await acquireWorkspaceLock(f.workspace,{purpose:'desired-state'});
  try{
    const observed=await inspectDesiredLock(f.workspace);assert.equal(observed.status,'owner-unconfirmed');
    const report=await inspectDesiredInstallation(f.workspace,{userHome:f.userHome});
    assert.equal(report.ready,false);assert.ok(report.diagnostics.some(d=>d.code==='desired.workspace-lock-present'));
    await assert.rejects(recoverDesiredLock(f.workspace,observed),e=>e.code==='desired.recovery-owner-unconfirmed');
  }finally{await lock.release();}
  const legacy=await acquireWorkspaceLock(f.workspace);
  try{await assert.rejects(inspectDesiredLock(f.workspace),e=>e.code==='desired.recovery-owner-invalid');}
  finally{await legacy.release();}
});
test('owner changes, foreign entries, wrong workspace and other repository operations refuse recovery',async t=>{
  const f=await fixture(t);await crashedWriter(t,f);
  const observed=await inspectDesiredLock(f.workspace),file=path.join(observed.path,'owner.json');
  await writeFile(file,(await readFile(file,'utf8'))+' ');
  await assert.rejects(recoverDesiredLock(f.workspace,observed),e=>e.code==='desired.recovery-observation-changed');
  await writeFile(path.join(observed.path,'foreign'),'untouched');
  await assert.rejects(inspectDesiredLock(f.workspace),e=>e.code==='desired.recovery-foreign-entry');
  const other=path.join(f.root,'other');await mkdir(other);
  await assert.rejects(inspectDesiredLock(other,{userHome:f.userHome,global:true}),e=>e.code==='desired.recovery-owner-invalid');
  await writeFile(path.join(f.workspace,'.pipeline/repository-operation.json'),'{}');
  await assert.rejects(inspectDesiredLock(f.workspace),e=>e.code==='lock.repository-pending');
  assert.equal(await readFile(path.join(observed.path,'foreign'),'utf8'),'untouched');
});
test('recovery serializes through OS lease and CLI preview/cancel do not release locks',async t=>{
  const f=await fixture(t);await crashedWriter(t,f);
  const observed=await inspectDesiredLock(f.workspace),lease=await acquireRecoveryLease(f.workspace);
  try{await assert.rejects(recoverDesiredLock(f.workspace,observed),e=>e.code.startsWith('recovery-lease.'));}
  finally{await lease.release();}
  async function call(flags,interaction={}) {
    let out='',err='';const code=await tryDesiredLifecycle(['recover-lock','--workspace',f.workspace,...flags],
      {stdout:async s=>{out+=s;},stderr:async s=>{err+=s;}},{display:async()=>{},hostOptions:{userHome:f.userHome},...interaction});
    return {code,out,err,value:out?JSON.parse(out):null};
  }
  let r=await call(['--preview']);assert.equal(r.code,0,r.err);assert.equal(r.value.applied,false);
  r=await call([],{isTTY:true,confirm:async()=>false});assert.equal(r.value.status,'cancelled');
  assert.equal((await inspectDesiredLock(f.workspace)).status,'stopped-owner-observed');
  r=await call(['--yes']);assert.equal(r.code,0,r.err);assert.equal(r.value.status,'lock-retired');
  r=await call(['--global','--yes']);assert.equal(r.code,0,r.err);assert.equal(r.value.global,true);
  r=await call(['--yes']);assert.equal(r.value.status,'no-lock');
});
test('unknown host, empty owner directory and old token-only global owner are not force-unlocked',async t=>{
  const f=await fixture(t);await crashedWriter(t,f);
  const directory=path.join(f.workspace,'.pipeline/lock'),file=path.join(directory,'owner.json');
  const owner=JSON.parse(await readFile(file,'utf8'));owner.host='different-test-host';
  await writeFile(file,JSON.stringify(owner));
  const observed=await inspectDesiredLock(f.workspace);assert.equal(observed.lock.liveness,'unknown-host');
  await assert.rejects(recoverDesiredLock(f.workspace,observed),e=>e.code==='desired.recovery-owner-unconfirmed');
  await rm(file);
  await assert.rejects(inspectDesiredLock(f.workspace),e=>e.code==='desired.recovery-foreign-entry');
  assert.equal((await stat(directory)).isDirectory(),true);
  const globalOwner=path.join(f.userHome,'.grok/.wpc-config-lock/owner');
  await writeFile(globalOwner,'old-token-only');
  await assert.rejects(inspectDesiredLock(f.workspace,{userHome:f.userHome,global:true}));
  assert.equal(await readFile(globalOwner,'utf8'),'old-token-only');
});
