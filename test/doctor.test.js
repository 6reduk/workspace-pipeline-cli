import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {inspectInstallation} from '../src/operations/doctor.js';
import {sha256} from '../src/source/inventory.js';
import {contractDigest} from '../src/contracts/semantic.js';

test('doctor rejects foreign options and unsafe recovery selection before IO',async()=>{
  for (const options of [null,{latest:true},Object.defineProperty({},'recoveryPath',{enumerable:true,get(){throw Error('getter');}})])
    await assert.rejects(()=>inspectInstallation(path.resolve('unused'),options),e=>e.code==='doctor.options');
  for (const recoveryPath of ['../escape','latest',null,{toString(){throw Error('coercion');}}])
    await assert.rejects(()=>inspectInstallation(path.resolve('unused'),{recoveryPath}),e=>e.code==='recovery.path');
});

async function fixture() {
  const root=await mkdtemp(path.join(tmpdir(),'wpc-doctor-'));
  await mkdir(path.join(root,'.pipeline'));
  const hash='sha256:'+'a'.repeat(64);
  const state={schemaVersion:1,workspace:root,status:'ready',runtime:'pass',pending:null,
    active:{id:'installation',pipelineId:'example',version:'1.0.0',providers:['codex'],adapterVersions:{codex:'double'},
      layout:{kind:'single-repo',repositories:{game:{path:'project',role:'code'}},documentation:{repository:'game',path:'docs'},projectRoots:{}},
      snapshot:{source:{type:'git',transport:'local',path:'../absent',ref:'main',subdirectory:'.'},commit:'a'.repeat(40),
        path:'.pipeline/snapshots/a',digest:hash,inventoryDigest:hash,origin:{path:path.join(root,'missing.yaml'),base:root,digest:hash,resolvedSource:path.join(root,'absent')}},
      owned:[{path:'AGENTS.md',kind:'file',pointer:null,owner:'shared',beforeHash:null,managedHash:sha256(Buffer.from('entry')),backup:null}]}};
  const save=()=>writeFile(path.join(root,'.pipeline/state.json'),JSON.stringify(state));
  await writeFile(path.join(root,'AGENTS.md'),'entry');await save();
  return {root,state,save};
}
test('doctor missing state is not ready and creates nothing',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wpc-doctor-empty-'));
  const result=await inspectInstallation(root);
  assert.equal(result.ready,false);assert.ok(result.diagnostics.some(d=>d.code==='record.missing'));
  assert.deepEqual(await readdir(root),[]);
});
test('doctor checks owned hashes offline without source and never inherits runtime PASS',async()=>{
  const f=await fixture(),before=await readFile(path.join(f.root,'.pipeline/state.json'));
  const result=await inspectInstallation(f.root);
  assert.equal(result.targets.length,1);assert.equal(result.targets[0].expectedHash,result.targets[0].observedHash);
  assert.ok(result.diagnostics.some(d=>d.code==='snapshot.missing'));
  assert.equal(result.runtime,'not-run');assert.equal(result.ready,false);assert.equal(result.automaticActions,false);
  assert.deepEqual(await readFile(path.join(f.root,'.pipeline/state.json')),before);
});
test('doctor reports owned drift without repair',async()=>{
  const f=await fixture();await writeFile(path.join(f.root,'AGENTS.md'),'user');
  assert.ok((await inspectInstallation(f.root)).diagnostics.some(d=>d.code==='doctor.owned-drift'));
  assert.equal(await readFile(path.join(f.root,'AGENTS.md'),'utf8'),'user');
});
test('doctor JSON fields preserve foreign siblings, distinguish null and missing',async()=>{
  const f=await fixture();f.state.active.owned=[{...f.state.active.owned[0],path:'config.json',kind:'field',pointer:'/a~1b/~0key',managedHash:contractDigest(null)}];await f.save();
  const text=JSON.stringify({'a/b':{'~key':null},foreign:'private-value'});
  await writeFile(path.join(f.root,'config.json'),text);
  let result=await inspectInstallation(f.root);assert.equal(result.targets[0].observedHash,contractDigest(null));
  assert.ok(!JSON.stringify(result).includes('private-value'));
  await writeFile(path.join(f.root,'config.json'),'{}');result=await inspectInstallation(f.root);
  assert.equal(result.targets[0].observedHash,null);
});
test('doctor pending and locks remain intact and never clear themselves',async()=>{
  const f=await fixture();f.state.status='needs-reconciliation';f.state.pending='sha256:'+'b'.repeat(64);await f.save();
  await mkdir(path.join(f.root,'.pipeline/lock'));
  const result=await inspectInstallation(f.root);
  assert.equal(result.status,'needs-reconciliation');assert.equal(result.targets.length,0);
  assert.ok(result.diagnostics.some(d=>d.code==='doctor.lock-present'));
  assert.deepEqual(await readdir(path.join(f.root,'.pipeline/lock')),[]);
});
test('doctor rejects mismatched workspace and corrupt state without mutation',async()=>{
  const f=await fixture();f.state.workspace=path.join(f.root,'other');await f.save();
  assert.ok((await inspectInstallation(f.root)).diagnostics.some(d=>d.code==='doctor.workspace-binding'));
  await writeFile(path.join(f.root,'.pipeline/state.json'),'{');
  assert.equal((await inspectInstallation(f.root)).ready,false);
  assert.equal(await readFile(path.join(f.root,'.pipeline/state.json'),'utf8'),'{');
});
