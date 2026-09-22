import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {readSwitchLineage} from '../src/operations/switch-continuation-recovery.js';
import {MAX_CONTINUATION_DEPTH} from '../src/operations/lineage-guard.js';
import {contractDigest} from '../src/contracts/semantic.js';
import {createSwitchContinuationCursor} from '../src/operations/switch-continuation-journal.js';
import {createSwitchContinuationRecoveryRecord,validateSwitchContinuationRecoveryRecord,assertSwitchContinuationPredecessor} from '../src/operations/switch-continuation-records.js';

function recordFixture() {
  const preview=fixture(true),{digest,...body}=preview;
  Object.assign(body,{workspace:path.resolve('synthetic-workspace'),recoveryPath:'.pipeline/transactions/00000000-0000-0000-0000-000000000001/recovery.json',
    recoveryHash:old,stateFileHash:fresh,uncertain:{phase:'remove-old',operationId:'remove',path:'AGENTS.md',
      beforeHash:old,desiredHash:null,observedHash:null,resolution:'verify-desired'}});
  body.predecessor.journal='.pipeline/journals/00000000-0000-0000-0000-000000000001';
  const p={...body,digest:contractDigest(body)};
  return {preview:p,approval:{decision:'approve',previewDigest:p.digest},journal:'.pipeline/journals/00000000-0000-0000-0000-000000000002'};
}
test('continuation recovery envelope is exact, detached and does not grant activation',()=>{
  const f=recordFixture(),before=JSON.stringify(f),record=createSwitchContinuationRecoveryRecord(f);
  assert.deepEqual(validateSwitchContinuationRecoveryRecord(record),record);
  assert.equal(record.activationSupported,false);record.approval.decision='reject';assert.equal(JSON.stringify(f),before);
});
for(const scenario of ['approval','self-journal','path','head','sequence','digest','activation','extra'])
  test('continuation recovery rejects '+scenario,()=>{
    const f=recordFixture();
    assert.throws(()=>{
      if(scenario==='approval')f.approval.previewDigest=old;
      if(scenario==='self-journal')f.journal=f.preview.predecessor.journal;
      if(scenario==='path')f.journal='../outside';
      if(scenario==='head')f.preview.predecessor.head='bad';
      if(scenario==='sequence')f.preview.predecessor.sequence=0;
      if(['head','sequence'].includes(scenario)) {
        const {digest,...body}=f.preview;f.preview.digest=contractDigest(body);f.approval.previewDigest=f.preview.digest;
      }
      const record=createSwitchContinuationRecoveryRecord(f);
      if(scenario==='digest')record.digest=old;
      if(scenario==='activation')record.activationSupported=true;
      if(scenario==='extra')record.extra=true;
      validateSwitchContinuationRecoveryRecord(record);
    },e=>!!e.code);
  });

