import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, readdir, symlink } from 'node:fs/promises';
import { planLayout, resolveLayout } from '../src/workspace/resolve.js';
import { selectProfile } from '../src/workspace/profiles.js';
import { RESERVED, assertUnreserved } from '../src/workspace/reserved.js';
import { pathBudget, inspectDirectory } from '../src/workspace/paths.js';

const source = { type:'git',transport:'local',path:'pipeline',ref:'HEAD',subdirectory:'.' };
const decl = { skills:'skills',agents:null,mcp:null,entryInstructions:null,requires:[] };
const pipeline = {schemaVersion:1,id:'example',version:'1.0.0',resources:'resources',inventory:'inventory.json',
  providers:{codex:decl,claude:decl,kimi:decl,grok:decl},agentsDocument:{mode:'default'}};
const layout = {kind:'single-repo',repositories:{game:{path:'project',role:'code'}},
  documentation:{repository:'game',path:'docs'},projectRoots:{unity:{repository:'game',path:'Game'}}};
const workspace = {schemaVersion:1,pipeline:source,providers:['codex','claude','kimi','grok'],layout};
const root = path.join(tmpdir(),'planned-wrapper');
const fresh = () => structuredClone(workspace);
const bad = (fn,code) => assert.throws(fn,e=>code ? e.code===code : Boolean(e.code));

