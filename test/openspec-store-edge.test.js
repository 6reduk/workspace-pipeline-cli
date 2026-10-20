import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,mkdir,writeFile,readFile,rm,access,link} from 'node:fs/promises';
import {editStoreKey,prepareStore,storeIntents,compileStore,applyStoreKeys} from '../src/integrations/openspec-store.js';
import {acquireWorkspaceLock} from '../src/operations/lock.js';

const edit=(text,value)=>editStoreKey(Buffer.from(text),value).toString('utf8');
test('absent removal preserves absence while active set still creates a key',()=>{
  assert.equal(editStoreKey(null,null),null);
  assert.equal(editStoreKey(null,'finit').toString(),'store: finit\n');
  assert.deepEqual(editStoreKey(Buffer.alloc(0),null),Buffer.alloc(0));
});

for(const mode of ['retire','single','remove'])for(const missingDirectory of [false,true])
test(`missing owned config stays absent through ${mode}, missing directory=${missingDirectory}`,async t=>{
  const {root,plan,pending}=await fixture(t);
  const old={...pending,status:'ready'};
  if(missingDirectory)await rm(path.join(root,'service-b'),{recursive:true});
  const next=mode==='remove'?null:mode==='single'?{repository:'docs',root:'docs'}:{...plan,store:{...plan.store,implementationRepositories:['a'],bindings:plan.store.bindings.filter(b=>b.repository==='a')}};
  const prepared=await prepareStore(root,next,old,{previousPlan:plan});
  const b=prepared.edits.find(e=>e.repository==='b');
  assert.equal(b.action,'remove');assert.equal(b.beforeHash,null);assert.equal(b.resultHash,null);assert.equal(b.result,null);
  const retryRecord={schemaVersion:2,status:'pending',plan:next,storeBindings:storeIntents(prepared)};
  const lock=await acquireWorkspaceLock(root,{purpose:'desired-state'});
  try{
    await applyStoreKeys(lock,prepared);
    await applyStoreKeys(lock,await prepareStore(root,next,retryRecord,{previousPlan:plan}));
  }finally{await lock.release();}
  await assert.rejects(access(path.join(root,'service-b/openspec/config.yaml')),{code:'ENOENT'});
  if(missingDirectory)await assert.rejects(access(path.join(root,'service-b')),{code:'ENOENT'});
});

for(const kind of ['yaml','hardlink','identity'])test(`store ${kind} diagnostic gives safe repository, path and recovery hint`,async t=>{
  const {root,plan}=await fixture(t);
  let subject='service-a/openspec/config.yaml',repository='a';
  if(kind==='yaml')await writeFile(path.join(root,subject),'store: [PRIVATE_VALUE]\n');
  if(kind==='hardlink')await link(path.join(root,subject),path.join(root,'alias'));
  if(kind==='identity'){
    subject='docs/.openspec-store/store.yaml';repository='docs';
    await mkdir(path.dirname(path.join(root,subject)),{recursive:true});
    await writeFile(path.join(root,subject),'version: 1\nid: PRIVATE_VALUE\n');
  }
  await assert.rejects(prepareStore(root,plan,null),e=>{
    assert.equal(e.subject,subject);assert.equal(e.repository,repository);assert.match(e.hint,/repeat the same operation/);
    assert.doesNotMatch(JSON.stringify(e),/PRIVATE_VALUE/);return true;
  });
});
for(const [name,input,value,expected] of [
  ['BOM CRLF scalar replacement','\uFEFF# intro\r\nschema: spec-driven\r\nstore: old # retain\r\ncontext: keep\r\n','finit','\uFEFF# intro\r\nschema: spec-driven\r\nstore: finit # retain\r\ncontext: keep\r\n'],
  ['inline comment survives removal','\uFEFFstore: finit # keep this\r\ncontext: keep\r\n',null,'\uFEFF# keep this\r\ncontext: keep\r\n'],
  ['no trailing newline replacement','schema: spec-driven\nstore: old','finit','schema: spec-driven\nstore: finit'],
  ['no trailing newline removal','schema: spec-driven\nstore: finit',null,'schema: spec-driven\n'],
  ['flow middle removal','{schema: spec-driven, store: finit, context: "exact"}',null,'{schema: spec-driven, context: "exact"}'],
  ['flow last removal','{context: keep, store: finit}',null,'{context: keep}'],
  ['flow insertion','{context: keep}','finit','{context: keep, store: finit}'],
  ['unrelated literal and quoted keys','context: |\n  store: not-a-key\n  preserve this\n"store": old\n','finit','context: |\n  store: not-a-key\n  preserve this\n"store": finit\n'],
  ['literal store replacement preserves next key','store: |-\n  old\ncontext: keep\n','finit','store: finit\ncontext: keep\n'],
  ['literal store removal preserves next key','store: |-\n  finit\ncontext: keep\n',null,'context: keep\n'],
  ['folded CRLF store removal preserves next key','\uFEFFstore: >-\r\n  finit\r\ncontext: keep\r\n',null,'\uFEFFcontext: keep\r\n'],
  ['comment-only append','\uFEFF# exact\r\n','finit','\uFEFF# exact\r\nstore: finit\r\n'],
])test('store YAML bytes: '+name,()=>assert.equal(edit(input,value),expected));