// Synthetic structural inputs, not evidence of a verified filesystem preview.
const old=contractDigest('old'),fresh=contractDigest('new');
function fixture(verify=false) {
  const body={kind:'switch-continuation-preview',applySupported:false,requiresFreshApproval:true,runtime:'not-run',
    predecessor:{pending:old,journal:'.pipeline/journals/example',sequence:2,head:old,lastFileHash:fresh},
    observations:[{path:'AGENTS.md',hash:verify?null:old},{path:'foreign.txt',hash:fresh}],
    remaining:[{phase:'remove-old',phaseCheckRequired:true,operations:[{operationId:'remove',path:'AGENTS.md',
      resolution:verify?'verify-desired':'retry-approved-target',beforeHash:old,desiredHash:null}]},
    {phase:'install-new',phaseCheckRequired:true,operations:[{operationId:'install',path:'AGENTS.md',
      resolution:'apply-approved-target',beforeHash:null,desiredHash:fresh}]}]};
  return {...body,digest:contractDigest(body)};
}
function writer(preview) {
  const cursor=createSwitchContinuationCursor(preview),events=[];
  return {cursor,events,send(kind,payload) {
    const position=cursor.inspect(),e={schemaVersion:1,seq:position.sequence,previous:position.head,previewDigest:preview.digest,kind,payload};
    const result=cursor.append(e);events.push(e);return result;
  }};
}
function target(phase,operationId,status,observedHash) {return {phase,operationId,status,observedHash};}
for(const verify of [false,true])test('continuation '+(verify?'readback':'retry')+' completes ordered phases without activation',()=>{
  const p=fixture(verify),before=JSON.stringify(p),w=writer(p);
  w.send('start',p.predecessor);
  if(!verify) {
    w.send('intent',{phase:'remove-old',operationId:'remove'});
    assert.equal(w.cursor.inspect().status,'uncertain');
  }
  w.send(verify?'readback':'outcome',target('remove-old','remove','completed',null));
  w.send('phase-checked',{phase:'remove-old',projectionDigest:w.cursor.inspect().expectedProjectionDigest});
  w.send('intent',{phase:'install-new',operationId:'install'});
  w.send('outcome',target('install-new','install','completed',fresh));
  assert.equal(w.cursor.inspect().status,'open');
  const final=w.send('phase-checked',{phase:'install-new',projectionDigest:w.cursor.inspect().expectedProjectionDigest});
  assert.equal(final.status,'completed');assert.equal(final.activationSupported,false);
  assert.equal(final.expectedProjectionDigest,contractDigest([{path:'AGENTS.md',hash:fresh},{path:'foreign.txt',hash:fresh}]));
  assert.equal(JSON.stringify(p),before);
  for(let length=0;length<=w.events.length;length++) {
    const replay=createSwitchContinuationCursor(p);
    for(const event of w.events.slice(0,length))replay.append(event);
    assert.equal(replay.inspect().sequence,length);
    if(length<w.events.length)assert.notEqual(replay.inspect().status,'completed');
  }
});
for(const scenario of ['wrong-parent','early-install','skip-intent','write-on-readback','wrong-hash','early-check','wrong-chain'])
  test('continuation rejects '+scenario+' and poisons cursor',()=>{
    const p=fixture(scenario==='write-on-readback'),w=writer(p);
    assert.throws(()=>{
      if(scenario==='wrong-parent')return w.send('start',{...p.predecessor,sequence:3});
      w.send('start',p.predecessor);
      if(scenario==='early-install')return w.send('intent',{phase:'install-new',operationId:'install'});
      if(scenario==='skip-intent')return w.send('outcome',target('remove-old','remove','completed',null));
      if(scenario==='early-check')return w.send('phase-checked',{phase:'remove-old',projectionDigest:w.cursor.inspect().expectedProjectionDigest});
      if(scenario==='wrong-chain')return w.cursor.append({schemaVersion:1,seq:1,previous:null,previewDigest:p.digest,kind:'intent',payload:{phase:'remove-old',operationId:'remove'}});
      w.send('intent',{phase:'remove-old',operationId:'remove'});
      if(scenario==='wrong-hash')w.send('outcome',target('remove-old','remove','completed',fresh));
    },e=>!!e.code);
    assert.throws(()=>w.send('intent',{phase:'remove-old',operationId:'remove'}),e=>e.code==='switch-continuation-journal.unavailable');
  });
for(const status of ['failed','uncertain'])test('continuation retains stopped '+status+' outcome',()=>{
  const p=fixture(),w=writer(p);w.send('start',p.predecessor);w.send('intent',{phase:'remove-old',operationId:'remove'});
  w.send('outcome',target('remove-old','remove',status,old));assert.equal(w.cursor.inspect().status,status);
  assert.throws(()=>w.send('intent',{phase:'remove-old',operationId:'remove'}),e=>!!e.code);
});
test('continuation detaches input and refuses digest drift and invalid resolution',()=>{
  const p=fixture(),w=writer(p),parent=structuredClone(p.predecessor);p.remaining[0].operations.length=0;
  w.send('start',parent);w.send('intent',{phase:'remove-old',operationId:'remove'});
  assert.throws(()=>createSwitchContinuationCursor(p),e=>!!e.code);
  const invalid=fixture();invalid.remaining[1].operations[0].resolution='verify-desired';
  const {digest,...body}=invalid;invalid.digest=contractDigest(body);
  assert.throws(()=>createSwitchContinuationCursor(invalid),e=>!!e.code);
});

