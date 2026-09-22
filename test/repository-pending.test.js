import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp,mkdir,writeFile,readdir,readFile } from 'node:fs/promises';
import { acquireWorkspaceLock,assertLockHeld } from '../src/operations/lock.js';
import { acquireBootstrapLock,bootstrapLockDirectory } from '../src/operations/bootstrap-lock.js';
import { inspectRepositoryPending } from '../src/operations/repository-pending.js';
import { runCli } from '../src/commands/dispatch.js';

async function fixture() {
  const parent=await mkdtemp(path.join(tmpdir(),'wpc-pending-')),workspace=path.join(parent,'wrapper');
  await mkdir(workspace);return workspace;
}
test('S7 pending guard blocks malformed repository marker without writing lock files',async()=>{
  const workspace=await fixture();await mkdir(path.join(workspace,'.pipeline'));
  const marker=path.join(workspace,'.pipeline/repository-operation.json');await writeFile(marker,'{');
  await assert.rejects(acquireWorkspaceLock(workspace),e=>e.code==='lock.repository-pending');
  assert.deepEqual(await readdir(path.join(workspace,'.pipeline')),['repository-operation.json']);
  assert.equal(await readFile(marker,'utf8'),'{');
});
test('S7 pending guard blocks bootstrap and recovery remnants including malformed entries',async()=>{
  for(const suffix of ['', '.recovery', '.recovery-resume']) {
    const workspace=await fixture();await writeFile(bootstrapLockDirectory(workspace)+suffix,'not a valid lock');
    assert.equal((await inspectRepositoryPending(workspace)).blocked,true);
    await assert.rejects(acquireWorkspaceLock(workspace),e=>e.code==='lock.repository-pending');
    if(suffix)await assert.rejects(acquireBootstrapLock(workspace),e=>e.code==='bootstrap-lock.recovery-pending');
    assert.deepEqual(await readdir(workspace),[]);
  }
});
test('S7 pending guard admits only the real same-workspace bootstrap capability',async()=>{
  const workspace=await fixture(),other=await fixture(),bootstrap=await acquireBootstrapLock(workspace);
  await assert.rejects(acquireWorkspaceLock(workspace),e=>e.code==='lock.repository-pending');
  await assert.rejects(acquireWorkspaceLock(workspace,{repositoryOperation:{...bootstrap}}),e=>e.code==='bootstrap-lock.capability');
  await assert.rejects(acquireWorkspaceLock(other,{repositoryOperation:bootstrap}),e=>e.code==='lock.repository-capability');
  const lock=await acquireWorkspaceLock(workspace,{repositoryOperation:bootstrap});
  await assertLockHeld(lock);await lock.release();await bootstrap.release();
});
test('S7 pending guard rechecks a held ordinary lock but permits safe release',async()=>{
  const workspace=await fixture(),lock=await acquireWorkspaceLock(workspace);
  await writeFile(path.join(workspace,'.pipeline/repository-operation.json'),'{}');
  await assert.rejects(assertLockHeld(lock),e=>e.code==='lock.repository-pending');
  await lock.release();
  assert.deepEqual(await readdir(path.join(workspace,'.pipeline')),['repository-operation.json']);
});
test('S7 pending guard stops all trusted lifecycle previews before source access',async()=>{
  const workspace=await fixture();await mkdir(path.join(workspace,'.pipeline'));
  await writeFile(path.join(workspace,'.pipeline/repository-operation.json'),'{}');
  for(const command of ['setup','update','repair','remove','switch','continue']) {
    const args=[command,'--workspace',workspace];
    if(command==='switch')args.push('--manifest',path.join(workspace,'absent.json'));
    if(command==='continue')args.push('--recovery','.pipeline/transactions/11111111-1111-1111-1111-111111111111/recovery.json');
    let out='',err='';
    const code=await runCli(args,{registry:{},stdout:s=>{out+=s;},stderr:s=>{err+=s;}});
    assert.equal(code,2);assert.equal(out,'');assert.equal(JSON.parse(err).error,'lock.repository-pending');
  }
  assert.deepEqual(await readdir(workspace),['.pipeline']);
});
test('S7 doctor reports repository pending read-only rather than readiness',async()=>{
  const workspace=await fixture();await mkdir(path.join(workspace,'.pipeline'));
  await writeFile(path.join(workspace,'.pipeline/repository-operation.json'),'{}');
  let out='',err='';
  assert.equal(await runCli(['doctor','--workspace',workspace],{stdout:s=>{out+=s;},stderr:s=>{err+=s;}}),1);
  assert.equal(err,'');const result=JSON.parse(out);assert.equal(result.ready,false);
  assert.ok(result.diagnostics.some(d=>d.code==='repository.pending'));
  assert.deepEqual(await readdir(path.join(workspace,'.pipeline')),['repository-operation.json']);
});
