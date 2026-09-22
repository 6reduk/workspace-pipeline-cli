import test from 'node:test';
import assert from 'node:assert/strict';
import {composeSwitchPreview} from '../src/operations/switch.js';
import {bindPreview} from '../src/operations/plan.js';
import {contractDigest} from '../src/contracts/semantic.js';
import {sha256} from '../src/source/inventory.js';
import {inspectSwitchEvents} from '../src/operations/switch-journal.js';
import {createSwitchJournal,readSwitchJournal} from '../src/operations/switch-journal-store.js';
import {acquireWorkspaceLock} from '../src/operations/lock.js';
import {mkdtemp,readFile,writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {incomingSwitchBackups} from '../src/operations/switch-backups.js';

test('incoming backups use projected original bytes, detached and validated',()=>{
  const f=fixture(),before=Buffer.from('original before old pipeline'),after=Buffer.from('new');
  const plan=structuredClone(f.replacement.plan);
  Object.assign(plan.targets[0],{action:'replace',beforeHash:sha256(before)});
  Object.assign(plan.desired.owned[0],{beforeHash:sha256(before),backup:'.pipeline/backups/original.bin'});
  const preview=bindPreview(plan,null,{observations:[{path:'AGENTS.md',bytes:before}],outputs:[{path:'AGENTS.md',bytes:after}]});
  const backups=incomingSwitchBackups(preview);
  assert.equal(backups.length,1);assert.deepEqual(backups[0].bytes,before);assert.equal(backups[0].hash,sha256(before));
  backups[0].bytes[0]=0;assert.deepEqual(incomingSwitchBackups(preview)[0].bytes,before);
  const wrong=structuredClone(plan);wrong.desired.owned[0].beforeHash=hash;
  assert.throws(()=>incomingSwitchBackups(bindPreview(wrong,null,{observations:[{path:'AGENTS.md',bytes:before}],outputs:[{path:'AGENTS.md',bytes:after}]})),e=>!!e.code);
  assert.deepEqual(incomingSwitchBackups(f.replacement),[]);
});
import {validateSwitchRecord,createSwitchRecoveryRecord,validateSwitchRecoveryRecord} from '../src/operations/switch-records.js';

function recordFixture() {
  const f=fixture(),preview=composeSwitchPreview(f);
  const sign=body=>({...body,digest:contractDigest(body)});
  const removal=sign({kind:'prepared-removal',preview:f.removal,stateFileHash:hash,providers:['codex'],backups:[],
    applySupported:true,requiresFreshApproval:true,automaticActions:false,runtime:'not-run'});
  const prepared=sign({kind:'prepared-switch',preview,removal,stateFileHash:hash,
    preparation:{objects:path.resolve('synthetic-staging/objects'),snapshot:path.resolve('synthetic-staging/snapshot')},
    sourceVerification:'verified-at-preparation',applySupported:false,requiresFreshApproval:true,runtime:'not-run'});
  return {prepared,approval:{decision:'approve',preparedDigest:prepared.digest},previous:f.previous,
    journal:'.pipeline/journals/00000000-0000-0000-0000-000000000001'};
}

test('switch recovery binds exact approved package, both snapshots and one journal without IO',()=>{
  const f=recordFixture(),before=JSON.stringify(f),record=createSwitchRecoveryRecord(f);
  assert.deepEqual(validateSwitchRecoveryRecord(record),record);
  assert.equal(record.snapshots.old.digest,f.previous.active.snapshot.digest);
  assert.equal(record.snapshots.new.digest,f.prepared.preview.phases[1].preview.plan.source.digest);
  assert.equal(record.activationSupported,false);
  record.previous.active.pipelineId='mutated';assert.equal(JSON.stringify(f),before);
});
for(const scenario of ['approval','prepared-drift','phase-substitution','backup-omission','journal-path','recovery-snapshot','activation'])test('switch recovery rejects '+scenario,()=>{
  const f=recordFixture();
  assert.throws(()=>{
    if(scenario==='approval')f.approval.preparedDigest=hash;
    if(scenario==='prepared-drift')f.prepared.stateFileHash=nextHash;
    if(scenario==='phase-substitution') {
      f.prepared.preview.phases[0].preview=f.prepared.preview.phases[1].preview;
      const {digest,...body}=f.prepared;f.prepared.digest=contractDigest(body);f.approval.preparedDigest=f.prepared.digest;
    }
    if(scenario==='backup-omission') {
      f.previous.active.owned[0].beforeHash=hash;f.previous.active.owned[0].backup='.pipeline/backups/original.bin';
    }
    if(scenario==='journal-path')f.journal='../outside';
    const record=createSwitchRecoveryRecord(f);
    if(scenario==='recovery-snapshot')record.snapshots.old.digest=nextHash;
    if(scenario==='activation')record.activationSupported=true;
    validateSwitchRecoveryRecord(record);
  },e=>!!e.code);
});

test('durable switch journal persists two phases, exposes location and audits only boundaries',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wpc-switch-log-')),f=fixture(root),preview=composeSwitchPreview(f);
  const lock=await acquireWorkspaceLock(root),locations=[];
  try {
    const journal=await createSwitchJournal(lock,preview,f.previous,{onLocation:v=>locations.push(v)});
    for(const phase of preview.phases) {
      const target=phase.preview.plan.targets[0];
      await journal.intent(phase.name,target.id);
      const pending=await readSwitchJournal(root,journal.relative,preview,f.previous);
      assert.equal(pending.status,'uncertain');
      await journal.outcome(phase.name,target.id,'completed',target.desiredHash);
      const beforeCheck=await readSwitchJournal(root,journal.relative,preview,f.previous);
      await journal.phaseChecked(phase.name,beforeCheck.expectedProjectionDigest);
    }
    const result=await readSwitchJournal(root,journal.relative,preview,f.previous);
    assert.equal(result.status,'completed');assert.equal(result.activationSupported,false);
    assert.deepEqual(journal.metrics(),{headReads:6,recordReadbacks:7,fullAudits:3});
    assert.deepEqual(locations.map(v=>v.status),['planned','created','initialized']);
    assert.equal(locations.every(v=>v.directory===journal.directory),true);
    assert.deepEqual(await readdir(root),['.pipeline']);
  }finally{await lock.release();}
});