test('single repo nested Unity and docs resolve relative to wrapper without mutation',()=>{
  const before=JSON.stringify([pipeline,workspace]);
  const r=planLayout(pipeline,workspace,root);
  assert.equal(r.repositories.game.path,path.join(root,'project'));
  assert.equal(r.documentation.path,path.join(root,'project/docs'));
  assert.equal(r.projectRoots.unity.path,path.join(root,'project/Game'));
  assert.equal(r.filesystem,'not-inspected');assert.equal(r.runtime,'not-run');
  r.layout.repositories.game.path='changed';assert.equal(JSON.stringify([pipeline,workspace]),before);
});
test('profile uses passed snapshot manifest, no defaults merge or alias',()=>{
  const p=structuredClone(pipeline);p.workspaceProfiles={unity:structuredClone(layout)};
  const w={...fresh(),profile:'unity'};delete w.layout;
  assert.deepEqual(selectProfile(p,w).layout,layout);
  const selected=selectProfile(p,w);p.workspaceProfiles.unity.repositories.game.path='other';
  assert.equal(selected.layout.repositories.game.path,'project');
  bad(()=>planLayout(p,{...w,layout},root),'schema.invalid');
  bad(()=>planLayout(p,{...w,profile:'missing'},root),'layout.profile');
});
test('multi repo role is advisory, explicit documentation route wins',()=>{
  const w=fresh();w.layout={kind:'multi-repo',repositories:{
    api:{path:'services/api',role:'code'},docs:{path:'knowledge',role:'library'},
    old:{path:'old-docs',role:'documentation'}},documentation:{repository:'docs',path:'.'}};
  const r=planLayout(pipeline,w,root);
  assert.equal(r.documentation.path,path.join(root,'knowledge'));
  assert.deepEqual(r.warnings,[{code:'layout.unused-documentation-role',repository:'old'}]);
});
for(const field of ['documentation','projectRoots'])test('missing repository reference '+field,()=>{
  const w=fresh();if(field==='documentation')w.layout.documentation.repository='absent';else w.layout.projectRoots.unity.repository='absent';
  bad(()=>planLayout(pipeline,w,root),'layout.repository');
});
test('single and multi repository cardinality checked by schema',()=>{
  const w=fresh();w.layout.kind='multi-repo';bad(()=>planLayout(pipeline,w,root),'schema.invalid');
  w.layout.kind='single-repo';w.layout.repositories.extra={path:'extra',role:'code'};bad(()=>planLayout(pipeline,w,root),'schema.invalid');
});
test('planned docs/project directory spellings cannot alias',()=>{
  const w=fresh();w.layout.documentation.path='Game/docs';w.layout.projectRoots.unity.path='game';
  bad(()=>planLayout(pipeline,w,root),'layout.case-alias');
});
for(const pair of [['repo','repo/sub'],['repo/sub','repo'],['same','same'],['Same','same'],['Tools/a','tools/b']])test('conflicting repository paths '+pair,()=>{
  const w=fresh();w.layout.kind='multi-repo';w.layout.repositories.game.path=pair[0];w.layout.repositories.other={path:pair[1],role:'code'};
  bad(()=>planLayout(pipeline,w,root));
});
for(const name of RESERVED)test('reserved wrapper root '+name,()=>{
  bad(()=>assertUnreserved(name.toUpperCase()),'layout.reserved');
  bad(()=>assertUnreserved(name+'/child'),'layout.reserved');
  const w=fresh();w.layout.repositories.game.path=name;bad(()=>planLayout(pipeline,w,root));
});
test('managed paths reject both containment directions; inner reserved basename is not wrapper root',()=>{
  for(const target of ['project','project/sub'])bad(()=>planLayout(pipeline,workspace,root,{managedPaths:[target]}),'layout.overlap');
  const w=fresh();w.layout.repositories.game.path='repos/game';
  bad(()=>planLayout(pipeline,w,root,{managedPaths:['repos']}),'layout.overlap');
  w.layout.repositories.game.path='project/AGENTS.md';assert.ok(planLayout(pipeline,w,root));
});
for(const name of ['../escape','CON','nul.txt','com1','repo.','repo ','repo:ads','PROGRA~1','bad\nname','a//b','a/./b'])test('hostile destination '+JSON.stringify(name),()=>{
  const w=fresh();w.layout.repositories.game.path=name;bad(()=>planLayout(pipeline,w,root));
});
test('absolute root required; Unicode wrapper and internal ASCII spaces supported',()=>{
  bad(()=>planLayout(pipeline,workspace,'relative'),'layout.absolute-root');
  const w=fresh();w.layout.repositories.game.path='my project';
  assert.equal(planLayout(pipeline,w,path.join(tmpdir(),'Проект')).repositories.game.relative,'my project');
});
test('both platform path budgets at and over; joined docs path bounded',()=>{
  pathBudget('a'.repeat(240),'win32');bad(()=>pathBudget('a'.repeat(241),'win32'),'layout.path-length');
  pathBudget('я'.repeat(512),'linux');bad(()=>pathBudget('я'.repeat(513),'linux'),'layout.path-length');
  const w=fresh();w.layout.repositories.game.path=Array(20).fill('aaaaaaaaa').join('/');w.layout.documentation.path='b'.repeat(60);
  bad(()=>planLayout(pipeline,w,root));
});
test('read-only filesystem observations allow planned missing roots',async()=>{
  const base=await mkdtemp(path.join(tmpdir(),'wpc-s3-'));
  const r=await resolveLayout(pipeline,workspace,path.join(base,'new'));
  assert.equal(r.observations[r.wrapper].exists,false);assert.deepEqual(await readdir(base),[]);
});
test('existing directories and file-as-parent handling',async()=>{
  const base=await mkdtemp(path.join(tmpdir(),'wpc-s3-'));
  await mkdir(path.join(base,'project/docs'),{recursive:true});await mkdir(path.join(base,'project/Game'));
  const r=await resolveLayout(pipeline,workspace,base);assert.ok(Object.values(r.observations).every(o=>o.exists));
  await writeFile(path.join(base,'file'),'owned by user');
  await assert.rejects(()=>inspectDirectory(path.join(base,'file/sub')),e=>e.code==='layout.not-directory');
});
test('existing case alias and junction escape rejected, no traversal to target',async()=>{
  const base=await mkdtemp(path.join(tmpdir(),'wpc-s3-')),outside=await mkdtemp(path.join(tmpdir(),'wpc-s3-outside-'));
  await mkdir(path.join(base,'Project'));
  await assert.rejects(()=>resolveLayout(pipeline,workspace,base),e=>e.code==='layout.case-alias');
  await symlink(outside,path.join(base,'linked'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(()=>inspectDirectory(path.join(base,'linked/new')),e=>e.code==='layout.link');
  assert.deepEqual(await readdir(outside),[]);
});
