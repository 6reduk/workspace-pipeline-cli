import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readdir,readFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {scanRetention} from '../src/operations/retention-scan.js';
const options={policy:{maxAgeDays:0,maxJournals:0,maxDeletesPerRun:10},now:Date.now()};
const id='11111111-1111-1111-1111-111111111111';
test('retention scanner is read-only for an empty workspace',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wpc-retention-'));
  const result=await scanRetention(root,options);
  assert.equal(result.complete,true);assert.deepEqual(result.retention.selected,[]);
  assert.deepEqual(await readdir(root),[]);assert.equal(result.applySupported,false);
});
test('retention scanner protects orphan and corrupt evidence without exposing contents',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wpc-retention-'));
  await mkdir(path.join(root,'.pipeline/journals',id),{recursive:true});
  await writeFile(path.join(root,'.pipeline/journals',id,'000000.json'),'SECRET malformed');
  const result=await scanRetention(root,{...options,currentRuns:[id]});
  assert.equal(result.complete,false);assert.deepEqual(result.retention.selected,[]);
  assert.ok(result.groups[0].protectionReasons.includes('current-run'));
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  assert.equal(await readFile(path.join(root,'.pipeline/journals',id,'000000.json'),'utf8'),'SECRET malformed');
});
test('retention scanner refuses links and foreign group files conservatively',async()=>{
  for(const link of [false,true]) {
    const root=await mkdtemp(path.join(tmpdir(),'wpc-retention-'));
    await mkdir(path.join(root,'.pipeline/journals',id),{recursive:true});
    if(link) {
      const other=await mkdtemp(path.join(tmpdir(),'wpc-retention-other-'));
      await symlink(other,path.join(root,'.pipeline/journals',id,'foreign'),'junction');
    }else await writeFile(path.join(root,'.pipeline/journals',id,'foreign'),'preserve');
    const result=await scanRetention(root,options);
    assert.equal(result.complete,false);assert.deepEqual(result.retention.selected,[]);
    assert.deepEqual(await readdir(path.join(root,'.pipeline/journals',id)),['foreign']);
  }
});
test('retention scanner validates policy and current run before inspection',async()=>{
  await assert.rejects(()=>scanRetention('C:/unobserved',{...options,currentRuns:['../escape']}),e=>e.code==='retention-scan.current-run');
  await assert.rejects(()=>scanRetention('C:/unobserved',{...options,policy:{...options.policy,maxAgeDays:-1}}),e=>e.code==='retention.policy');
});
