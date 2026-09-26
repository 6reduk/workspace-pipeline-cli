import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {applyDesiredFiles} from '../src/desired-state/apply-files.js';

async function fixture(t) {
  const workspace=await mkdtemp(path.join(os.tmpdir(),'wpc-legacy-state-'));
  t.after(()=>rm(workspace,{recursive:true,force:true}));await mkdir(path.join(workspace,'.pipeline'));
  const hash='sha256:'+'a'.repeat(64);
  const state={schemaVersion:1,workspace,status:'ready',runtime:'not-run',pending:null,active:{id:'old-install',pipelineId:'example',version:'1.0.0',
    providers:['codex'],adapterVersions:{codex:'test-1'},
    layout:{kind:'single-repo',repositories:{game:{path:'project',role:'code'}},documentation:{repository:'game',path:'docs'}},
    snapshot:{source:{type:'git',transport:'local',path:'../source',ref:'main',subdirectory:'.'},commit:'a'.repeat(40),
      path:'.pipeline/snapshots/a',digest:hash,inventoryDigest:hash,origin:{path:path.join(workspace,'workspace.json'),base:workspace,digest:hash,resolvedSource:path.join(workspace,'source')}},
    owned:[{path:'AGENTS.md',kind:'file',pointer:null,owner:'shared',beforeHash:null,managedHash:hash,backup:null}]}};
  const bytes=Buffer.from(JSON.stringify(state));await writeFile(path.join(workspace,'.pipeline/state.json'),bytes);
  await writeFile(path.join(workspace,'AGENTS.md'),'customized old');
  const manifest=JSON.stringify({schemaVersion:2,id:'example',version:'2.0.0',adapters:{codex:{providers:['codex'],settings:[],files:[{source:'entry.md',target:'AGENTS.md',kind:'file'}]}}});
  return {state,bytes,input:{workspace,manifest,selected:['codex'],protectedPaths:['project'],source:new Map([['entry.md',Buffer.from('new')]])}};
}
test('explicit migration replaces customized old file and preserves only historical record',async t=>{
  const {input,bytes}=await fixture(t);
  await assert.rejects(applyDesiredFiles(input),e=>e.code==='desired.legacy-migration-required');
  await applyDesiredFiles(input,{migrateLegacy:true});
  assert.equal(await readFile(path.join(input.workspace,'AGENTS.md'),'utf8'),'new');
  await assert.rejects(readFile(path.join(input.workspace,'.pipeline/state.json')),{code:'ENOENT'});
  const history=path.join(input.workspace,'.pipeline/history'),names=await readdir(history);
  assert.equal(names.length,1);assert.deepEqual(await readFile(path.join(history,names[0])),bytes);
  await assert.rejects(readFile(path.join(input.workspace,'.pipeline/backups')),{code:'ENOENT'});
  assert.equal((await applyDesiredFiles(input)).status,'unchanged');
});
test('unfinished old operation blocks migration without replacing contents',async t=>{
  const {input,state}=await fixture(t);state.status='needs-reconciliation';state.pending='sha256:'+'b'.repeat(64);
  await writeFile(path.join(input.workspace,'.pipeline/state.json'),JSON.stringify(state));
  await assert.rejects(applyDesiredFiles(input,{migrateLegacy:true}),e=>e.code==='desired.legacy-unfinished');
  assert.equal(await readFile(path.join(input.workspace,'AGENTS.md'),'utf8'),'customized old');
});
test('migrated old scope cannot include project even with valid state schema',async t=>{
  const {input,state}=await fixture(t);state.active.owned[0].path='project/game.cs';
  await writeFile(path.join(input.workspace,'.pipeline/state.json'),JSON.stringify(state));
  await assert.rejects(applyDesiredFiles(input,{migrateLegacy:true}),e=>e.code==='desired.scope');
  assert.equal(await readFile(path.join(input.workspace,'AGENTS.md'),'utf8'),'customized old');
});
test('migration retry after content change still preserves exact original metadata',async t=>{
  const {input,bytes}=await fixture(t);
  await assert.rejects(applyDesiredFiles(input,{migrateLegacy:true,boundary:async event=>{if(event==='before-record')throw Error('stop');}}));
  await applyDesiredFiles(input,{migrateLegacy:true});
  const history=path.join(input.workspace,'.pipeline/history'),names=await readdir(history);
  assert.deepEqual(await readFile(path.join(history,names[0])),bytes);
});
test('new descriptor cannot drop protection of an old repository during migration',async t=>{
  const {input}=await fixture(t);
  const declaration=JSON.parse(input.manifest);declaration.adapters.codex.files[0].target='project/game.cs';
  await assert.rejects(applyDesiredFiles({...input,manifest:JSON.stringify(declaration),protectedPaths:['renamed-project']},{migrateLegacy:true}),
    e=>e.code==='desired.scope');
});
