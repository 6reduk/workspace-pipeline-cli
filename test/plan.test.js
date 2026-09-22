import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rename, readdir, link, symlink } from 'node:fs/promises';
import { readRecord, readState, resolveOrigin, previewRebind, verifyInstalledSnapshot, resolveApprovedRebind, observeTargets } from '../src/operations/state.js';
import { contractDigest } from '../src/contracts/semantic.js';
import { sha256, verifyPackage } from '../src/source/inventory.js';
import { reconcileOwnership, reconcileFields } from '../src/operations/ownership.js';
import { bindPreview, checkPreview, composePlan, preparePlan, assertRequestScope } from '../src/operations/plan.js';
import { providerDouble } from './fixtures/provider-double.js';

const hash='sha256:'+'a'.repeat(64);
const otherHash='sha256:'+'b'.repeat(64);

test('Grok cannot emit a second root entry; shared CLAUDE entry and native skills remain allowed',()=>{
  const file=(owner,path)=>({owner,path,kind:'file',bytes:Buffer.from('# Instructions\n')});
  for(const providers of [['grok'],['claude','grok']]) {
    assert.throws(()=>assertRequestScope(file('grok','GROK.md'),providers),e=>e.code==='plan.scope');
    assert.doesNotThrow(()=>assertRequestScope(file('shared','CLAUDE.md'),providers));
    assert.doesNotThrow(()=>assertRequestScope(file('grok','.grok/skills/example/SKILL.md'),providers));
  }
});

