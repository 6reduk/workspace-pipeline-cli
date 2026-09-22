import test from 'node:test';
import assert from 'node:assert/strict';
import { planRetention } from '../src/operations/retention.js';

const day=86400000,now=100*day;
const journal=(i,days=0,extra={})=>({id:'00000000-0000-0000-0000-'+String(i).padStart(12,'0'),
  status:'completed',completedAt:now-days*day,bytes:10,protectionReasons:[],...extra});
const plan=(journals,policy={},clock=now)=>planRetention({journals,policy:{maxAgeDays:30,maxJournals:100,maxDeletesPerRun:100,...policy},now:clock});

test('retention age boundary is strict, with oldest first',()=>{
  const p=plan([journal(1,30),journal(2,31),journal(3,50)]);
  assert.deepEqual(p.selected.map(j=>j.id),[journal(3).id,journal(2).id]);
  assert.deepEqual(p.selected[0].reasons,['age']);assert.equal(p.totals.remainingOverAge,0);
});
test('retention count limit applies independently of age',()=>{
  const p=plan([journal(1,1),journal(2,2),journal(3,3)],{maxJournals:1});
  assert.deepEqual(p.selected.map(j=>j.id),[journal(3).id,journal(2).id]);
  assert.deepEqual(p.selected[0].reasons,['count']);assert.equal(p.totals.remainingCount,1);
});
test('retention uses age OR count and reports per-run cap remainder',()=>{
  const p=plan([journal(1,1),journal(2,31),journal(3,50)],{maxJournals:1,maxDeletesPerRun:1});
  assert.equal(p.selected.length,1);assert.deepEqual(p.selected[0].reasons,['age','count']);
  assert.equal(p.deferred.length,1);assert.equal(p.totals.remainingOverCount,1);assert.equal(p.totals.remainingOverAge,1);
});
test('retention count includes protected history and never bypasses protection',()=>{
  const journals=[journal(1,50,{protectionReasons:['current-state']}),journal(2,40,{status:'pending'}),journal(3,1)];
  const p=plan(journals,{maxJournals:0});
  assert.deepEqual(p.selected.map(j=>j.id),[journal(3).id]);assert.equal(p.protected.length,2);
  assert.equal(p.totals.remainingOverCount,2);assert.equal(p.totals.remainingOverAge,2);
});
test('retention protects every incomplete status, references and future timestamps',()=>{
  for(const status of ['active','pending','uncertain','unknown','orphan']) {
    const p=plan([journal(1,0,{status,completedAt:null})],{maxJournals:0});
    assert.equal(p.selected.length,0);assert.ok(p.protected[0].protectionReasons.includes('status:'+status));
  }
  for(const reason of ['current-run','current-state','retained-reference','dependency','inspection-failed'])
    assert.equal(plan([journal(1,99,{protectionReasons:[reason]})],{maxJournals:0}).selected.length,0);
  assert.deepEqual(plan([journal(1,-1)],{maxJournals:0}).protected[0].protectionReasons,['future-timestamp']);
});
test('retention tie order and digest do not depend on input order',()=>{
  const a=journal(1,31),b=journal(2,31),p=plan([b,a]);
  assert.deepEqual(p,plan([a,b]));assert.equal(p.selected[0].id,a.id);
});
test('retention zero deletion cap previews backlog without deleting, empty input valid',()=>{
  const p=plan([journal(1,31)],{maxDeletesPerRun:0});
  assert.equal(p.selected.length,0);assert.equal(p.deferred.length,1);assert.equal(p.totals.remainingOverAge,1);
  assert.equal(p.automaticActions,false);assert.equal(p.requiresFilesystemValidation,true);
  assert.equal(plan([]).totals.observedBytes,0);
});
test('retention policy requires explicit bounded integer limits and safe clock',()=>{
  for(const key of ['maxAgeDays','maxJournals','maxDeletesPerRun'])for(const value of [-1,0.5,NaN,Infinity,'1',null,Number.MAX_SAFE_INTEGER+1])
    assert.throws(()=>plan([],{[key]:value}),e=>e.code==='retention.policy');
  assert.throws(()=>plan([],{maxAgeDays:Number.MAX_SAFE_INTEGER}),e=>e.code==='retention.policy');
  assert.throws(()=>planRetention({journals:[],policy:{},now}),e=>e.code==='retention.policy');
  for(const clock of [-1,NaN,8640000000000001])assert.throws(()=>plan([],{},clock),e=>e.code==='retention.policy');
});
test('retention rejects duplicate identifiers, foreign fields, invalid dates and byte totals',()=>{
  for(const journals of [[journal(1),journal(1)],[journal(1,0,{id:'../other'})],[journal(1,0,{status:'failed'})],
    [journal(1,0,{completedAt:null})],[journal(1,0,{bytes:-1})],[journal(1,0,{extra:true})],
    [journal(1,0,{protectionReasons:['unknown-reason']})],[journal(1,0,{protectionReasons:['dependency','dependency']})]])
    assert.throws(()=>plan(journals),e=>e.code==='retention.journal');
  assert.throws(()=>plan([journal(1,0,{bytes:Number.MAX_SAFE_INTEGER}),journal(2)]),e=>e.code==='retention.bytes');
});
test('retention reads no accessors and returns detached data',()=>{
  let invoked=false;const j=journal(1,31);
  Object.defineProperty(j,'bytes',{enumerable:true,get(){invoked=true;return 10;}});
  assert.throws(()=>plan([j]),e=>e.code==='retention.journal');assert.equal(invoked,false);
  const input=[journal(1,31)],before=structuredClone(input),p=plan(input);
  p.selected[0].protectionReasons.push('changed');p.observed[0].bytes=0;
  assert.deepEqual(input,before);assert.equal(plan(input).totals.selectedBytes,10);
});
