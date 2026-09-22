import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp,mkdir,writeFile,readFile,readdir,symlink } from 'node:fs/promises';
import { listRepositoryHistory } from '../src/operations/repository-history.js';
import { bootstrapLockDirectory } from '../src/operations/bootstrap-lock.js';
import { runCli } from '../src/commands/dispatch.js';

const id='11111111-1111-1111-1111-111111111111';
async function fixture() {
  const parent=await mkdtemp(path.join(tmpdir(),'wpc-history-')),workspace=path.join(parent,'wrapper');
  await mkdir(workspace);return {parent,workspace};
}
test('S7 history lists all repository namespaces without exposing record values or deleting',async()=>{
  const {workspace}=await fixture(),metadata=path.join(workspace,'.pipeline');await mkdir(metadata);
  for(const name of ['repository-journals','repository-evidence','repository-authorizations','repository-completions']) {
    const directory=path.join(metadata,name);await mkdir(directory);
    if(['repository-journals','repository-evidence'].includes(name))await mkdir(path.join(directory,id));
    else await writeFile(path.join(directory,id+'.json'),'secret-value');
  }
  await writeFile(path.join(metadata,'repository-operation.json'),'secret-value');
  await mkdir(path.join(metadata,'repository-lock-recoveries'));
  await mkdir(path.join(metadata,'repository-lock-recoveries','a'.repeat(64)));
  await mkdir(bootstrapLockDirectory(workspace)+'.recovery');
  await mkdir(bootstrapLockDirectory(workspace)+'.recovery-resume');
  const result=await listRepositoryHistory(workspace);
  assert.equal(result.complete,true);assert.equal(result.entries.length,8);
  assert.ok(result.entries.some(e=>e.kind==='repository-lock-recoveries'));
  assert.equal(result.validation,'locations-only');assert.ok(result.entries.every(e=>e.deletionEligible===false));
  assert.ok(!JSON.stringify(result).includes('secret-value'));
  assert.equal(await readFile(path.join(metadata,'repository-operation.json'),'utf8'),'secret-value');
});
test('S7 history attributes sibling attempts by exact workspace binding',async()=>{
  const {workspace,parent}=await fixture();
  for(const [hash,owner] of [['a',workspace],['b',path.join(parent,'other')]]) {
    const directory=path.join(parent,'.wpc-bootstrap-history-'+hash.repeat(64));await mkdir(directory);
    await writeFile(path.join(directory,'owner.json'),JSON.stringify({workspace:owner}));
  }
  const result=await listRepositoryHistory(workspace);
  assert.equal(result.complete,true);assert.equal(result.entries.length,1);
  assert.ok(result.entries[0].path.endsWith('a'.repeat(64)));
});
test('S7 history reports namespace links and bounded incomplete enumeration without following them',async()=>{
  const {workspace,parent}=await fixture(),metadata=path.join(workspace,'.pipeline'),outside=path.join(parent,'outside');
  await mkdir(metadata);await mkdir(outside);await writeFile(path.join(outside,'secret'),'keep');
  await symlink(outside,path.join(metadata,'repository-journals'),process.platform==='win32'?'junction':'dir');
  const result=await listRepositoryHistory(workspace);
  assert.equal(result.complete,false);assert.ok(result.diagnostics.some(d=>d.code==='layout.link'));
  assert.ok(!result.entries.some(e=>e.path.endsWith('secret')));
  assert.equal((await listRepositoryHistory(workspace,{maxEntries:1})).complete,false);
  assert.deepEqual(await readdir(outside),['secret']);
});
test('S7 CLI logs list exposes protected repository locations while pending',async()=>{
  const {workspace}=await fixture();await mkdir(path.join(workspace,'.pipeline'));
  await writeFile(path.join(workspace,'.pipeline/repository-operation.json'),'{}');
  let output='',error='';
  const code=await runCli(['logs','list','--workspace',workspace],{stdout:s=>{output+=s;},stderr:s=>{error+=s;}});
  assert.equal(code,0);assert.equal(error,'');const result=JSON.parse(output);
  assert.equal(result.repositories.entries.length,1);assert.equal(result.repositories.deletionEligible,false);
  assert.equal(result.selectionDisabled,true);
  assert.deepEqual(await readdir(path.join(workspace,'.pipeline')),['repository-operation.json']);
});

test('S7 history keeps safe siblings visible after an unsafe entry',async()=>{
  const {workspace,parent}=await fixture(),dir=path.join(workspace,'.pipeline/repository-journals');
  await mkdir(dir,{recursive:true});const outside=path.join(parent,'outside');await mkdir(outside);
  await writeFile(path.join(outside,'secret'),'keep');
  await symlink(outside,path.join(dir,'00000000-0000-0000-0000-000000000000'),process.platform==='win32'?'junction':'dir');
  await mkdir(path.join(dir,id));
  const result=await listRepositoryHistory(workspace);
  assert.equal(result.complete,false);assert.ok(result.diagnostics.some(d=>d.code==='repository-history.unsafe-type'));
  assert.ok(result.entries.some(e=>e.path===path.join(dir,id)));
  assert.ok(!result.entries.some(e=>e.path.endsWith('secret')));
});
