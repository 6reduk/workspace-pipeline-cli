import test from 'node:test';
import assert from 'node:assert/strict';
import {createLineageGuard,assertContinuationCapacity,MAX_CONTINUATION_DEPTH} from '../src/operations/lineage-guard.js';

const record=i=>'.pipeline/transactions/00000000-0000-0000-0000-'+String(i).padStart(12,'0')+'/recovery.json';
const rejects=(fn,code)=>assert.throws(fn,e=>e.code===code);

test('lineage guard accepts 32 links and rejects the 33rd before record access',()=>{
  assert.equal(MAX_CONTINUATION_DEPTH,32);
  const guard=createLineageGuard();let opened=0;
  const open=id=>{guard.visit(record(id));opened++;};
  for(let i=1;i<=32;i++)open(i);
  assert.equal(opened,32);rejects(()=>open(33),'reconciliation.depth');assert.equal(opened,32);
});

test('lineage guard rejects self and multi-link cycles before record access',()=>{
  for(const prefix of [[1],[1,2,3]]) {
    const guard=createLineageGuard();let opened=0;
    for(const i of prefix){guard.visit(record(i));opened++;}
    rejects(()=>{guard.visit(record(1));opened++;},'reconciliation.cycle');assert.equal(opened,prefix.length);
  }
});

test('lineage guard uses canonical identities and isolates each traversal',()=>{
  const guard=createLineageGuard();
  for(const invalid of [null,1,'../recovery.json',record(1).replace('/transactions/','\\transactions\\'),record(1)+'/x',
    '.pipeline/transactions/'+'-'.repeat(36)+'/recovery.json',record(1).replace('00000000','ABCDEF00')])
    rejects(()=>guard.visit(invalid),'reconciliation.lineage');
  guard.visit(record(1));createLineageGuard().visit(record(1));
  rejects(()=>guard.visit(record(1)),'reconciliation.cycle');
});

test('continuation preparation capacity admits depth 31 but not depth 32',()=>{
  for(const depth of [0,1,31])assert.doesNotThrow(()=>assertContinuationCapacity(depth));
  for(const depth of [32,33,-1,0.5,NaN,Infinity,'1',null])rejects(()=>assertContinuationCapacity(depth),'reconciliation.depth');
});