test('foreign equality preserves without silently acquiring ownership',()=>{
  assert.deepEqual(reconcileOwnership({currentHash:hash,desiredHash:hash}),{action:'preserve',owned:false,backupRequired:false});
  assert.throws(()=>reconcileOwnership({currentHash:hash,desiredHash:otherHash}),e=>e.code==='ownership.foreign');
});
test('only exact explicit takeover permits foreign replacement or acquisition',()=>{
  assert.deepEqual(reconcileOwnership({currentHash:hash,desiredHash:otherHash,takeover:{beforeHash:hash,desiredHash:otherHash}}),{action:'replace',owned:true,backupRequired:true});
  assert.equal(reconcileOwnership({currentHash:hash,desiredHash:hash,takeover:{beforeHash:hash,desiredHash:hash}}).owned,true);
  assert.throws(()=>reconcileOwnership({currentHash:hash,desiredHash:otherHash,takeover:{beforeHash:otherHash,desiredHash:otherHash}}),e=>e.code==='ownership.takeover');
});
test('owned drift including absent target fails even when current equals desired',()=>{
  for(const currentHash of [null,otherHash]) assert.throws(()=>reconcileOwnership({currentHash,desiredHash:currentHash,managedHash:hash}),e=>e.code==='ownership.drift');
  assert.throws(()=>reconcileOwnership({currentHash:otherHash,desiredHash:hash,managedHash:hash,takeover:{beforeHash:otherHash,desiredHash:hash}}),e=>e.code==='ownership.drift');
});
test('create, owned update and removal; foreign removal preserves',()=>{
  assert.equal(reconcileOwnership({currentHash:null,desiredHash:hash}).action,'create');
  assert.equal(reconcileOwnership({currentHash:hash,desiredHash:otherHash,managedHash:hash}).action,'replace');
  assert.equal(reconcileOwnership({currentHash:hash,desiredHash:hash,managedHash:hash}).owned,true);
  assert.equal(reconcileOwnership({currentHash:hash,desiredHash:null,managedHash:hash}).action,'delete');
  assert.equal(reconcileOwnership({currentHash:hash,desiredHash:null}).action,'preserve');
  assert.throws(()=>reconcileOwnership({currentHash:'bad',desiredHash:null}),e=>e.code==='ownership.hash');
});
test('field update preserves foreign siblings and does not mutate inputs',()=>{
  const current={mcp:{ours:{command:'old'},foreign:{command:'secret'}},model:'user-choice'};
  const before=JSON.stringify(current),request={pointer:'/mcp/ours',present:true,value:{command:'new'},managedHash:contractDigest(current.mcp.ours)};
  const result=reconcileFields(current,[request]);
  assert.equal(JSON.stringify(current),before);
  assert.equal(result.value.mcp.foreign.command,'secret');assert.equal(result.value.model,'user-choice');
  assert.equal(result.value.mcp.ours.command,'new');assert.equal(result.decisions[0].backupRequired,true);
  result.value.mcp.ours.command='changed';assert.equal(request.value.command,'new');
});
test('missing fields differ from JSON null; create parents and leave parents on removal',()=>{
  const first=reconcileFields({},[{pointer:'/mcp/ours',present:true,value:null}]);
  assert.equal(first.decisions[0].currentHash,null);assert.equal(first.decisions[0].desiredHash,contractDigest(null));
  const second=reconcileFields(first.value,[{pointer:'/mcp/ours',present:false,managedHash:contractDigest(null)}]);
  assert.equal(Object.hasOwn(second.value,'mcp'),true);assert.equal(Object.hasOwn(second.value.mcp,'ours'),false);
});
test('field conflicts fail closed without changing original object',()=>{
  const current={a:1,b:2},before=JSON.stringify(current);
  assert.throws(()=>reconcileFields(current,[{pointer:'/a',present:true,value:3,managedHash:contractDigest(1)},{pointer:'/b',present:true,value:4}]),e=>e.code==='ownership.foreign');
  assert.equal(JSON.stringify(current),before);
});
test('field pointer escaping and deterministic request order',()=>{
  const requests=[{pointer:'/z',present:true,value:1},{pointer:'/a~1b/~0x',present:true,value:2}];
  assert.deepEqual(reconcileFields({},requests),reconcileFields({},[...requests].reverse()));
  assert.equal(reconcileFields({},requests).value['a/b']['~x'],2);
});
test('overlapping, duplicate, poison and malformed field pointers rejected',()=>{
  for(const pointers of [['/a','/a/b'],['/a/b','/a'],['/a','/a']]) {
    assert.throws(()=>reconcileFields({},pointers.map(pointer=>({pointer,present:true,value:1}))),e=>e.code==='ownership.overlap');
  }
  for(const pointer of ['', 'a','/a~2','/__proto__/x','/a/constructor']) {
    assert.throws(()=>reconcileFields({},[{pointer,present:true,value:1}]),e=>e.code==='ownership.pointer');
  }
});
test('arrays can be whole owned values but array indices and scalar ancestors rejected',()=>{
  for(const current of [{a:[]},{a:1},{a:null}]) assert.throws(()=>reconcileFields(current,[{pointer:'/a/x',present:true,value:1}]),e=>e.code==='ownership.ancestor');
  const result=reconcileFields({a:[1]},[{pointer:'/a',present:true,value:[2],managedHash:contractDigest([1])}]);
  assert.deepEqual(result.value.a,[2]);
});
test('JSON-domain guard rejects lossy values, getters, cycles and exotic objects',()=>{
  const cycle={};cycle.self=cycle;
  const getter={get secret(){throw new Error('must not execute');}};
  for(const value of [undefined,NaN,Infinity,1n,new Date(),cycle,getter,new Array(2),{x:undefined}]) {
    assert.throws(()=>reconcileFields({},[{pointer:'/x',present:true,value}]),e=>e.code==='ownership.value');
  }
});
async function fixture() {
  const base=await mkdtemp(path.join(tmpdir(),'wpc-s4-')),wrapper=path.join(base,'wrapper');
  await mkdir(path.join(wrapper,'project'),{recursive:true});await mkdir(path.join(base,'pipeline'));
  const manifest={schemaVersion:1,pipeline:{type:'git',transport:'local',path:'../../pipeline',ref:'main',subdirectory:'.'},
    providers:['codex'],layout:{kind:'single-repo',repositories:{game:{path:'project',role:'code'}},documentation:{repository:'game',path:'docs'}}};
  const manifestPath=path.join(wrapper,'project/workspace.json');
  await writeFile(manifestPath,JSON.stringify(manifest));
  const resolved=await resolveOrigin({wrapper,manifestPath});
  const previous={schemaVersion:1,workspace:wrapper,status:'ready',runtime:'not-run',pending:null,
    active:{id:'installed',pipelineId:'sample',version:'1.0.0',providers:['codex'],adapterVersions:{codex:'test'},owned:[],layout:manifest.layout,
      snapshot:{source:manifest.pipeline,commit:'a'.repeat(40),path:'.pipeline/snapshots/a',digest:hash,inventoryDigest:hash,origin:resolved.origin}}};
  return {base,wrapper,manifest,manifestPath,previous,resolved};
}