test('store YAML rejects ambiguous or unsafe input instead of rewriting it',()=>{
  for(const text of ['store: a\nstore: b\n','store: [finit]\n','store: 12\n','context: &x test\nstore: *x\n','store: finit\n---\ncontext: other\n','store: !custom finit\n'])
    assert.throws(()=>edit(text,'finit'),e=>e.code==='openspec.store-config-conflict');
});

async function fixture(t){
  const root=await mkdtemp(path.join(os.tmpdir(),'wpc-store-edge-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  for(const repo of ['docs','service-a','service-b'])await mkdir(path.join(root,repo,'openspec'),{recursive:true});
  await writeFile(path.join(root,'docs/openspec/config.yaml'),'schema: spec-driven\n');
  await writeFile(path.join(root,'service-a/openspec/config.yaml'),'context: untouched\n');
  const binding={layout:{documentation:{repository:'docs'},repositories:{docs:{path:'docs',role:'documentation'},a:{path:'service-a',role:'code'},b:{path:'service-b',role:'code'}}}};
  const plan={repository:'docs',root:'docs',store:compileStore({id:'finit',implementationRepositories:['a','b']},binding,'docs')};
  const pending={schemaVersion:2,status:'pending',plan,storeBindings:storeIntents(await prepareStore(root,plan,null))};
  return {root,plan,pending};
}

test('pending retry rejects action and value tampering without writes',async t=>{
  const {root,plan,pending}=await fixture(t);
  for(const mutate of [b=>b.action='remove',b=>b.action='preserve',b=>b.value='another',b=>b.action='execute']){
    const record=structuredClone(pending);mutate(record.storeBindings[0]);
    await assert.rejects(prepareStore(root,plan,record),e=>e.code==='openspec.record');
  }
  assert.equal(await readFile(path.join(root,'service-a/openspec/config.yaml'),'utf8'),'context: untouched\n');
});

test('pending retry and ready retirement refuse missing ownership bindings',async t=>{
  const {root,plan,pending}=await fixture(t);
  for(const status of ['pending','ready']){
    const record={...pending,status,storeBindings:pending.storeBindings.slice(0,1)};
    await assert.rejects(prepareStore(root,plan,record,{previousPlan:plan}),e=>e.code==='openspec.store-ownership-missing');
  }
});

test('pending retry accepts before and completed bytes but rejects intervening edits',async t=>{
  const {root,plan,pending}=await fixture(t);
  const initial=await prepareStore(root,plan,pending);
  await writeFile(path.join(root,initial.edits[0].path),initial.edits[0].result);
  const retry=await prepareStore(root,plan,pending);
  assert.deepEqual(retry.edits[0].bytes,retry.edits[0].result);
  await writeFile(path.join(root,initial.edits[0].path),'context: edited externally\nstore: finit\n');
  await assert.rejects(prepareStore(root,plan,pending),e=>e.code==='openspec.store-config-changed');
});
