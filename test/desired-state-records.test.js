import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,unlink} from 'node:fs/promises';
import {applyDesiredFiles} from '../src/desired-state/apply-files.js';
import {contractDigest} from '../src/contracts/semantic.js';
import {sha256} from '../src/source/inventory.js';
import {inspectDesiredInstallation} from '../src/desired-state/doctor.js';

async function fixture(t) {
  const workspace=await mkdtemp(path.join(os.tmpdir(),'wpc-records-'));
  t.after(()=>rm(workspace,{recursive:true,force:true}));
  await writeFile(path.join(workspace,'CLAUDE.md'),'old private content');
  const manifest=JSON.stringify({schemaVersion:2,id:'example',version:'1.0.0',adapters:{claude:{providers:['claude'],settings:[],files:[{source:'entry.md',target:'CLAUDE.md',kind:'file'}]}}});
  return {workspace,manifest,selected:['claude'],protectedPaths:['project'],source:new Map([['entry.md',Buffer.from('new instructions')]])};
}
test('record contains desired digests but neither old nor delivered contents',async t=>{
  const input=await fixture(t);await applyDesiredFiles(input);
  const bytes=await readFile(path.join(input.workspace,'.pipeline/desired-install.json'),'utf8');
  assert.ok(!bytes.includes('old private content'));assert.ok(!bytes.includes('new instructions'));
  const state=JSON.parse(bytes);assert.equal(state.pipeline.id,'example');assert.match(state.files[0].hash,/^sha256:/);
  await applyDesiredFiles(input);
  assert.equal(await readFile(path.join(input.workspace,'.pipeline/desired-install.json'),'utf8'),bytes);
});
test('interruption keeps marker, same desired source retries without backup',async t=>{
  const input=await fixture(t);
  await assert.rejects(applyDesiredFiles(input,{boundary:async event=>{if(event==='after-delete')throw Error('test interruption');}}),/test interruption/);
  assert.deepEqual(await readdir(path.join(input.workspace,'.pipeline')),['desired-pending.json']);
  await applyDesiredFiles(input);
  assert.equal(await readFile(path.join(input.workspace,'CLAUDE.md'),'utf8'),'new instructions');
  assert.deepEqual(await readdir(path.join(input.workspace,'.pipeline')),['desired-install.json']);
});
test('different source cannot overwrite unfinished operation marker',async t=>{
  const input=await fixture(t);
  await assert.rejects(applyDesiredFiles(input,{boundary:async event=>{if(event==='before-content')throw Error('stop');}}));
  const before=await readFile(path.join(input.workspace,'.pipeline/desired-pending.json'));
  const changed={...input,source:new Map([['entry.md',Buffer.from('other')]])};
  await assert.rejects(applyDesiredFiles(changed),e=>e.code==='desired.retry-same-source-required');
  assert.deepEqual(await readFile(path.join(input.workspace,'.pipeline/desired-pending.json')),before);
});
test('readback complete but record interrupted can be finalized by retry',async t=>{
  const input=await fixture(t);
  await assert.rejects(applyDesiredFiles(input,{boundary:async event=>{if(event==='before-record')throw Error('stop');}}));
  assert.equal((await applyDesiredFiles(input)).status,'unchanged');
  assert.deepEqual(await readdir(path.join(input.workspace,'.pipeline')),['desired-install.json']);
});
test('old lifecycle record requires explicit migration before content writes',async t=>{
  const input=await fixture(t);await mkdir(path.join(input.workspace,'.pipeline'));
  await writeFile(path.join(input.workspace,'.pipeline/state.json'),'{}');
  await assert.rejects(applyDesiredFiles(input),e=>e.code==='desired.legacy-migration-required');
  assert.equal(await readFile(path.join(input.workspace,'CLAUDE.md'),'utf8'),'old private content');
});

