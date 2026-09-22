import test from 'node:test';
import assert from 'node:assert/strict';
import {planCombinedRetention} from '../src/operations/retention-combined.js';
const day=86400000,now=100*day;
const item=(i,age=40,extra={})=>({id:'00000000-0000-0000-0000-'+String(i).padStart(12,'0'),
  status:'completed',completedAt:now-age*day,bytes:10,protectionReasons:[],...extra});
const policy={journals:{maxAgeDays:30,maxJournals:20},cleanupReceipts:{maxAgeDays:30,maxReceipts:20},maxDeletesPerRun:1};
const plan=(journals=[],receipts=[],p=policy)=>planCombinedRetention({journals,receipts,policy:p,now});
test('combined retention shares one budget and orders oldest across classes',()=>{
  const p=plan([item(1,40)],[item(2,50)]);
  assert.equal(p.selected.length,1);assert.equal(p.selected[0].type,'cleanup-receipt');
  assert.equal(p.deferred[0].type,'journal');assert.equal(p.perClass[0].remainingOverAge,1);
});
test('combined retention treats identical UUID in different classes independently',()=>{
  const p=plan([item(1)],[item(1)],{...policy,maxDeletesPerRun:2});
  assert.equal(p.selected.length,2);assert.deepEqual(p.selected.map(i=>i.type),['cleanup-receipt','journal']);
  assert.deepEqual(p.perClass.map(c=>c.remainingCount),[0,0]);
});
test('combined retention uses separate age OR count policies',()=>{
  const p=plan([item(1,1),item(2,2)],[item(3,40)],{...policy,journals:{maxAgeDays:90,maxJournals:1},maxDeletesPerRun:2});
  assert.deepEqual(p.selected.map(i=>i.reasons),[['age'],['count']]);
  assert.deepEqual(p.perClass.map(c=>c.remainingOverCount),[0,0]);
});
test('combined retention protects incomplete/reference/future items and reports unmet limits',()=>{
  const p=plan([item(1,40,{protectionReasons:['retained-reference']})],
    [item(2,40,{status:'uncertain'}),item(3,-1)],{...policy,journals:{maxAgeDays:0,maxJournals:0},cleanupReceipts:{maxAgeDays:0,maxReceipts:0}});
  assert.equal(p.selected.length,0);assert.equal(p.protected.length,3);
  assert.deepEqual(p.perClass.map(c=>c.remainingOverCount),[1,2]);
});
test('combined retention is deterministic, detached and zero cap is read-only',()=>{
  const a=item(1),b=item(2),p=plan([b,a],[item(3)],{...policy,maxDeletesPerRun:0});
  assert.deepEqual(p,plan([a,b],[item(3)],{...policy,maxDeletesPerRun:0}));
  assert.equal(p.selected.length,0);assert.equal(p.deferred.length,3);
  p.policy.journals.maxAgeDays=0;assert.equal(policy.journals.maxAgeDays,30);
  assert.equal(p.automaticActions,false);assert.equal(p.requiresFilesystemValidation,true);
});
test('combined retention rejects invalid limits, duplicate same-class IDs and total overflow',()=>{
  for(const maxDeletesPerRun of [-1,1.5,NaN,'1'])assert.throws(()=>plan([],[],{...policy,maxDeletesPerRun}));
  assert.throws(()=>plan([],[],{...policy,extra:true}));
  assert.throws(()=>plan([item(1),item(1)]));
  assert.throws(()=>plan([item(1,40,{bytes:Number.MAX_SAFE_INTEGER})],[item(2)]),e=>e.code==='retention-combined.bytes');
});
test('combined retention rejects policy accessors without executing them',()=>{
  let called=false;const p={...policy};Object.defineProperty(p,'cleanupReceipts',{get(){called=true;return {};},enumerable:true});
  assert.throws(()=>plan([],[],p));assert.equal(called,false);
});
