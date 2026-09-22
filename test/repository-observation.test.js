import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parse} from '../src/contracts/parse.js';
import {summarizeInventory,repositoryContentDigest,validateInventorySummary,summarizeTree} from '../src/workspace/repository-observation.js';
const identity={dev:'1',ino:'1',mode:'16877',nlink:'1',size:'0',mtimeNs:'1',ctimeNs:'1'};
const full=count=>{
  const entries=[{path:'.',type:'directory',identity},...Array.from({length:count},(_,i)=>({path:'f'+i,type:'file',
    identity:{...identity,ino:String(i+2),mode:'33188'},sha256:'a'.repeat(64)}))];
  return {root:'C:/fixture',entries,bytes:0,digest:'sha256:'+createHash('sha256').update(JSON.stringify(entries)).digest('hex')};
};
test('large inventory control record stays bounded without weakening shared parser limits',()=>{
  const inventory=full(4000);assert.throws(()=>parse(JSON.stringify(inventory),'json'),e=>e.code==='parse.complexity');
  const summary=summarizeInventory(inventory);assert.ok(JSON.stringify(summary).length<1000);
  assert.equal(summary.entryCount,4001);assert.equal(summary.digest,inventory.digest);
  assert.equal(repositoryContentDigest(summary),repositoryContentDigest(inventory));
  assert.deepEqual(JSON.parse(JSON.stringify(parse(JSON.stringify(summary),'json'))),summary);
  assert.deepEqual(summarizeInventory(summary),summary);
  const changed=full(4000);changed.entries[100].sha256='b'.repeat(64);
  assert.notEqual(summarizeInventory(changed).contentDigest,summary.contentDigest);
});
test('summary validation rejects unknown/missing fields and nonfinite or excessive counts',()=>{
  const summary=summarizeInventory(full(2));
  for(const bad of [{...summary,entries:[]},{...summary,entryCount:200001},{...summary,entryCount:0},
    {...summary,bytes:Infinity},{...summary,digest:'fake'},{...summary,rootIdentity:{...identity,extra:'1'}}])
    assert.throws(()=>validateInventorySummary(bad),e=>e.code==='repositories.inventory-summary');
  const missing={...summary};delete missing.contentDigest;assert.throws(()=>validateInventorySummary(missing));
});
test('tree summary preserves committed content binding without a serialized path array',()=>{
  const tree={commit:'a'.repeat(40),entries:[{path:'x'}],totalBytes:1,digest:'sha256:'+'b'.repeat(64),
    checkout:'not-performed',filters:'not-run',executionAuthorized:false};
  const summary=summarizeTree(tree);assert.equal(summary.entryCount,1);assert.equal(summary.digest,tree.digest);
  assert.equal(Object.hasOwn(summary,'entries'),false);
});
