import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,mkdir,writeFile,readdir,readFile,symlink} from 'node:fs/promises';
import {inspectHistory} from '../src/operations/history.js';
const id='11111111-1111-1111-1111-111111111111';
const fresh=()=>mkdtemp(path.join(tmpdir(),'wpc-history-'));
test('history absent metadata is empty and does not create it',async()=>{
  const root=await fresh(),result=await inspectHistory(root);
  assert.equal(result.complete,true);assert.deepEqual(result.entries,[]);assert.deepEqual(await readdir(root),[]);
});
test('history identifies both orphan directions without removing evidence',async()=>{
  for (const parent of ['journals','transactions']) {
    const root=await fresh();await mkdir(path.join(root,'.pipeline',parent,id),{recursive:true});
    const result=await inspectHistory(root);
    assert.equal(result.entries[0].status,'orphan');assert.equal(result.entries[0].protected,true);
    assert.deepEqual(await readdir(path.join(root,'.pipeline',parent)),[id]);
  }
});
test('history preserves corrupt recovery and reports unknown',async()=>{
  const root=await fresh();
  for(const parent of ['journals','transactions']) await mkdir(path.join(root,'.pipeline',parent,id),{recursive:true});
  const file=path.join(root,'.pipeline/transactions',id,'recovery.json');await writeFile(file,'{');
  const result=await inspectHistory(root);assert.equal(result.entries[0].status,'unknown');
  assert.ok(result.diagnostics.some(d=>d.code==='parse.syntax'));assert.equal(await readFile(file,'utf8'),'{');
});
test('history refuses foreign names and directory links',async()=>{
  const root=await fresh();await mkdir(path.join(root,'.pipeline/journals/foreign'),{recursive:true});
  assert.equal((await inspectHistory(root)).complete,false);
  const other=await fresh();await mkdir(path.join(other,'.pipeline/journals'),{recursive:true});
  await symlink(root,path.join(other,'.pipeline/journals',id),'junction');
  const result=await inspectHistory(other);assert.equal(result.complete,false);
  assert.ok(result.diagnostics.some(d=>d.code==='layout.link'));
});
