import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp,writeFile } from 'node:fs/promises';
import { runGit } from '../src/source/git.js';
import { checkRepositoryTreePaths,inspectRepositoryTree } from '../src/workspace/repository-tree.js';
import { inventoryRepository } from '../src/workspace/repository-inventory.js';

const destination=path.join(tmpdir(),'wpc-tree-target');
const entry=(name,mode='100644')=>({path:name,mode,type:mode==='160000'?'commit':'blob',size:3,oid:'a'.repeat(40)});
test('S7 tree accepts Unicode and large ordinary assets without package blob cap',()=>{
  assert.equal(checkRepositoryTreePaths([entry('Assets/Тест.cs'),{...entry('Assets/video.bin'),size:10*1024*1024}],destination),10485763);
});
for(const name of ['../escape','/absolute','.git/config','CON.txt','a:stream','bad\\name','dir/file.','dir/file ','git~1/config'])
  test('S7 tree rejects nonportable checkout path '+name,()=>assert.throws(()=>checkRepositoryTreePaths([entry(name)],destination),e=>Boolean(e.code)));
test('S7 tree rejects aliases and file/directory collision',()=>{
  for(const names of [['A.txt','a.txt'],['a','a/b'],['Assets/a','assets/b'],['e\u0301.txt','é.txt']])
    assert.throws(()=>checkRepositoryTreePaths(names.map(n=>entry(n)),destination),e=>e.code==='repository-tree.collision');
});
test('S7 tree rejects symlinks and gitlinks',()=>{
  for(const mode of ['120000','160000'])assert.throws(()=>checkRepositoryTreePaths([entry('link',mode)],destination),e=>e.code==='repository-tree.entry-type');
});
async function fixture(content) {
  const root=await mkdtemp(path.join(tmpdir(),'wpc-s7-tree-'));
  await runGit(root,['init','--template=']);await writeFile(path.join(root,'file.txt'),content);
  await runGit(root,['add','file.txt']);
  await runGit(root,['-c','user.name=S7','-c','user.email=s7@example.invalid','commit','-m','fixture']);
  const commit=(await runGit(root,['rev-parse','HEAD'])).bytes.toString().trim();return {root,commit};
}
test('S7 native tree inspection preserves source and rejects LFS pointers',async()=>{
  const {root,commit}=await fixture('ordinary file'),before=await inventoryRepository(root);
  const result=await inspectRepositoryTree(root,commit,destination);
  assert.equal(result.entries.length,1);assert.equal(result.executionAuthorized,false);
  assert.deepEqual(await inventoryRepository(root),before);
  const lfs=await fixture('version https://git-lfs.github.com/spec/v1\noid sha256:'+'a'.repeat(64)+'\nsize 100\n');
  await assert.rejects(inspectRepositoryTree(lfs.root,lfs.commit,destination),e=>e.code==='repository-tree.lfs');
});
