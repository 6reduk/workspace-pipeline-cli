import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp,mkdir,writeFile } from 'node:fs/promises';
import { runGit } from '../src/source/git.js';
import { inspectRepositoryMetadata,inspectRepositoryDestination,inspectRepositoryGit } from '../src/workspace/repository-preflight.js';
import { inventoryRepository } from '../src/workspace/repository-inventory.js';

async function fixture() {
  const root=await mkdtemp(path.join(tmpdir(),'wpc-s7-git-'));
  await runGit(root,['init','--template=']);
  await writeFile(path.join(root,'untracked.txt'),'keep me');
  return root;
}
test('S7 native embedded Git config screened without modifying source',async()=>{
  const root=await fixture(), before=await inventoryRepository(root);
  const result=await inspectRepositoryMetadata(root);
  assert.deepEqual(result.blockers,[]); assert.equal(result.gitHealth,'not-verified');
  assert.equal(result.executionAuthorized,false);
  assert.deepEqual(await inventoryRepository(root),before);
});
test('S7 occupied destination refused, missing path binds existing ancestor',async()=>{
  const root=await fixture();
  await assert.rejects(inspectRepositoryDestination(root),e=>e.code==='repositories.destination-exists');
  const target=path.join(root,'future','project'), result=await inspectRepositoryDestination(target);
  assert.equal(result.ancestor,root); assert.equal(result.exists,false);
  assert.equal(result.target,target); assert.equal(result.executionAuthorized,false);
});
for(const [name,code] of [['.git/commondir','git.linked-worktrees'],['.git/objects/info/alternates','git.external-objects'],
  ['.git/index.lock','git.lock-present'],['.gitmodules','git.submodules'],['.git/hooks/post-checkout','git.active-hooks']])
  test('S7 metadata blocks '+code,async()=>{
    const root=await fixture();
    await mkdir(path.dirname(path.join(root,name)),{recursive:true});
    await writeFile(path.join(root,name),'external-or-pending');
    assert.ok((await inspectRepositoryMetadata(root)).blockers.includes(code));
  });
test('S7 unborn HEAD and untracked files allowed with unchanged source',async()=>{
  const root=await fixture(), before=await inventoryRepository(root);
  const result=await inspectRepositoryGit(root);
  assert.equal(result.head,null); assert.equal(result.dirty,true);
  assert.equal(result.gitHealth,'local-connectivity-checked');
  assert.deepEqual(result.blockers,[]); assert.equal(result.executionAuthorized,false);
  assert.deepEqual(await inventoryRepository(root),before);
});
test('S7 committed dirty/staged/ignored files preserved by native inspection',async()=>{
  const root=await fixture();
  await runGit(root,['add','untracked.txt']);
  await runGit(root,['-c','user.name=S7 Test','-c','user.email=s7@example.invalid','commit','-m','fixture']);
  await writeFile(path.join(root,'untracked.txt'),'dirty tracked');
  await writeFile(path.join(root,'staged.txt'),'staged');
  await runGit(root,['add','staged.txt']);
  await writeFile(path.join(root,'.gitignore'),'ignored.bin\n');
  await writeFile(path.join(root,'ignored.bin'),'ignored bytes');
  const before=await inventoryRepository(root), result=await inspectRepositoryGit(root);
  assert.match(result.head,/^[a-f0-9]{40,64}$/); assert.equal(result.dirty,true);
  assert.deepEqual(result.blockers,[]); assert.deepEqual(await inventoryRepository(root),before);
});
test('S7 broken detached HEAD fails, not misclassified as unborn',async()=>{
  const root=await fixture();
  await writeFile(path.join(root,'.git','HEAD'),'a'.repeat(40)+'\n');
  await assert.rejects(inspectRepositoryGit(root),e=>Boolean(e.code));
});
test('S7 corrupted index fails without repairing it',async()=>{
  const root=await fixture();
  await writeFile(path.join(root,'.git','index'),'broken index');
  const before=await inventoryRepository(root);
  await assert.rejects(inspectRepositoryGit(root),e=>Boolean(e.code));
  assert.deepEqual(await inventoryRepository(root),before);
});
test('S7 pending merge is a blocker before native structure checks',async()=>{
  const root=await fixture();
  await writeFile(path.join(root,'.git','MERGE_HEAD'),'a'.repeat(40));
  const result=await inspectRepositoryGit(root);
  assert.ok(result.blockers.includes('git.operation-pending'));
  assert.equal(result.gitHealth,'not-verified');
});
test('S7 gitfile rejected without following external metadata',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wpc-s7-gitfile-'));
  await writeFile(path.join(root,'.git'),'gitdir: /not/to/be/read');
  assert.ok((await inspectRepositoryMetadata(root)).blockers.includes('git.embedded-directory-required'));
});
for(const [key,value] of [['include.path','/not/to/be/read'],['core.worktree','../other'],['remote.origin.url','../relative-repo']])
  test('S7 path-sensitive config refused: '+key,async()=>{
    const root=await fixture();
    await runGit(root,['config','--file',path.join(root,'.git','config'),key,value]);
    assert.ok((await inspectRepositoryMetadata(root)).blockers.includes('git.config-requires-review'));
  });