// Pure linkage checks only: synthetic evidence is not durable ancestry or a
// permission to execute. The production ancestry reader is a separate boundary.
function nextGeneration({phase='remove-old',outcome=false,desired=false,readback=false,prefix=false}={}) {
  const f=recordFixture(),{digest,...body}=f.preview;
  body.observations[0].hash=readback?null:old;
  body.remaining[0].operations[0].resolution=readback?'verify-desired':'retry-approved-target';
  body.uncertain.observedHash=body.observations[0].hash;
  body.uncertain.resolution=body.remaining[0].operations[0].resolution;
  if(prefix) {
    body.observations.push({path:'prefix.md',hash:old});
    body.remaining[0].operations.unshift({operationId:'prefix',path:'prefix.md',resolution:'retry-approved-target',
      beforeHash:old,desiredHash:fresh});
    body.remaining[0].operations[1].resolution='apply-approved-target';
    body.uncertain={phase:'remove-old',operationId:'prefix',path:'prefix.md',beforeHash:old,desiredHash:fresh,
      observedHash:old,resolution:'retry-approved-target'};
  }
  const p={...body,digest:contractDigest(body)};
  const record=createSwitchContinuationRecoveryRecord({...f,preview:p,approval:{decision:'approve',previewDigest:p.digest}});
  const w=writer(p);w.send('start',p.predecessor);
  if(prefix) {
    w.send('intent',{phase:'remove-old',operationId:'prefix'});
    w.send('outcome',target('remove-old','prefix','completed',fresh));
  }
  if(phase==='install-new') {
    w.send('intent',{phase:'remove-old',operationId:'remove'});
    w.send('outcome',target('remove-old','remove','completed',null));
    w.send('phase-checked',{phase:'remove-old',projectionDigest:w.cursor.inspect().expectedProjectionDigest});
  }
  const index=phase==='remove-old'?0:1,op=p.remaining[index].operations.at(-1);
  const observed=desired?op.desiredHash:op.beforeHash;
  if(!readback)w.send('intent',{phase,operationId:op.operationId});
  if(outcome || readback)w.send(readback?'readback':'outcome',target(phase,op.operationId,'uncertain',observed));
  const evidence={record,fileHash:contractDigest('parent-bytes'),journal:{...w.cursor.inspect(),lastFileHash:contractDigest('last-event-bytes')}};
  const remaining=structuredClone(p.remaining.slice(index));
  if(prefix && index===0)remaining[0].operations.shift();
  const resolution=observed===op.desiredHash?'verify-desired':'retry-approved-target';
  remaining[0].operations[0].resolution=resolution;
  const childBody={...body,recoveryPath:'.pipeline/transactions/00000000-0000-0000-0000-000000000002/recovery.json',
    recoveryHash:evidence.fileHash,predecessor:{pending:record.digest,journal:record.journal,
      sequence:evidence.journal.sequence,head:evidence.journal.head,lastFileHash:evidence.journal.lastFileHash},
    observations:[{path:'AGENTS.md',hash:observed},{path:'foreign.txt',hash:fresh},...(prefix?[{path:'prefix.md',hash:fresh}]:[])],
    uncertain:{phase,operationId:op.operationId,path:op.path,beforeHash:op.beforeHash,desiredHash:op.desiredHash,
      observedHash:observed,resolution},remaining};
  return {preview:{...childBody,digest:contractDigest(childBody)},evidence};
}

for(const phase of ['remove-old','install-new'])for(const outcome of [false,true])for(const desired of [false,true])
  test(`second-generation linkage ${phase} outcome=${outcome} desired=${desired}`,()=>{
    const f=nextGeneration({phase,outcome,desired}),before=JSON.stringify(f);
    assert.doesNotThrow(()=>assertSwitchContinuationPredecessor(f.preview,f.evidence));
    const record=createSwitchContinuationRecoveryRecord({preview:f.preview,
      approval:{decision:'approve',previewDigest:f.preview.digest},
      journal:'.pipeline/journals/00000000-0000-0000-0000-000000000003'});
    assert.equal(record.activationSupported,false);assert.equal(JSON.stringify(f),before);
    assert.equal(f.preview.remaining.length,phase==='remove-old'?2:1);
  });