test('durable switch journal poisons writer after interrupted append and preserves disk evidence',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wpc-switch-log-')),f=fixture(root),preview=composeSwitchPreview(f),lock=await acquireWorkspaceLock(root);
  let interrupt=false;
  try {
    const journal=await createSwitchJournal(lock,preview,f.previous,{ioBoundary:async phase=>{if(interrupt && phase==='synced')throw Error('fixture interruption');}});
    interrupt=true;
    await assert.rejects(()=>journal.intent('remove-old','remove-1'),e=>e.code==='switch-journal.io');
    await assert.rejects(()=>journal.outcome('remove-old','remove-1','completed',null),e=>e.code==='switch-journal.unavailable');
    const before=await readFile(path.join(journal.directory,'000001.json'));
    assert.equal((await readSwitchJournal(root,journal.relative,preview,f.previous)).status,'uncertain');
    assert.deepEqual(await readFile(path.join(journal.directory,'000001.json')),before);
  }finally{await lock.release();}
});

test('durable switch journal refuses released lock and mismatching write readback',async()=>{
  for(const mode of ['released','readback']) {
    const root=await mkdtemp(path.join(tmpdir(),'wpc-switch-log-')),f=fixture(root),preview=composeSwitchPreview(f),lock=await acquireWorkspaceLock(root);
    let corrupt=false;
    try {
      const journal=await createSwitchJournal(lock,preview,f.previous,{ioBoundary:async(phase,detail)=>{
        if(corrupt && phase==='synced')await writeFile(path.join(root,detail.path),'{}');
      }});
      if(mode==='released')await lock.release();else corrupt=true;
      await assert.rejects(()=>journal.intent('remove-old','remove-1'),e=>e.code===(mode==='released'?'lock.released':'switch-journal.readback'));
      await assert.rejects(()=>journal.intent('remove-old','remove-1'),e=>e.code==='switch-journal.unavailable');
      if(mode==='released')assert.deepEqual(await readdir(journal.directory),['000000.json']);
      else await assert.rejects(()=>readSwitchJournal(root,journal.relative,preview,f.previous));
    }finally{if(mode!=='released')await lock.release();}
  }
});

test('durable switch journal detects head drift before append and old prefix drift at phase audit',async()=>{
  for(const mode of ['head','prefix','torn']) {
    const root=await mkdtemp(path.join(tmpdir(),'wpc-switch-log-')),f=fixture(root),preview=composeSwitchPreview(f),lock=await acquireWorkspaceLock(root);
    try {
      const journal=await createSwitchJournal(lock,preview,f.previous);
      if(mode==='prefix')await journal.intent('remove-old','remove-1');
      const target=path.join(journal.directory,'000000.json');
      const record=JSON.parse(await readFile(target,'utf8'));record.previewDigest=hash;
      await writeFile(target,mode==='torn'?'{':JSON.stringify(record));
      if(mode==='head')await assert.rejects(()=>journal.intent('remove-old','remove-1'),e=>e.code==='switch-journal.drift');
      if(mode==='prefix') {
        await journal.outcome('remove-old','remove-1','completed',null);
        const p=eventFixture();p.append('start',null);p.operation('remove-old');
        await assert.rejects(()=>journal.phaseChecked('remove-old',p.inspect().expectedProjectionDigest),e=>e.code==='switch-journal.binding');
        await assert.rejects(()=>journal.intent('install-new','install-1'),e=>e.code==='switch-journal.unavailable');
      }
      await assert.rejects(()=>readSwitchJournal(root,journal.relative,preview,f.previous));
    }finally{await lock.release();}
  }
});

