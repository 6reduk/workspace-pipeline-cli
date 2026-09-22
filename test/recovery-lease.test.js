import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,mkdir,symlink} from 'node:fs/promises';
import {Server} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {acquireRecoveryLease,assertRecoveryLeaseHeld,withRecoveryLease} from '../src/operations/recovery-lease.js';

const supported=['win32','linux'].includes(process.platform);
const moduleUrl=new URL('../src/operations/recovery-lease.js',import.meta.url).href;
async function fixture(){return path.join(await mkdtemp(path.join(tmpdir(),'wpc-lease-')),'wrapper');}
async function child(wrapper) {
  const p=spawn(process.execPath,['--input-type=module','-e',
    `import {acquireRecoveryLease} from ${JSON.stringify(moduleUrl)};
     try {await acquireRecoveryLease(process.argv[1]);process.send('held');}
     catch(e){process.send(e.code);process.exitCode=2;process.disconnect();}
     process.on('message',()=>process.exit(23));`,wrapper],{stdio:['ignore','ignore','pipe','ipc']});
  const exited=once(p,'exit');
  const [message]=await once(p,'message');return {p,message,exited};
}
test('S7 recovery lease rejects concurrent owner and is workspace scoped',{skip:!supported},async()=>{
  const wrapper=await fixture(),lease=await acquireRecoveryLease(wrapper);
  try {
    assertRecoveryLeaseHeld(lease);
    await assert.rejects(acquireRecoveryLease(wrapper),e=>e.code==='recovery-lease.busy');
    const other=await acquireRecoveryLease(wrapper+'-other');await other.release();
    const c=await child(wrapper);assert.equal(c.message,'recovery-lease.busy');await c.exited;
    assert.deepEqual(await readdir(path.dirname(wrapper)),[]);
  }finally{await lease.release();}
  assert.throws(()=>assertRecoveryLeaseHeld(lease));assert.throws(()=>assertRecoveryLeaseHeld({}));
});
test('S7 recovery lease is released by process death and repeated acquisition',{skip:!supported},async()=>{
  const wrapper=await fixture();
  for(let i=0;i<3;i++) {
    const c=await child(wrapper);assert.equal(c.message,'held');
    await assert.rejects(acquireRecoveryLease(wrapper),e=>e.code==='recovery-lease.busy');
    c.p.send('exit');assert.equal((await c.exited)[0],23);
    await withRecoveryLease(wrapper,async lease=>assertRecoveryLeaseHeld(lease));
  }
  assert.deepEqual(await readdir(path.dirname(wrapper)),[]);
});
test('S7 recovery lease releases after a callback failure',{skip:!supported},async()=>{
  const wrapper=await fixture();
  await assert.rejects(withRecoveryLease(wrapper,async()=>{throw new Error('injected');}),/injected/);
  await withRecoveryLease(wrapper,async()=>{});
});

test('S7 recovery lease rejects linked wrapper roots before acquiring',{skip:!supported},async()=>{
  const wrapper=await fixture(),alias=wrapper+'-alias';await mkdir(wrapper);
  await symlink(wrapper,alias,process.platform==='win32'?'junction':'dir');
  await assert.rejects(acquireRecoveryLease(alias),e=>e.code==='layout.link');
  await withRecoveryLease(wrapper,async()=>{});
});

test('S7 recovery lease closes a listener invalidated by asynchronous error',{skip:!supported},async t=>{
  const wrapper=await fixture(),listen=Server.prototype.listen;let server;
  const spy=t.mock.method(Server.prototype,'listen',function(...args){server=this;return listen.apply(this,args);});
  await assert.rejects(withRecoveryLease(wrapper,async lease=>{
    server.emit('error',new Error('private injected error'));
    assert.throws(()=>assertRecoveryLeaseHeld(lease),e=>e.code==='recovery-lease.not-held');
  }),e=>e.code==='recovery-lease.lost-status-required');
  assert.equal(server.listening,false);spy.mock.restore();
  await withRecoveryLease(wrapper,async()=>{});
});

test('S7 recovery lease distinguishes release-phase errors from callback failure',{skip:!supported},async t=>{
  const wrapper=await fixture(),close=Server.prototype.close;
  const spy=t.mock.method(Server.prototype,'close',function(callback){
    return close.call(this,()=>callback(new Error('private close failure')));
  });
  await assert.rejects(withRecoveryLease(wrapper,async()=>({completed:true})),
    e=>e.code==='recovery-lease.release-failed-status-required' && !e.message.includes('private'));
  await assert.rejects(withRecoveryLease(wrapper,async()=>{throw new Error('private run failure');}),
    e=>e.code==='recovery-lease.run-and-release-failed-status-required');
  spy.mock.restore();await withRecoveryLease(wrapper,async()=>{});
});

test('S7 recovery lease labels EACCES as ambiguous instead of proven contention',{skip:!supported},async t=>{
  const wrapper=await fixture();
  t.mock.method(Server.prototype,'listen',function(){
    queueMicrotask(()=>this.emit('error',Object.assign(new Error('private path'),{code:'EACCES'})));
    return this;
  });
  await assert.rejects(acquireRecoveryLease(wrapper),e=>e.code==='recovery-lease.busy-or-access-denied');
});