for(const scenario of ['workspace','parent-hash','parent-sequence','parent-digest','not-uncertain','foreign-drift',
  'operation-substitution','replay-completed-phase','omit-remaining','unknown-kind'])
  test('second-generation linkage rejects '+scenario,()=>{
    const {preview:p,evidence:e}=nextGeneration({phase:'install-new',desired:true});
    if(scenario==='workspace')p.workspace=path.resolve('another-workspace');
    if(scenario==='parent-hash')p.recoveryHash=old;
    if(scenario==='parent-sequence')p.predecessor.sequence++;
    if(scenario==='parent-digest')p.predecessor.pending=old;
    if(scenario==='not-uncertain')e.journal.status='completed';
    if(scenario==='foreign-drift')p.observations[1].hash=old;
    if(scenario==='operation-substitution')p.remaining[0].operations[0].operationId='different';
    if(scenario==='replay-completed-phase')p.remaining.unshift(structuredClone(e.record.preview.remaining[0]));
    if(scenario==='omit-remaining')p.remaining=[];
    if(scenario==='unknown-kind')e.record.kind='other-recovery';
    assert.throws(()=>assertSwitchContinuationPredecessor(p,e),e=>e.code?.startsWith('switch-continuation-record.'));
  });

test('second-generation readback stays readback-only and cannot restore old write authority',()=>{
  const good=nextGeneration({readback:true,desired:true});
  assert.doesNotThrow(()=>assertSwitchContinuationPredecessor(good.preview,good.evidence));
  const bad=nextGeneration({readback:true,desired:false});
  assert.throws(()=>assertSwitchContinuationPredecessor(bad.preview,bad.evidence),
    e=>e.code==='switch-continuation-record.observations');
});

test('second-generation linkage preserves completed targets within the interrupted phase',()=>{
  const f=nextGeneration({prefix:true,desired:true});
  assert.doesNotThrow(()=>assertSwitchContinuationPredecessor(f.preview,f.evidence));
  assert.deepEqual(f.preview.remaining[0].operations.map(o=>o.operationId),['remove']);
  f.preview.observations.find(o=>o.path==='prefix.md').hash=old;
  assert.throws(()=>assertSwitchContinuationPredecessor(f.preview,f.evidence),
    e=>e.code==='switch-continuation-record.observations');
});

test('normalized original predecessor retains the same first-generation semantics',()=>{
  const f=nextGeneration({phase:'install-new',desired:true}),p=f.evidence.record.preview;
  f.evidence.record={...f.evidence.record,kind:'switch-recovery',previous:{workspace:p.workspace},
    prepared:{preview:{observations:p.observations,phases:p.remaining.map(phase=>({name:phase.phase,
      preview:{plan:{targets:phase.operations.map(t=>({...t,id:t.operationId}))}}}))}}};
  assert.doesNotThrow(()=>assertSwitchContinuationPredecessor(f.preview,f.evidence));
});

