import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {inspectMigrationPending} from '../src/operations/migration-pending.js';
import {assertNoRepositoryPending} from '../src/operations/repository-pending.js';
import {acquireWorkspaceLock,assertLockHeld,assertMigrationLockHeld} from '../src/operations/lock.js';
import {inspectHistory} from '../src/operations/history.js';
import {inspectInstallation} from '../src/operations/doctor.js';
import {prepareLifecycle} from '../src/operations/lifecycle.js';
import {providerRegistry} from '../src/providers/registry.js';
const root=()=>mkdtemp(path.join(tmpdir(),'wpc-s10-pending-'));
test('absent marker observation creates nothing',async()=>{
 const w=await root();assert.equal((await inspectMigrationPending(w)).blocked,false);
 assert.deepEqual(await readdir(w),[]);
});
test('empty malformed and directory markers block lock/history/setup and never report ready',async()=>{
 for(const value of ['', '{"partial":',null]){
  const w=await root(),meta=path.join(w,'.pipeline'),marker=path.join(meta,'migration-operation.json');
  await mkdir(meta);if(value===null)await mkdir(marker);else await writeFile(marker,value);
  assert.equal((await inspectMigrationPending(w)).blocked,true);
  await assert.rejects(()=>acquireWorkspaceLock(w),e=>e.code==='migration.pending');
  await assert.rejects(()=>acquireWorkspaceLock(w,{repositoryOperation:{}}),e=>e.code==='migration.pending');
  await assert.rejects(()=>assertNoRepositoryPending(w),e=>e.code==='migration.pending');
  const history=await inspectHistory(w);assert.equal(history.complete,false);assert.equal(history.diagnostics[0].code,'migration.pending');
  const doctor=await inspectInstallation(w);assert.equal(doctor.ready,false);assert.equal(doctor.status,'needs-reconciliation');assert.equal(doctor.automaticActions,false);
  await assert.rejects(()=>prepareLifecycle({command:'setup',wrapper:w},providerRegistry),e=>e.code==='lifecycle.history');
  assert.deepEqual(await readdir(meta),['migration-operation.json']);
  if(value!==null)assert.equal(await readFile(marker,'utf8'),value);
 }
});
test('marker appearing after lock acquisition invalidates write capability, without stealing lock',async()=>{
 const w=await root(),lock=await acquireWorkspaceLock(w);
 try{
  await assert.rejects(()=>assertMigrationLockHeld(lock,'any','any'),e=>e.code==='migration.lock-capability');
  await writeFile(path.join(w,'.pipeline/migration-operation.json'),'{}');
  await assert.rejects(()=>assertLockHeld(lock),e=>e.code==='migration.pending');
 }finally{await lock.release();}
 assert.deepEqual(await readdir(path.join(w,'.pipeline')),['migration-operation.json']);
});