function eventFixture() {
  const f=fixture(),preview=composeSwitchPreview(f),events=[];
  const inspect=()=>inspectSwitchEvents(preview,f.previous,events);
  const append=(kind,payload)=>{
    events.push({schemaVersion:1,seq:events.length,previous:events.length?contractDigest(events.at(-1)):null,
      previewDigest:preview.digest,kind,payload});return inspect();
  };
  const operation=(phase,index=0,status='completed')=>{
    const target=preview.phases.find(p=>p.name===phase).preview.plan.targets[index];
    append('intent',{phase,operationId:target.id});
    return append('outcome',{phase,operationId:target.id,status,observedHash:status==='completed'?target.desiredHash:target.beforeHash});
  };
  const check=phase=>append('phase-checked',{phase,projectionDigest:inspect().expectedProjectionDigest});
  return {f,preview,events,inspect,append,operation,check};
}

test('switch event chain requires both phase checks and never grants activation',()=>{
  const f=eventFixture();assert.equal(f.inspect().status,'not-started');
  f.append('start',null);f.operation('remove-old');
  assert.equal(f.inspect().verifiedPhases,0);f.check('remove-old');
  assert.equal(f.inspect().phase,'install-new');f.operation('install-new');
  assert.equal(f.inspect().status,'open');const result=f.check('install-new');
  assert.equal(result.status,'completed');assert.equal(result.verifiedPhases,2);
  assert.equal(result.activationSupported,false);assert.equal(result.runtime,'not-run');
});

for(const scenario of ['early-install','early-check','wrong-projection','wrong-outcome','wrong-chain','wrong-preview','trailing-event'])test('switch event chain rejects '+scenario,()=>{
  const f=eventFixture();f.append('start',null);
  assert.throws(()=>{
    if(scenario==='early-install')f.append('intent',{phase:'install-new',operationId:'install-1'});
    if(scenario==='early-check')f.check('remove-old');
    if(scenario==='wrong-projection'){f.operation('remove-old');f.append('phase-checked',{phase:'remove-old',projectionDigest:hash});}
    if(scenario==='wrong-outcome'){f.append('intent',{phase:'remove-old',operationId:'remove-1'});f.append('outcome',{phase:'remove-old',operationId:'remove-1',status:'completed',observedHash:hash});}
    if(scenario==='wrong-chain'){f.operation('remove-old');f.events[1].previous=null;f.inspect();}
    if(scenario==='wrong-preview'){f.preview.results[0].hash=hash;f.inspect();}
    if(scenario==='trailing-event'){f.operation('remove-old');f.check('remove-old');f.operation('install-new');f.check('install-new');f.append('start',null);}
  },e=>e.code?.startsWith('switch-journal.'));
});

test('switch interrupted intent is uncertain and failed outcome stops the sequence',()=>{
  const f=eventFixture();f.append('start',null);
  const pending=f.append('intent',{phase:'remove-old',operationId:'remove-1'});
  assert.equal(pending.status,'uncertain');assert.equal(pending.verifiedPhases,0);
  const g=eventFixture();g.append('start',null);assert.equal(g.operation('remove-old',0,'failed').status,'failed');
  assert.throws(()=>g.check('remove-old'),e=>e.code==='switch-journal.sequence');
});

test('switch every successful chain prefix is recoverable without inferring later progress',()=>{
  const f=eventFixture();f.append('start',null);f.operation('remove-old');f.check('remove-old');f.operation('install-new');f.check('install-new');
  const before=JSON.stringify(f.events);
  for(let i=0;i<=f.events.length;i++) {
    const result=inspectSwitchEvents(f.preview,f.f.previous,f.events.slice(0,i));
    assert.equal(result.status==='completed',i===f.events.length);
    if(i===2 || i===5)assert.equal(result.status,'uncertain');
  }
  assert.equal(JSON.stringify(f.events),before);
});

