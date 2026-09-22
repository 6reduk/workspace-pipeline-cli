import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,mkdir,writeFile,readdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {listRepositoryHistory} from '../src/operations/repository-history.js';
import {verifyBootstrapOwnerRetirement} from '../src/operations/bootstrap-owner-retirement.js';

test('history configured count boundary includes fixed probes and fails closed without deletion',async()=>{
  const parent=await mkdtemp(path.join(tmpdir(),'wpc-hist-bound-')),workspace=path.join(parent,'w');await mkdir(workspace);
  const records=path.join(workspace,'.pipeline/repository-inputs');await mkdir(path.join(workspace,'.pipeline'));await mkdir(records);
  for(const id of ['11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222'])await writeFile(path.join(records,id+'.json'),'{}');
  const before=await readdir(records);
  // Two listed records and eight fixed bootstrap/marker probes consume ten slots.
  const exact=await listRepositoryHistory(workspace,{maxEntries:10});
  assert.equal(exact.diagnostics.some(d=>d.code==='repository-history.limit'),false);
  assert.equal(exact.entries.filter(e=>e.kind==='repository-inputs').length,2);
  const exceeded=await listRepositoryHistory(workspace,{maxEntries:9});
  assert.equal(exceeded.complete,false);assert.ok(exceeded.diagnostics.some(d=>d.code==='repository-history.limit'));
  assert.equal(exceeded.deletionEligible,false);assert.ok(exceeded.entries.every(e=>e.deletionEligible===false));
  assert.deepEqual(await readdir(records),before);
  for(const maxEntries of [0,1001,1.5])await assert.rejects(listRepositoryHistory(workspace,{maxEntries}),e=>e.code==='repository-history.limit-option');
});

test('history depth cap reports incomplete after thirty-two ancestor levels',async()=>{
  let parent=await mkdtemp(path.join(tmpdir(),'wpc-depth-'));
  for(let i=0;i<33;i++){parent=path.join(parent,'a');await mkdir(parent);}
  const workspace=path.join(parent,'w');await mkdir(workspace);
  const before=await readdir(parent),result=await listRepositoryHistory(workspace);
  assert.equal(result.complete,false);assert.ok(result.diagnostics.some(d=>d.code==='repository-history.ancestor-depth'));
  assert.equal(result.deletionEligible,false);assert.deepEqual(await readdir(parent),before);
});

test('bootstrap retirement history enforces exact platform path budget before history IO',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wpc-retire-budget-'));
  const basename='.wpc-bootstrap-abandoned-11111111-1111-1111-1111-111111111111';
  const limit=process.platform==='win32'?240:1024;
  function history(length){
    let parent=root;
    while(length-(parent.length+1+basename.length)>100)parent=path.join(parent,'a'.repeat(70));
    const remaining=length-(parent.length+1+basename.length);
    if(remaining>0)parent=path.join(parent,'b'.repeat(remaining-1));
    return {parent,history:path.join(parent,basename)};
  }
  const exact=history(limit),over=history(limit+1);
  assert.equal(Buffer.byteLength(exact.history),limit);assert.equal(Buffer.byteLength(over.history),limit+1);
  await assert.rejects(verifyBootstrapOwnerRetirement(path.join(over.parent,'w'),over.history),e=>e.code==='layout.path-length');
  // At the exact bound validation proceeds to the missing history, not length rejection.
  await assert.rejects(verifyBootstrapOwnerRetirement(path.join(exact.parent,'w'),exact.history),e=>e.code==='ENOENT');
  assert.deepEqual(await readdir(root),[]);
});

test('history fixed scan caps reject the 100001st name using an enumeration double',async()=>{
  const parent=await mkdtemp(path.join(tmpdir(),'wpc-enumeration-bound-')),workspace=path.join(parent,'w');await mkdir(workspace);
  const url=new URL('../src/operations/repository-history.js',import.meta.url).href;
  const code=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
    const [parent,workspace,countText]=process.argv.slice(1),count=Number(countText);let yielded=0,calls=0;
    fs.promises.opendir=async function(directory){return (async function*(){
      if(directory===parent){calls++;for(let i=0;i<count;i++){yielded++;yield {name:'ordinary-'+i};}}
    })();};
    syncBuiltinESMExports();
    const {listRepositoryHistory}=await import(${JSON.stringify(url)});
    const result=await listRepositoryHistory(workspace);
    process.stdout.write(JSON.stringify({result,calls,yielded}));`;
  for(const count of [100000,100001]){
    const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',code,parent,workspace,String(count)],
      {windowsHide:true,timeout:30000,maxBuffer:1024*1024});
    const {result,calls,yielded}=JSON.parse(stdout);
    assert.equal(calls,2);assert.equal(yielded,count*2);
    for(const name of ['repository-history.parent-limit','repository-history.ancestor-limit'])
      assert.equal(result.diagnostics.some(d=>d.code===name),count>100000);
    if(count>100000)assert.equal(result.complete,false);
    assert.equal(result.deletionEligible,false);assert.deepEqual(result.entries,[]);
  }
  assert.deepEqual(await readdir(parent),['w']);assert.deepEqual(await readdir(workspace),[]);
});
