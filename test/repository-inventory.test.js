import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp,mkdir,writeFile,readFile,link,symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inventoryRepository } from '../src/workspace/repository-inventory.js';

async function fixture() {
  const root=await mkdtemp(path.join(tmpdir(),'wpc-s7-inventory-'));
  await mkdir(path.join(root,'.git'));
  await mkdir(path.join(root,'empty'));
  await writeFile(path.join(root,'.git','HEAD'),'ref: refs/heads/main\n');
  await writeFile(path.join(root,'.gitignore'),'ignored.bin\n');
  await writeFile(path.join(root,'ignored.bin'),Buffer.from([0,1,255]));
  await writeFile(path.join(root,'untracked.txt'),'uncommitted');
  return root;
}
test('S7 inventory includes metadata, ignored/untracked files and empty directories without mutation',async()=>{
  const root=await fixture(), first=await inventoryRepository(root), second=await inventoryRepository(root);
  assert.deepEqual(first,second);
  assert.deepEqual(first.entries.map(e=>e.path),['.','.git','.git/HEAD','.gitignore','empty','ignored.bin','untracked.txt']);
  const raw=await readFile(path.join(root,'ignored.bin'));
  assert.equal(first.entries.find(e=>e.path==='ignored.bin').sha256,createHash('sha256').update(raw).digest('hex'));
  assert.equal(first.git,'not-verified'); assert.equal(first.executionAuthorized,false);
});
test('S7 inventory lower bounds are enforced at/over with no partial result',async()=>{
  const root=await fixture(), all=await inventoryRepository(root);
  assert.equal((await inventoryRepository(root,{entries:all.entries.length,bytes:all.bytes,depth:2})).digest,all.digest);
  for(const [options,code] of [[{entries:6},'repositories.entries'],[{bytes:all.bytes-1},'repositories.bytes'],[{depth:1},'repositories.depth']])
    await assert.rejects(inventoryRepository(root,options),e=>e.code===code);
  assert.deepEqual(await inventoryRepository(root),all);
});
test('S7 inventory detects changed content and missing root',async()=>{
  const root=await fixture(), before=await inventoryRepository(root);
  await writeFile(path.join(root,'untracked.txt'),'changed');
  assert.notEqual((await inventoryRepository(root)).digest,before.digest);
  await assert.rejects(inventoryRepository(path.join(root,'missing')),e=>e.code==='repositories.missing');
});
test('S7 inventory rejects shared hardlinks and invalid limits',async()=>{
  const root=await fixture();
  await link(path.join(root,'untracked.txt'),path.join(root,'linked.txt'));
  await assert.rejects(inventoryRepository(root),e=>e.code==='repositories.hardlink');
  await assert.rejects(inventoryRepository(root,{bytes:0}),e=>e.code==='repositories.inventory-limit');
  await assert.rejects(inventoryRepository(root,{ignore:'.git'}),e=>e.code==='repositories.inventory-options');
});
test('S7 inventory rejects linked directories without inventorying their contents',async()=>{
  const root=await fixture();
  const outside=await mkdtemp(path.join(tmpdir(),'wpc-s7-link-target-'));
  await writeFile(path.join(outside,'private.txt'),'outside');
  await symlink(outside,path.join(root,'linked-directory'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(inventoryRepository(root),e=>e.code==='repositories.link');
  assert.equal(await readFile(path.join(outside,'private.txt'),'utf8'),'outside');
});