const hash='sha256:'+'a'.repeat(64),nextHash='sha256:'+'b'.repeat(64);
function fixture(workspace=path.resolve('synthetic-switch')) {
  const oldBytes=Buffer.from('old'),newBytes=Buffer.from('new');
  const snapshot={source:{type:'git',transport:'local',path:'../old',ref:'main',subdirectory:'.'},commit:'a'.repeat(40),
    path:'.pipeline/snapshots/'+hash.slice(7),digest:hash,inventoryDigest:hash,
    origin:{path:path.join(workspace,'workspace.json'),base:workspace,digest:hash,resolvedSource:path.resolve('synthetic-old')}};
  const layout={kind:'single-repo',repositories:{game:{path:'project',role:'code'}},documentation:{repository:'game',path:'docs'}};
  const owned={path:'AGENTS.md',kind:'file',pointer:null,owner:'shared',beforeHash:null,managedHash:sha256(oldBytes),backup:null};
  const deployment={id:'old',pipelineId:'old',version:'1.0.0',snapshot,layout,providers:['codex'],adapterVersions:{codex:'test'},owned:[owned]};
  const previous={schemaVersion:1,workspace,status:'ready',runtime:'not-run',active:deployment,pending:null};
  const removal=bindPreview({schemaVersion:1,kind:'plan',command:'remove',workspace,beforeStateHash:contractDigest(previous),source:snapshot,desired:null,
    targets:[{id:'remove-1',path:'AGENTS.md',owner:'shared',action:'delete',beforeHash:sha256(oldBytes),desiredHash:null,fields:[]}]},previous,
    {observations:[{path:'AGENTS.md',bytes:oldBytes}],outputs:[]});
  const newSnapshot={...snapshot,digest:nextHash,path:'.pipeline/snapshots/'+nextHash.slice(7)};
  const desired={...deployment,id:'new',pipelineId:'new',snapshot:newSnapshot,owned:[{...owned,managedHash:sha256(newBytes)}]};
  const plan={schemaVersion:1,kind:'plan',command:'setup',workspace,beforeStateHash:null,source:newSnapshot,desired,
    targets:[{id:'install-1',path:'AGENTS.md',owner:'shared',action:'create',beforeHash:null,desiredHash:sha256(newBytes),fields:[]}]};
  const replacement=bindPreview(plan,null,{observations:[{path:'AGENTS.md',bytes:null},{path:'.codex/foreign.json',bytes:Buffer.from('{"foreign":true}')}],outputs:[{path:'AGENTS.md',bytes:newBytes}]});
  return {previous,removal,replacement};
}
test('switch composition preserves separate remove/install phases and foreign observations without IO',()=>{
  const f=fixture(),before=JSON.stringify(f),p=composeSwitchPreview(f);
  assert.deepEqual(p.phases.map(v=>v.name),['remove-old','install-new']);
  assert.equal(p.phases[0].preview.plan.targets[0].action,'delete');assert.equal(p.phases[1].preview.plan.targets[0].action,'create');
  assert.equal(Buffer.from(p.results.find(v=>v.path==='AGENTS.md').bytes,'base64').toString(),'new');
  assert.equal(p.results.find(v=>v.path==='.codex/foreign.json').hash,p.observations.find(v=>v.path==='.codex/foreign.json').hash);
  assert.equal(p.applySupported,false);assert.equal(p.sourceVerification,'not-verified');assert.equal(JSON.stringify(f),before);
  p.phases[0].preview.plan.targets[0].path='changed';assert.equal(JSON.stringify(f),before);
});
for(const scenario of ['setup-on-top','same-pipeline','layout-change','partial-removal','pending'])test('switch rejects '+scenario,()=>{
  const f=fixture();
  if(scenario==='pending'){f.previous.status='needs-reconciliation';f.previous.pending=hash;}
  else {
    const which=scenario==='partial-removal'?'removal':'replacement',p=f[which],plan=structuredClone(p.plan);
    const observations=p.observations.map(o=>({path:o.path,bytes:o.bytes===null?null:Buffer.from(o.bytes,'base64')}));
    if(scenario==='same-pipeline')plan.desired.pipelineId='old';
    if(scenario==='layout-change')plan.desired.layout.documentation.path='other-docs';
    if(scenario==='partial-removal')plan.desired=f.previous.active;
    if(scenario==='setup-on-top'){observations.find(o=>o.path==='AGENTS.md').bytes=Buffer.from('old');plan.targets[0].beforeHash=sha256(Buffer.from('old'));plan.targets[0].action='replace';}
    f[which]=bindPreview(plan,which==='removal'?f.previous:null,{observations,outputs:p.outputs.map(o=>({path:o.path,bytes:Buffer.from(o.bytes,'base64')}))});
  }
  assert.throws(()=>composeSwitchPreview(f),e=>e.code?.startsWith('switch.'));
});
