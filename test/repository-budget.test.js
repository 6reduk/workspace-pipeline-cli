import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { repositoryBudget, REPOSITORY_TRANSPORT_LIMITS } from '../src/source/repository-budget.js';
import { LIMITS } from '../src/source/inventory.js';
import { runGit, runRepositoryGit } from '../src/source/git.js';

function runtime({hang=false}={}) {
  let calls=0;
  return {platform:'win32',get calls(){return calls;},spawn(executable){
    calls++;
    const child=new EventEmitter();
    if(executable==='taskkill'){setImmediate(()=>child.emit('exit',1));return child;}
    child.pid=12345;
    child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.kill=()=>{setImmediate(()=>child.emit('close',1));return true;};
    child.unref=()=>{};
    if(!hang)setImmediate(()=>child.emit('close',0));
    return child;
  }};
}

test('repository transport budgets are explicit finite bounds, independent of S2',()=>{
  assert.deepEqual(repositoryBudget(),REPOSITORY_TRANSPORT_LIMITS);
  assert.equal(LIMITS.pack,256*1024*1024);
  assert.equal(LIMITS.gitMs,120000);assert.equal(LIMITS.acquisitionMs,300000);
  for(const [key,max] of Object.entries(REPOSITORY_TRANSPORT_LIMITS)) {
    assert.equal(repositoryBudget({[key]:max})[key],max);
    for(const value of [max+1,0,-1,NaN,Infinity,1.5,'1'])
      assert.throws(()=>repositoryBudget({[key]:value}),e=>e.code==='repository-source.'+key+'-limit');
  }
  assert.throws(()=>repositoryBudget({gitMs:20,acquisitionMs:10}),e=>e.code==='repository-source.time-limits');
});

test('repository runner accepts pack budget above S2 while package runner rejects it before spawning',async()=>{
  const requested={packLimit:LIMITS.pack+1,gitMs:LIMITS.gitMs+1,acquisitionMs:LIMITS.acquisitionMs+1};
  const repo=runtime();await runRepositoryGit(tmpdir(),['--version'],requested,repo);assert.equal(repo.calls,1);
  const source=runtime();await assert.rejects(runGit(tmpdir(),['--version'],requested,source),e=>e.code==='source.pack-limit');
  assert.equal(source.calls,0);
});

test('repository listing permits a bounded larger output cap without weakening S2',async()=>{
  await runRepositoryGit(tmpdir(),['--version'],{outputLimit:256*1024*1024},runtime());
  await assert.rejects(runRepositoryGit(tmpdir(),['--version'],{outputLimit:256*1024*1024+1},runtime()),e=>e.code==='source.output-limit');
  await assert.rejects(runGit(tmpdir(),['--version'],{outputLimit:LIMITS.blob+1},runtime()),e=>e.code==='source.output-limit');
});

test('repository per-command and acquisition deadlines both terminate bounded owned children',async()=>{
  await assert.rejects(runRepositoryGit(tmpdir(),['--version'],{gitMs:5},runtime({hang:true})),e=>e.code==='source.timeout');
  await assert.rejects(runRepositoryGit(tmpdir(),['--version'],{deadline:performance.now()+5},runtime({hang:true})),e=>e.code==='source.timeout');
  const r=runtime();
  await assert.rejects(runRepositoryGit(tmpdir(),['--version'],{deadline:performance.now()-1},r),e=>e.code==='source.timeout');
  assert.equal(r.calls,0);
});