async function installedFixture() {
  const f = await fixture();
  const manifest = {schemaVersion:1,id:'sample',version:'1.0.0',resources:'resources',inventory:'inventory.json',
    agentsDocument:{mode:'default'},providers:{codex:{skills:'skills',agents:null,mcp:null,entryInstructions:null,requires:[]}}};
  const files = new Map(Object.entries({'pipeline.json':JSON.stringify(manifest),'resources/process.md':'# Process\n','skills/test/SKILL.md':'# Skill\n'})
    .map(([name,bytes])=>[name,Buffer.from(bytes)]));
  files.set('inventory.json',Buffer.from(JSON.stringify(Object.fromEntries([...files].map(([name,bytes])=>[name,sha256(bytes)])))));
  const verified = await verifyPackage([...files].map(([name,bytes])=>({path:name,size:bytes.length,mode:'100644',type:'blob'})),async entry=>files.get(entry.path));
  f.previous.active.snapshot.digest=verified.digest;f.previous.active.snapshot.inventoryDigest=verified.inventoryDigest;
  const root=path.join(f.wrapper,f.previous.active.snapshot.path);
  for(const [name,bytes] of files){const target=path.join(root,name);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,bytes);}
  return {...f,root,files,verified};
}

async function previewFixture() {
  const f=await fixture(),bytes=Buffer.from('new instructions');
  const plan={schemaVersion:1,kind:'plan',workspace:f.wrapper,command:'setup',beforeStateHash:contractDigest(f.previous),
    source:f.previous.active.snapshot,desired:f.previous.active,
    targets:[{id:'entry',path:'AGENTS.md',action:'create',owner:'shared',beforeHash:null,desiredHash:sha256(bytes),fields:[]}]};
  const observations=[{path:'AGENTS.md',bytes:null},{path:'.codex/config.toml',bytes:Buffer.from('foreign setting')}];
  const outputs=[{path:'AGENTS.md',bytes}];
  return {...f,plan,observations,outputs};
}

async function compositionFixture() {
  const f=await installedFixture();
  return {...f,pipeline:f.verified.manifest,workspace:f.manifest,snapshot:f.previous.active.snapshot,
    adapters:{codex:providerDouble('codex')},requests:[{path:'AGENTS.md',owner:'shared',kind:'file',bytes:Buffer.from('entry')}],
    observations:[{path:'AGENTS.md',bytes:null}]};
}