function binding(input) {
  return {source:{type:'git',transport:'local',path:'../source',ref:'main',subdirectory:'.'},
    commit:'a'.repeat(40),digest:contractDigest(Object.fromEntries([...input.source].map(([p,b])=>[p,sha256(b)]))),
    layout:{kind:'single-repo',repositories:{game:{path:'project',role:'code'}},documentation:{repository:'game',path:'docs'}}};
}
test('interrupted initial setup preserves descriptor and retries without recreating it',async t=>{
  const input=await fixture(t);input.binding=binding(input);
  await assert.rejects(applyDesiredFiles(input,{createDescriptor:true,boundary:async event=>{if(event==='before-content')throw Error('stop');}}));
  const descriptor=JSON.parse(await readFile(path.join(input.workspace,'workspace.json'),'utf8'));
  assert.equal(descriptor.schemaVersion,2);assert.equal(descriptor.pipeline.path,'../source');
  assert.equal(await readFile(path.join(input.workspace,'CLAUDE.md'),'utf8'),'old private content');
  await applyDesiredFiles(input);
  assert.equal(await readFile(path.join(input.workspace,'CLAUDE.md'),'utf8'),'new instructions');
});
test('Git binding survives installation and doctor without fetching',async t=>{
  const input=await fixture(t);input.binding=binding(input);
  await applyDesiredFiles(input,{createDescriptor:true});
  const report=await inspectDesiredInstallation(input.workspace);
  assert.equal(report.ready,true);assert.deepEqual(JSON.parse(JSON.stringify(report.binding)),input.binding);
  // A completed operation may move to a new commit even when delivered bytes match.
  input.binding={...input.binding,commit:'b'.repeat(40)};
  assert.equal((await applyDesiredFiles(input)).status,'unchanged');
  assert.deepEqual(JSON.parse(JSON.stringify((await inspectDesiredInstallation(input.workspace)).binding)),input.binding);
});
test('different Git revision cannot resume a pending operation with identical files',async t=>{
  const input=await fixture(t);input.binding=binding(input);
  await assert.rejects(applyDesiredFiles(input,{boundary:async event=>{if(event==='before-content')throw Error('stop');}}));
  const before=await readFile(path.join(input.workspace,'.pipeline/desired-pending.json'));
  await assert.rejects(applyDesiredFiles({...input,binding:{...input.binding,commit:'b'.repeat(40)}}),e=>e.code==='desired.retry-same-source-required');
  assert.deepEqual(await readFile(path.join(input.workspace,'.pipeline/desired-pending.json')),before);
  await applyDesiredFiles(input);
});
test('wrong source digest and credential-bearing source fail before mutation',async t=>{
  const input=await fixture(t);input.binding=binding(input);
  await assert.rejects(applyDesiredFiles({...input,binding:{...input.binding,digest:'sha256:'+'0'.repeat(64)}}),e=>e.code==='desired.binding-source-mismatch');
  await assert.rejects(applyDesiredFiles({...input,binding:{...input.binding,source:{type:'git',transport:'remote',url:'https://user:secret@example.com/repo.git',ref:'main',subdirectory:'.'}}}));
  assert.equal(await readFile(path.join(input.workspace,'CLAUDE.md'),'utf8'),'old private content');
  await assert.rejects(readFile(path.join(input.workspace,'.pipeline/desired-install.json')),{code:'ENOENT'});
});

test('doctor reports missing, malformed and changed workspace declaration without repairing it',async t=>{
  const input=await fixture(t);input.binding=binding(input);
  await applyDesiredFiles(input,{createDescriptor:true});
  const file=path.join(input.workspace,'workspace.json'),original=await readFile(file);
  const installed=await readFile(path.join(input.workspace,'.pipeline/desired-install.json'));
  await unlink(file);
  assert.ok((await inspectDesiredInstallation(input.workspace)).diagnostics.some(d=>d.code==='desired.workspace-missing'));
  await assert.rejects(readFile(file),{code:'ENOENT'});
  await writeFile(file,'{broken');
  assert.ok((await inspectDesiredInstallation(input.workspace)).diagnostics.some(d=>d.code==='desired.workspace-invalid'));
  assert.equal(await readFile(file,'utf8'),'{broken');
  for(const mutate of [d=>{d.pipeline.ref='other';},d=>{d.layout.documentation.path='other-docs';},d=>{d.adapters=['codex'];}]) {
    const descriptor=JSON.parse(original);mutate(descriptor);
    await writeFile(file,JSON.stringify(descriptor));
    const result=await inspectDesiredInstallation(input.workspace);
    assert.equal(result.ready,false);
    assert.ok(result.diagnostics.some(d=>d.code==='desired.workspace-different'));
  }
  await writeFile(file,original);
  assert.equal((await inspectDesiredInstallation(input.workspace)).ready,true);
  assert.deepEqual(await readFile(path.join(input.workspace,'.pipeline/desired-install.json')),installed);
});

test('doctor refuses recorded ownership inside bound repository without caller-supplied protected paths',async t=>{
  const input=await fixture(t);input.binding=binding(input);
  await applyDesiredFiles(input,{createDescriptor:true});
  const file=path.join(input.workspace,'.pipeline/desired-install.json');
  const record=JSON.parse(await readFile(file,'utf8'));
  record.scopes=[{path:'project',kind:'directory'}];
  await writeFile(file,JSON.stringify(record));
  await assert.rejects(inspectDesiredInstallation(input.workspace));
});
