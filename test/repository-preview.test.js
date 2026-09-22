import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp,mkdir,writeFile } from 'node:fs/promises';
import { runGit } from '../src/source/git.js';
import { contractDigest } from '../src/contracts/semantic.js';
import { inventoryRepository } from '../src/workspace/repository-inventory.js';
import { bindLocalRepositorySource,prepareRepositoryPreview,revalidateRepositoryPreview } from '../src/workspace/repository-preview.js';

const source={type:'git',transport:'local',path:'source',ref:'HEAD',subdirectory:'.'};
const pipeline={schemaVersion:1,id:'example',version:'1.0.0',resources:'resources',inventory:'inventory.json',
  providers:{codex:{skills:'skills',agents:null,mcp:null,entryInstructions:null,requires:[]}},agentsDocument:{mode:'default'}};
const workspace={schemaVersion:1,pipeline:source,providers:['codex'],layout:{kind:'single-repo',
  repositories:{game:{path:'project',role:'code',source}},documentation:{repository:'game',path:'docs'}}};
async function fixture() {
  const base=await mkdtemp(path.join(tmpdir(),'wpc-s7-preview-')),root=path.join(base,'source');
  await mkdir(root); await runGit(root,['init','--template=','-b','main']);
  await writeFile(path.join(root,'tracked.txt'),'committed'); await runGit(root,['add','tracked.txt']);
  await runGit(root,['-c','user.name=S7','-c','user.email=s7@example.invalid','commit','-m','fixture']);
  return {base,root,wrapper:path.join(base,'wrapper')};
}
test('S7 clone binding freezes commit, resolves manifest base, excludes dirty source bytes',async()=>{
  const {base,root}=await fixture();
  await writeFile(path.join(root,'tracked.txt'),'dirty');
  const before=await inventoryRepository(root), result=await bindLocalRepositorySource(source,base);
  const head=(await runGit(root,['rev-parse','HEAD'])).bytes.toString().trim();
  assert.equal(result.commit,head); assert.equal(result.resolvedSource,root);
  assert.equal(result.uncommittedSourceFiles,'not-cloned');
  assert.deepEqual(await inventoryRepository(root),before);
});
test('S7 ambiguous branch/tag rejected even when both resolve to the same commit',async()=>{
  const {base,root}=await fixture(); await runGit(root,['tag','main']);
  await assert.rejects(bindLocalRepositorySource({...source,ref:'main'},base),e=>e.code==='repositories.clone-ambiguous-ref');
});
test('S7 unknown ref and remote source passed to local binder fail closed',async()=>{
  const {base}=await fixture();
  await assert.rejects(bindLocalRepositorySource({...source,ref:'missing'},base),e=>e.code==='repositories.clone-missing-ref');
  const remote={type:'git',transport:'remote',url:'https://example.invalid/repo.git',ref:'HEAD',subdirectory:'.'};
  await assert.rejects(bindLocalRepositorySource(remote,base),e=>e.code==='repositories.local-source-required');
});
test('S7 remote preview refuses missing opt-in and preparation inside wrapper before network',async()=>{
  const {base,wrapper}=await fixture(); await mkdir(wrapper);
  const w=structuredClone(workspace);
  w.layout.repositories.game.source={type:'git',transport:'remote',url:'https://example.invalid/repo.git',ref:'HEAD',subdirectory:'.'};
  const choices={game:{action:'clone'}};
  await assert.rejects(prepareRepositoryPreview(pipeline,w,wrapper,choices,{command:'init',manifestBase:base,tempRoot:base}),
    e=>e.code==='source.network-required');
  await assert.rejects(prepareRepositoryPreview(pipeline,w,wrapper,choices,{command:'init',manifestBase:base,tempRoot:wrapper,network:true}),
    e=>e.code==='repository-source.preparation-location');
});
test('S7 move candidate binds exact source and absent destination without authorization',async()=>{
  const {base,root,wrapper}=await fixture(),before=await inventoryRepository(root);
  const choices={game:{action:'move',from:root}};
  const first=await prepareRepositoryPreview(pipeline,workspace,wrapper,choices,{command:'adopt',manifestBase:base});
  const second=await prepareRepositoryPreview(pipeline,workspace,wrapper,choices,{command:'wrap',manifestBase:base});
  assert.deepEqual(first,second); assert.equal(first.status,'review-only');
  assert.equal(first.executionAuthorized,false); assert.deepEqual(first.blockers,[]);
  const {digest,...body}=first; assert.equal(digest,contractDigest(body));
  assert.equal(first.operations[0].existing.inventory.digest,before.digest);
  assert.equal(first.operations[0].destination.exists,false);
  assert.deepEqual(await inventoryRepository(root),before);
});
test('S7 occupied destination stops candidate creation without modifying source',async()=>{
  const {base,root,wrapper}=await fixture(); await mkdir(path.join(wrapper,'project'),{recursive:true});
  const before=await inventoryRepository(root);
  await assert.rejects(prepareRepositoryPreview(pipeline,workspace,wrapper,{game:{action:'move',from:root}},
    {command:'adopt',manifestBase:base}),e=>e.code==='repositories.destination-exists');
  assert.deepEqual(await inventoryRepository(root),before);
});
test('S7 saved preview reload checks external digest, current inputs and filesystem without writes',async()=>{
  const {base,root,wrapper}=await fixture(),choices={game:{action:'move',from:root}},options={command:'adopt',manifestBase:base};
  const original=await prepareRepositoryPreview(pipeline,workspace,wrapper,choices,options);
  const text=JSON.stringify(original), before=await inventoryRepository(root);
  assert.deepEqual(await revalidateRepositoryPreview(text,original.digest,pipeline,workspace,wrapper,choices,options),original);
  await assert.rejects(revalidateRepositoryPreview(text,'sha256:'+'0'.repeat(64),pipeline,workspace,wrapper,choices,options),
    e=>e.code==='repositories.preview-digest');
  const changed=structuredClone(original);changed.operations[0].target=path.join(base,'other');
  await assert.rejects(revalidateRepositoryPreview(JSON.stringify(changed),original.digest,pipeline,workspace,wrapper,choices,options),
    e=>e.code==='repositories.preview-digest');
  const {digest,...body}=changed;changed.digest=contractDigest(body);
  await assert.rejects(revalidateRepositoryPreview(JSON.stringify(changed),changed.digest,pipeline,workspace,wrapper,choices,options),
    e=>e.code==='repositories.preview-drift');
  assert.deepEqual(await inventoryRepository(root),before);
  await writeFile(path.join(root,'new.txt'),'later edit');
  await assert.rejects(revalidateRepositoryPreview(text,original.digest,pipeline,workspace,wrapper,choices,options),
    e=>e.code==='repositories.preview-drift');
});
test('S7 manifest binds original bytes and base, even whitespace changes stale saved preview',async()=>{
  const {base,wrapper}=await fixture(),manifestPath=path.join(base,'workspace.json');
  await writeFile(manifestPath,JSON.stringify(workspace));
  const choices={game:{action:'directory'}},options={command:'init',manifestPath};
  const preview=await prepareRepositoryPreview(pipeline,workspace,wrapper,choices,options);
  assert.equal(preview.manifest.base,base); assert.equal(preview.manifest.path,manifestPath);
  assert.deepEqual(await revalidateRepositoryPreview(JSON.stringify(preview),preview.digest,pipeline,workspace,wrapper,choices,options),preview);
  await assert.rejects(prepareRepositoryPreview(pipeline,workspace,wrapper,choices,{...options,manifestBase:wrapper}),e=>e.code==='repositories.manifest-base');
  await writeFile(manifestPath,JSON.stringify(workspace,null,2));
  await assert.rejects(revalidateRepositoryPreview(JSON.stringify(preview),preview.digest,pipeline,workspace,wrapper,choices,options),e=>e.code==='repositories.preview-drift');
});