for(const stage of ['start','outcome','between','last-outcome','completed'])test('boundary continuation preserves exact recorded progress '+stage,()=>{
  const f=recordFixture(),record=createSwitchContinuationRecoveryRecord(f),w=writer(f.preview);
  w.send('start',f.preview.predecessor);
  if(stage!=='start')w.send('readback',target('remove-old','remove','completed',null));
  if(['between','last-outcome','completed'].includes(stage))w.send('phase-checked',{phase:'remove-old',projectionDigest:w.cursor.inspect().expectedProjectionDigest});
  if(['last-outcome','completed'].includes(stage)) {
    w.send('intent',{phase:'install-new',operationId:'install'});
    w.send('outcome',target('install-new','install','completed',fresh));
  }
  if(stage==='completed')w.send('phase-checked',{phase:'install-new',projectionDigest:w.cursor.inspect().expectedProjectionDigest});
  const evidence={record,fileHash:old,journal:{...w.cursor.inspect(),lastFileHash:fresh}};
  const remaining=structuredClone(f.preview.remaining);
  if(stage!=='start')remaining[0].operations=[];
  if(['between','last-outcome','completed'].includes(stage))remaining.shift();
  if(stage==='last-outcome')remaining[0].operations=[];
  if(stage==='completed')remaining.length=0;
  const {digest,...body}=f.preview;
  Object.assign(body,{uncertain:null,remaining,recoveryPath:record.journal.replace('/journals/','/transactions/')+'/recovery.json',recoveryHash:old,
    predecessor:{pending:record.digest,journal:record.journal,sequence:evidence.journal.sequence,head:evidence.journal.head,lastFileHash:fresh},
    observations:[{path:'AGENTS.md',hash:['last-outcome','completed'].includes(stage)?fresh:null},{path:'foreign.txt',hash:fresh}]});
  const p={...body,digest:contractDigest(body)};
  assert.doesNotThrow(()=>assertSwitchContinuationPredecessor(p,evidence));
  const next=createSwitchContinuationRecoveryRecord({preview:p,approval:{decision:'approve',previewDigest:p.digest},
    journal:'.pipeline/journals/00000000-0000-0000-0000-000000000003'});
  assert.equal(next.preview.uncertain,null);
  const cursor=writer(p);cursor.send('start',p.predecessor);
  assert.equal(cursor.cursor.inspect().status,stage==='completed'?'completed':'open');
  const changed=structuredClone(p);changed.observations[1].hash=old;
  assert.throws(()=>assertSwitchContinuationPredecessor(changed,evidence),e=>e.code==='switch-continuation-record.observations');
  const skipped=structuredClone(p);skipped.remaining=stage==='completed'?f.preview.remaining:[];
  assert.throws(()=>assertSwitchContinuationPredecessor(skipped,evidence),e=>e.code==='switch-continuation-record.plan');
  const lied=structuredClone(evidence);lied.journal.status='uncertain';
  assert.throws(()=>assertSwitchContinuationPredecessor(p,lied),e=>e.code==='switch-continuation-record.lineage');
});

for(const mode of ['cycle','depth'])test('durable switch lineage refuses '+mode+' without rewriting evidence',async()=>{
  const workspace=await mkdtemp(path.join(tmpdir(),'wpc-lineage-')),files=[];
  const id=n=>'00000000-0000-0000-0000-'+String(n).padStart(12,'0');
  const recovery=n=>'.pipeline/transactions/'+id(n)+'/recovery.json';
  const count=mode==='cycle'?2:MAX_CONTINUATION_DEPTH+1;
  for(let n=1;n<=count;n++) {
    const next=mode==='cycle' && n===2?1:n+1,f=recordFixture(),{digest,...body}=f.preview;
    Object.assign(body,{workspace,recoveryPath:recovery(next)});
    body.predecessor.journal='.pipeline/journals/'+id(next);
    const preview={...body,digest:contractDigest(body)},journal='.pipeline/journals/'+id(n);
    const record=createSwitchContinuationRecoveryRecord({preview,approval:{decision:'approve',previewDigest:preview.digest},journal});
    const event={schemaVersion:1,seq:0,previous:null,previewDigest:preview.digest,kind:'start',payload:preview.predecessor};
    for(const [relative,value] of [[recovery(n),record],[journal+'/000000.json',event]]) {
      const filename=path.join(workspace,relative),bytes=JSON.stringify(value)+'\n';
      await mkdir(path.dirname(filename),{recursive:true});await writeFile(filename,bytes);files.push({filename,bytes});
    }
  }
  await assert.rejects(()=>readSwitchLineage(workspace,recovery(1)),e=>e.code==='switch-continuation-recovery.'+mode);
  for(const {filename,bytes} of files)assert.equal(await readFile(filename,'utf8'),bytes);
});
