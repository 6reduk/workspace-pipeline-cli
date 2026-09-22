import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp,mkdir,readdir,writeFile } from 'node:fs/promises';
import { acquireBootstrapLock,assertBootstrapLockHeld } from '../src/operations/bootstrap-lock.js';
import { acquireWorkspaceLock,assertLockHeld } from '../src/operations/lock.js';

async function fixture(){const parent=await mkdtemp(path.join(tmpdir(),'wpc-s7-bootstrap-'));return {parent,workspace:path.join(parent,'wrapper')};}
test('S7 bootstrap excludes duplicate creators without creating wrapper',async()=>{
  const {parent,workspace}=await fixture(),events=[];
  const lock=await acquireBootstrapLock(workspace,{onLocation:async e=>events.push(e)});
  await assertBootstrapLockHeld(lock);
  await assert.rejects(acquireBootstrapLock(workspace),e=>e.code==='bootstrap-lock.busy');
  assert.deepEqual(await readdir(parent),[path.basename(lock.directory)]);
  assert.equal(events.at(-1).directory,lock.directory);
  await lock.release();assert.deepEqual(await readdir(parent),[]);
  await assert.rejects(assertBootstrapLockHeld(lock),e=>e.code==='bootstrap-lock.released');
});
test('S7 bootstrap permits separate wrappers and rejects forged capability',async()=>{
  const {parent,workspace}=await fixture();
  const first=await acquireBootstrapLock(workspace),second=await acquireBootstrapLock(path.join(parent,'other'));
  await assert.rejects(assertBootstrapLockHeld({...first}),e=>e.code==='bootstrap-lock.capability');
  await second.release();await first.release();
});
test('S7 interrupted bootstrap owner initialization remains locked for review',async()=>{
  const {workspace}=await fixture();let location;
  await assert.rejects(acquireBootstrapLock(workspace,{ioBoundary:async()=>{throw Error('synthetic crash');}}),e=>{
    location=e.bootstrapDirectory;return e.code==='bootstrap-lock.io' && Boolean(location);
  });
  assert.deepEqual(await readdir(location),[]);
  await assert.rejects(acquireBootstrapLock(workspace),e=>e.code==='bootstrap-lock.busy');
});
test('S7 bootstrap preserves changed owner and foreign files',async()=>{
  const {workspace}=await fixture(),lock=await acquireBootstrapLock(workspace);
  await writeFile(path.join(lock.directory,'foreign.txt'),'preserve');
  await assert.rejects(lock.release(),e=>e.code==='bootstrap-lock.foreign-entry');
  await writeFile(path.join(lock.directory,'owner.json'),'{}');
  await assert.rejects(lock.release(),e=>e.code==='bootstrap-lock.owner-changed');
  assert.deepEqual((await readdir(lock.directory)).sort(),['foreign.txt','owner.json']);
});
test('S7 bootstrap can remain held across normal workspace lock handoff',async()=>{
  const {workspace}=await fixture(),bootstrap=await acquireBootstrapLock(workspace);
  await mkdir(workspace); // Synthetic stand-in for the later approved executor.
  const ordinary=await acquireWorkspaceLock(workspace,{repositoryOperation:bootstrap});
  await assertBootstrapLockHeld(bootstrap);await assertLockHeld(ordinary);
  await assert.rejects(acquireBootstrapLock(workspace),e=>e.code==='bootstrap-lock.busy');
  await assertLockHeld(ordinary);await ordinary.release();await bootstrap.release();
});
test('S7 missing bootstrap parent is a zero-write blocker',async()=>{
  const {parent}=await fixture();
  await assert.rejects(acquireBootstrapLock(path.join(parent,'missing','wrapper')),e=>e.code==='bootstrap-lock.parent-missing');
  assert.deepEqual(await readdir(parent),[]);
});