async function nativePlanFixture() {
  const f=await installedFixture(),repo=path.join(f.base,'pipeline');
  for(const [name,bytes]of f.files){const filename=path.join(repo,name);await mkdir(path.dirname(filename),{recursive:true});await writeFile(filename,bytes);}
  const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>!/^GIT_/i.test(name)));
  Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'});
  for(const args of [['init','--initial-branch=main','--template='],['add','--all'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture']]) {
    const result=spawnSync('git',['-C',repo,'-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],{env,windowsHide:true,encoding:'utf8'});
    assert.equal(result.status,0,'synthetic Git initialization');
  }
  const adapters={codex:{...providerDouble('codex'),plan:()=>[{path:'.codex/skills/test.md',owner:'codex',kind:'file',bytes:Buffer.from('skill')}]}};
  const sharedAdapter={plan:()=>[{path:'AGENTS.md',owner:'shared',kind:'file',bytes:Buffer.from('entry')}]};
  return {...f,repo,adapters,sharedAdapter,tempRoot:f.base};
}

async function wrapperTree(root) {
  const result={};
  async function walk(relative='') {
    for(const entry of await readdir(path.join(root,relative),{withFileTypes:true})) {
      const name=relative ? relative+'/'+entry.name : entry.name;
      if(entry.isDirectory()){result[name]='directory';await walk(name);}
      else {assert.ok(entry.isFile());result[name]=sha256(await readFile(path.join(root,name)));}
    }
  }
  await walk();return result;
}

test('snapshot rejects extra empty directories including nested extras',async()=>{
  for(const extra of ['extra','resources/extra/deep']) {
    const f=await installedFixture();await verifyInstalledSnapshot(f.previous);
    await mkdir(path.join(f.root,extra),{recursive:true});
    await assert.rejects(()=>verifyInstalledSnapshot(f.previous),e=>e.code==='snapshot.extra-directory');
  }
});
test('fresh missing source reports missing repository while existing binding requires rebind',async()=>{
  const f=await fixture();await rename(path.join(f.base,'pipeline'),path.join(f.base,'gone'));
  await assert.rejects(()=>resolveOrigin({wrapper:f.wrapper,manifestPath:f.manifestPath}),e=>e.code==='source.missing-repository');
  await assert.rejects(()=>resolveOrigin({wrapper:f.wrapper,manifestPath:f.manifestPath,previous:f.previous}),e=>e.code==='source-rebind-required');
});
test('malformed adapter requests and fields fail with stable codes before access',async()=>{
  const f=await compositionFixture();
  const bad=[null,undefined,1,'text',[],{get pointer(){throw Error('getter invoked');}}];
  assert.throws(()=>reconcileFields({},new Array(1)),e=>e.code==='ownership.fields');
  for(const value of bad) {
    assert.throws(()=>reconcileFields({},[value]),e=>e.code==='ownership.fields');
    assert.throws(()=>composePlan({...f,requests:[value]}),e=>e.code==='plan.request');
    assert.throws(()=>composePlan({...f,requests:[{path:'.codex/test.json',owner:'codex',kind:'json-fields',fields:[value]}]}),e=>e.code==='plan.fields');
  }
  for(const requests of [[{...f.requests[0],extra:true}], [{...f.requests[0],fields:[]}],
    [{path:'.codex/test.json',owner:'codex',kind:'json-fields',fields:[{pointer:'/x',present:true,value:1,extra:true}]}]]) {
    assert.throws(()=>composePlan({...f,requests}),e=>['plan.request','plan.fields'].includes(e.code));
  }
});
test('same-origin native update preserves backup lineage and entire wrapper tree',async()=>{
  const f=await nativePlanFixture(),bytes=Buffer.from('old');await writeFile(path.join(f.wrapper,'AGENTS.md'),bytes);
  f.previous.active.owned=[{path:'AGENTS.md',kind:'file',pointer:null,owner:'shared',beforeHash:hash,managedHash:sha256(bytes),backup:'.pipeline/backups/original.bin'}];
  await mkdir(path.join(f.wrapper,'.pipeline/backups'));await writeFile(path.join(f.wrapper,'.pipeline/backups/original.bin'),'historical fixture');
  await writeFile(path.join(f.wrapper,'.pipeline/state.json'),JSON.stringify(f.previous));
  const before=await wrapperTree(f.wrapper),prepared=await preparePlan({...f,manifestPath:undefined});
  assert.equal(prepared.preview.plan.command,'update');assert.equal(prepared.rebind,null);
  const owned=prepared.preview.plan.desired.owned.find(r=>r.path==='AGENTS.md');
  assert.equal(owned.backup,'.pipeline/backups/original.bin');assert.equal(owned.beforeHash,hash);
  assert.deepEqual(await wrapperTree(f.wrapper),before);
});
test('state mutation during adapter execution rejects preparation',async()=>{
  const f=await nativePlanFixture(),filename=path.join(f.wrapper,'.pipeline/state.json');
  await writeFile(filename,JSON.stringify(f.previous));
  f.adapters.codex.plan=async()=>{await writeFile(filename,JSON.stringify(f.previous,null,2));return [];};
  await assert.rejects(()=>preparePlan(f),e=>e.code==='plan.state-drift');
});
test('JSON fields in absent containing file create whole file with no edit-fields operation',async()=>{
  const f=await compositionFixture();f.requests=[{path:'.codex/test.json',owner:'codex',kind:'json-fields',fields:[{pointer:'/x',present:true,value:1}]}];
  f.observations=[{path:'.codex/test.json',bytes:null}];const result=composePlan(f);
  assert.equal(result.plan.targets[0].action,'create');assert.deepEqual(result.plan.targets[0].fields,[]);
  assert.deepEqual(JSON.parse(Buffer.from(result.outputs[0].bytes,'base64')),{x:1});
});
test('adapter validation, missing shared adapter and null native request fail explicitly',async()=>{
  const f=await nativePlanFixture();f.adapters.codex.validate=()=>({valid:false});
  await assert.rejects(()=>preparePlan(f),e=>e.code==='provider.validation');
  await assert.rejects(()=>preparePlan({...f,sharedAdapter:undefined}),e=>e.code==='plan.shared-adapter');
  f.adapters.codex.validate=()=>({valid:true});f.adapters.codex.plan=()=>[null];
  await assert.rejects(()=>preparePlan(f),e=>e.code==='plan.request');
});
test('unsupported origin command and approved wrapper relocation remain blocked',async()=>{
  const f=await fixture();await assert.rejects(()=>resolveOrigin({wrapper:f.wrapper,command:'unknown'}),e=>e.code==='origin.command');
  const options={wrapper:path.join(f.base,'moved-wrapper'),previous:f.previous,manifestPath:f.manifestPath};
  const proposal=await previewRebind(options),approval={decision:'approve',proposalDigest:contractDigest(proposal)};
  await assert.rejects(()=>resolveApprovedRebind({...options,proposal,approval}),e=>e.code==='rebind.workspace-move');
});
test('native preparation joins local Git, verified snapshot, adapters and target observations without writes',async()=>{
  const f=await nativePlanFixture(),before=await wrapperTree(f.wrapper);
  const prepared=await preparePlan(f);
  assert.equal(prepared.preview.plan.targets.length,2);assert.equal(prepared.stateFileHash,null);
  assert.equal(prepared.preview.plan.source.origin.path,f.manifestPath);
  assert.deepEqual(await wrapperTree(f.wrapper),before);
  assert.deepEqual(await observeTargets(f.wrapper,['AGENTS.md','.codex/skills/test.md']),[{path:'.codex/skills/test.md',bytes:null},{path:'AGENTS.md',bytes:null}]);
  assert.deepEqual(prepared.preview,(await preparePlan(f)).preview);
});
test('preparation rejects invalid adapter owner before reading target and manifest changes before return',async()=>{
  const f=await nativePlanFixture();
  f.adapters.codex.plan=()=>[{path:'AGENTS.md',owner:'shared',kind:'file',bytes:Buffer.from('x')}];
  await assert.rejects(()=>preparePlan(f),e=>e.code==='plan.adapter-owner');
  f.adapters.codex.plan=async()=>{await writeFile(f.manifestPath,JSON.stringify(f.manifest,null,2));return [];};
  await assert.rejects(()=>preparePlan(f),e=>e.code==='plan.origin-drift');
});
test('rebind approval binds exact manifest and state, never upgrades proposal to apply approval',async()=>{
  const f=await fixture(),manifestPath=path.join(f.wrapper,'new.json');f.manifest.pipeline.path='../pipeline';
  await writeFile(manifestPath,JSON.stringify(f.manifest));
  const options={wrapper:f.wrapper,previous:f.previous,manifestPath};
  const proposal=await previewRebind(options),approval={decision:'approve',proposalDigest:contractDigest(proposal)};
  await assert.rejects(()=>resolveApprovedRebind({...options,proposal}),e=>e.code==='rebind.approval');
  const granted=await resolveApprovedRebind({...options,proposal,approval});
  assert.equal(granted.origin.path,manifestPath);assert.equal(granted.rebind.proposal.sourceAccessAuthorized,false);
  await writeFile(manifestPath,JSON.stringify(f.manifest,null,2));
  await assert.rejects(()=>resolveApprovedRebind({...options,proposal,approval}),e=>e.code==='rebind.drift');
});
test('native rebind grant is carried into exact preview, absent approval stops before acquisition',async()=>{
  const f=await nativePlanFixture(),statePath=path.join(f.wrapper,'.pipeline/state.json');
  await writeFile(statePath,JSON.stringify(f.previous));
  const manifestPath=path.join(f.wrapper,'new.json');const moved=structuredClone(f.manifest);moved.pipeline.path='../pipeline';await writeFile(manifestPath,JSON.stringify(moved));
  const proposal=await previewRebind({wrapper:f.wrapper,previous:f.previous,manifestPath});
  const before=await readdir(f.base);
  await assert.rejects(()=>preparePlan({...f,manifestPath,rebind:{proposal}}),e=>e.code==='rebind.approval');
  assert.deepEqual(await readdir(f.base),before);
  const approval={decision:'approve',proposalDigest:contractDigest(proposal)};
  const prepared=await preparePlan({...f,manifestPath,rebind:{proposal,approval}});
  assert.deepEqual(prepared.rebind.approval,approval);assert.equal(prepared.preview.plan.source.origin.path,manifestPath);
});
test('target observations reject file aliases/hardlinks and preparation inside wrapper',async()=>{
  const f=await fixture();await writeFile(path.join(f.wrapper,'AGENTS.md'),'entry');
  await assert.rejects(()=>observeTargets(f.wrapper,['agents.md']),e=>e.code==='layout.case-alias');
  await link(path.join(f.wrapper,'AGENTS.md'),path.join(f.base,'alias'));
  await assert.rejects(()=>observeTargets(f.wrapper,['AGENTS.md']),e=>e.code==='target.type');
  await assert.rejects(()=>preparePlan({...f,tempRoot:f.wrapper}),e=>e.code==='plan.preparation-location');
});
test('composition builds schema-valid deterministic plan and owns only managed values',async()=>{
  const f=await compositionFixture(),before=JSON.stringify(f.previous);
  const first=composePlan(f);assert.deepEqual(first,composePlan(f));assert.equal(JSON.stringify(f.previous),before);
  assert.equal(first.plan.desired.owned[0].managedHash,sha256(Buffer.from('entry')));
  assert.deepEqual(checkPreview(first,f.previous,f.observations),first);
  f.observations[0].bytes=Buffer.from('entry');
  const equal=composePlan(f);assert.equal(equal.plan.targets.length,0);assert.equal(equal.plan.desired.owned.length,0);
});
test('composition rejects repository, foreign-provider and internal metadata destinations',async()=>{
  const f=await compositionFixture();
  for(const name of ['project/AGENTS.md','.pipeline/state.json','.claude/settings.json','AGENTS.md/child']) {
    f.requests=[{path:name,owner:'codex',kind:'file',bytes:Buffer.from('x')}];f.observations=[{path:name,bytes:null}];
    assert.throws(()=>composePlan(f));
  }
});
test('composition preserves backup lineage and fails on owned drift or omitted ownership',async()=>{
  const f=await compositionFixture(),old=Buffer.from('old');f.observations[0].bytes=old;
  f.previous.active.owned=[{path:'AGENTS.md',kind:'file',pointer:null,owner:'shared',beforeHash:hash,managedHash:sha256(old),backup:'.pipeline/backups/original.bin'}];
  const updated=composePlan(f);assert.equal(updated.plan.desired.owned[0].backup,'.pipeline/backups/original.bin');
  assert.equal(updated.plan.desired.owned[0].beforeHash,hash);
  f.requests=[];assert.throws(()=>composePlan(f),e=>e.code==='plan.ownership-coverage');
  f.requests=[{path:'AGENTS.md',owner:'shared',kind:'file',bytes:Buffer.from('entry')}];f.observations[0].bytes=Buffer.from('user edit');
  assert.throws(()=>composePlan(f),e=>e.code==='ownership.drift');
});
test('composition of JSON fields keeps foreign data and requires exact takeover',async()=>{
  const f=await compositionFixture();f.requests=[{path:'.codex/test.json',owner:'codex',kind:'json-fields',fields:[{pointer:'/managed',present:true,value:true}]}];
  f.observations=[{path:'.codex/test.json',bytes:Buffer.from('{"foreign":42}')}];
  const plan=composePlan(f);assert.equal(plan.plan.targets[0].action,'edit-fields');
  assert.deepEqual(JSON.parse(Buffer.from(plan.outputs[0].bytes,'base64')), {foreign:42,managed:true});
  assert.equal(plan.plan.desired.owned[0].pointer,'/managed');
  f.observations[0].bytes=Buffer.from('{"managed":false,"foreign":42}');
  assert.throws(()=>composePlan(f),e=>e.code==='ownership.foreign');
  f.requests[0].fields[0].takeover={beforeHash:contractDigest(false),desiredHash:contractDigest(true)};
  assert.match(composePlan(f).plan.desired.owned[0].backup,/^\.pipeline\/backups\//);
});
test('composition rejects overlapping targets and incomplete field coverage',async()=>{
  const f=await compositionFixture();f.requests=[{path:'.codex/a',owner:'codex',kind:'file',bytes:Buffer.from('x')},{path:'.codex/a/b',owner:'codex',kind:'file',bytes:Buffer.from('x')}];
  f.observations=f.requests.map(r=>({path:r.path,bytes:null}));assert.throws(()=>composePlan(f),e=>e.code==='plan.overlap');
  f.previous.active.owned=[{path:'.codex/test.json',kind:'field',pointer:'/old',owner:'codex',beforeHash:null,managedHash:hash,backup:null}];
  f.requests=[{path:'.codex/test.json',owner:'codex',kind:'json-fields',fields:[{pointer:'/new',present:true,value:1}]}];f.observations=[{path:'.codex/test.json',bytes:Buffer.from('{}')}];
  assert.throws(()=>composePlan(f),e=>e.code==='plan.ownership-coverage');
});
test('preview binds exact output and unchanged observations, detached and order-independent',async()=>{
  const f=await previewFixture(),first=bindPreview(f.plan,f.previous,f);
  assert.deepEqual(first,bindPreview(f.plan,f.previous,{...f,observations:[...f.observations].reverse()}));
  assert.deepEqual(checkPreview(first,f.previous,f.observations),first);
  f.outputs[0].bytes[0]=0;assert.equal(Buffer.from(first.outputs[0].bytes,'base64').toString(),'new instructions');
});
test('preview rejects omitted, changed or additional fresh dependency and state drift',async()=>{
  const f=await previewFixture(),envelope=bindPreview(f.plan,f.previous,f);
  for(const observations of [f.observations.slice(0,1),[...f.observations,{path:'extra',bytes:null}],
    [f.observations[0],{...f.observations[1],bytes:Buffer.from('changed')}]] ) {
    assert.throws(()=>checkPreview(envelope,f.previous,observations),e=>e.code==='preview.drift');
  }
  const previous=structuredClone(f.previous);previous.active.id='other';
  assert.throws(()=>checkPreview(envelope,previous,f.observations));
});
test('preview rejects output mismatch, extra payload, duplicate path and missing target observation',async()=>{
  const f=await previewFixture();
  for(const outputs of [[{path:'AGENTS.md',bytes:Buffer.from('wrong')}],[...f.outputs,{path:'extra',bytes:Buffer.from('x')}]] ) {
    assert.throws(()=>bindPreview(f.plan,f.previous,{...f,outputs}),e=>e.code==='preview.output');
  }
  assert.throws(()=>bindPreview(f.plan,f.previous,{...f,observations:f.observations.slice(1)}),e=>e.code==='preview.before');
  assert.throws(()=>bindPreview(f.plan,f.previous,{...f,observations:[...f.observations,{path:'agents.md',bytes:null}]}),e=>e.code==='preview.duplicate');
});
test('preview verifies stored envelope instead of trusting claimed hashes',async()=>{
  const f=await previewFixture();
  for(const mutate of [e=>{e.digest=hash;},e=>{e.outputs[0].bytes='AAAA';},e=>{e.extra=true;},e=>{e.outputs[0].hash=hash;}]) {
    const envelope=bindPreview(f.plan,f.previous,f);mutate(envelope);
    assert.throws(()=>checkPreview(envelope,f.previous,f.observations));
  }
});

test('installed snapshot verifies actual bytes without original source, returning detached data',async()=>{
  const f=await installedFixture();await rename(f.manifestPath,f.manifestPath+'.old');await rename(path.join(f.base,'pipeline'),path.join(f.base,'gone'));
  const actual=await verifyInstalledSnapshot(f.previous);
  assert.equal(actual.digest,f.verified.digest);assert.deepEqual(actual.fileHashes,f.verified.fileHashes);
  actual.snapshot.commit='b'.repeat(40);assert.equal(f.previous.active.snapshot.commit,'a'.repeat(40));
  actual.files.get('resources/process.md')[0]=0;
  assert.equal((await verifyInstalledSnapshot(f.previous)).digest,f.verified.digest);
});
test('snapshot modified, extra, missing and rehashed counterfeit bytes rejected',async()=>{
  for(const mode of ['modified','extra','missing','counterfeit']) {
    const f=await installedFixture(),subject=path.join(f.root,'resources/process.md');
    if(mode==='extra')await writeFile(path.join(f.root,'extra.md'),'x');
    else if(mode==='missing')await rename(subject,path.join(f.base,'outside.md'));
    else await writeFile(subject,'different');
    if(mode==='counterfeit') {
      const inventory=JSON.parse(f.files.get('inventory.json').toString());inventory['resources/process.md']=sha256(Buffer.from('different'));
      await writeFile(path.join(f.root,'inventory.json'),JSON.stringify(inventory));
    }
    await assert.rejects(()=>verifyInstalledSnapshot(f.previous),e=>e.code===(mode==='modified'?'inventory.hash':mode==='counterfeit'?'snapshot.binding':'inventory.files'));
  }
});
test('snapshot identity mismatch, missing snapshot and pending state fail',async()=>{
  const f=await installedFixture();f.previous.active.version='2.0.0';
  await assert.rejects(()=>verifyInstalledSnapshot(f.previous),e=>e.code==='snapshot.binding');
  f.previous.active.version='1.0.0';await rename(f.root,f.root+'-moved');
  await assert.rejects(()=>verifyInstalledSnapshot(f.previous),e=>e.code==='snapshot.missing');
  f.previous.pending=hash;f.previous.status='needs-reconciliation';
  await assert.rejects(()=>verifyInstalledSnapshot(f.previous),e=>e.code==='snapshot.state');
});
test('snapshot refuses hardlinked files and directory junctions',async()=>{
  const f=await installedFixture();await link(path.join(f.root,'resources/process.md'),path.join(f.base,'hardlink.md'));
  await assert.rejects(()=>verifyInstalledSnapshot(f.previous),e=>e.code==='snapshot.type');
  const g=await installedFixture();await symlink(g.base,path.join(g.root,'junction'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(()=>verifyInstalledSnapshot(g.previous),e=>e.code==='snapshot.link');
});
test('manifest in repo binds original parent, update does not resolve relative to cwd',async()=>{
  const f=await fixture();assert.equal(f.resolved.origin.base,path.join(f.wrapper,'project'));
  assert.equal(f.resolved.origin.resolvedSource,path.join(f.base,'pipeline'));
  assert.equal(f.resolved.origin.digest,sha256(Buffer.from(JSON.stringify(f.manifest))));
  assert.deepEqual(await resolveOrigin({wrapper:f.wrapper,previous:f.previous,command:'update'}),f.resolved);
});
test('default manifest lives in wrapper and uses that parent',async()=>{
  const f=await fixture();f.manifest.pipeline.path='../pipeline';
  await writeFile(path.join(f.wrapper,'workspace.yaml'),JSON.stringify(f.manifest));
  const r=await resolveOrigin({wrapper:f.wrapper});assert.equal(r.origin.base,f.wrapper);assert.equal(r.origin.resolvedSource,path.join(f.base,'pipeline'));
});
test('copied manifest cannot silently become original; explicit rebind is non-authorizing',async()=>{
  const f=await fixture(),copy=path.join(f.wrapper,'copy.json');f.manifest.pipeline.path='../pipeline';await writeFile(copy,JSON.stringify(f.manifest));
  const before=JSON.stringify(f.previous);
  await assert.rejects(()=>resolveOrigin({wrapper:f.wrapper,previous:f.previous,manifestPath:copy,command:'update'}),e=>e.code==='source-rebind-required');
  const p=await previewRebind({wrapper:f.wrapper,previous:f.previous,manifestPath:copy});
  assert.equal(p.beforeStateHash,contractDigest(f.previous));assert.equal(p.requiresApproval,true);assert.equal(p.sourceAccessAuthorized,false);
  assert.equal(JSON.stringify(f.previous),before);
});
test('changed wrapper refuses before missing-manifest read',async()=>{
  const f=await fixture();f.previous.active.snapshot.origin.path=path.join(f.base,'absent.json');
  await assert.rejects(()=>resolveOrigin({wrapper:path.join(f.base,'moved'),previous:f.previous,command:'update'}),e=>e.code==='source-rebind-required');
});
test('missing original or moved source causes rebind conflict; repair reads neither',async()=>{
  const f=await fixture();await rename(f.manifestPath,f.manifestPath+'.moved');await rename(path.join(f.base,'pipeline'),path.join(f.base,'elsewhere'));
  await assert.rejects(()=>resolveOrigin({wrapper:f.wrapper,previous:f.previous,command:'update'}),e=>e.code==='source-rebind-required');
  const r=await resolveOrigin({wrapper:f.wrapper,previous:f.previous,command:'repair'});assert.deepEqual(r.snapshot,f.previous.active.snapshot);
  r.snapshot.commit='b'.repeat(40);assert.equal(f.previous.active.snapshot.commit,'a'.repeat(40));
});
test('same manifest changed source location refused, ordinary content refresh binds new bytes',async()=>{
  const f=await fixture();f.manifest.providers=['codex','claude'];await writeFile(f.manifestPath,JSON.stringify(f.manifest));
  const r=await resolveOrigin({wrapper:f.wrapper,previous:f.previous,command:'update'});assert.notEqual(r.origin.digest,f.resolved.origin.digest);
  await mkdir(path.join(f.base,'other'));f.manifest.pipeline.path='../../other';await writeFile(f.manifestPath,JSON.stringify(f.manifest));
  await assert.rejects(()=>resolveOrigin({wrapper:f.wrapper,previous:f.previous,command:'update'}),e=>e.code==='source-rebind-required');
});
test('state read validates bytes plus semantic digest and creates nothing',async()=>{
  const f=await fixture(),filename=path.join(f.base,'state.json');await writeFile(filename,JSON.stringify(f.previous));const before=await readdir(f.base);
  const r=await readState(filename);assert.equal(r.stateDigest,contractDigest(f.previous));assert.equal(r.digest,sha256(Buffer.from(JSON.stringify(f.previous))));assert.deepEqual(await readdir(f.base),before);
});
test('duplicate manifest keys, oversized records and missing files fail safely',async()=>{
  const f=await fixture();await writeFile(f.manifestPath,'{"x":1,"x":2}');await assert.rejects(()=>readRecord(f.manifestPath));
  await writeFile(f.manifestPath,' '.repeat(2*1024*1024+1));await assert.rejects(()=>readRecord(f.manifestPath),e=>e.code==='parse.size');
  await assert.rejects(()=>readRecord(path.join(f.base,'private-missing')),e=>e.code==='record.missing'&&!e.message.includes('private'));
});
test('pending operations block source work and repair',async()=>{
  const f=await fixture();f.previous.status='needs-reconciliation';f.previous.pending=hash;
  for(const command of ['update','repair'])await assert.rejects(()=>resolveOrigin({wrapper:f.wrapper,previous:f.previous,command}),e=>e.code==='state.pending');
});
