import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBundle } from '../src/contracts/semantic.js';
import { resolveProviders, installedSelection } from '../src/providers/bundles.js';
import { selectBundleRemoval } from '../src/operations/remove.js';
import { parseCommand } from '../src/commands/dispatch.js';
import { sharedAdapter } from '../src/providers/shared.js';
import { retiredBundleOwnership, restoreRetired } from '../src/operations/bundle-update.js';
import { sha256 } from '../src/source/inventory.js';

const decl={skills:'skills',agents:null,mcp:null,entryInstructions:null,requires:[]};
function fixture(members=['claude','grok']) {
  const bundle={providers:members,entry:{source:'instructions/CLAUDE.md',target:'CLAUDE.md'}};
  const pipeline={schemaVersion:1,id:'sample',version:'1.0.0',resources:'resources',inventory:'inventory.json',
    agentsDocument:{mode:'default'},providers:{codex:decl,...Object.fromEntries(members.map(id=>[id,decl]))},bundles:{pair:bundle}};
  const workspace={schemaVersion:1,pipeline:{type:'git',transport:'local',path:'../source',ref:'main',subdirectory:'.'},
    bundles:['pair'],layout:{kind:'single-repo',repositories:{game:{path:'project',role:'code'}},documentation:{repository:'game',path:'docs'}}};
  return {pipeline,workspace,bundle};
}
test('bundles resolve exact source membership, including either half, without synthesizing a provider',()=>{
  for(const members of [['claude'],['grok'],['claude','grok']]) {
    const f=fixture(members),before=JSON.stringify(f);
    const selected=validateBundle(f.pipeline,f.workspace);
    assert.deepEqual(selected.providers,members);assert.deepEqual(selected.bundles,{pair:f.bundle});
    assert.equal(JSON.stringify(f),before);
    assert.deepEqual(installedSelection(selected),{providers:[],bundles:['pair']});
  }
});
test('empty selection, unknown or nested bundle, duplicate member, unsafe destination and absent declaration fail',()=>{
  for(const change of [f=>f.bundle.providers=[],f=>f.bundle.providers=['claude','claude'],
    f=>f.bundle.providers=['pair'],f=>f.bundle.entry.target='.claude/settings.json',
    f=>f.bundle.entry.source='../outside',f=>delete f.pipeline.providers.grok,
    f=>f.workspace.bundles=['missing'],f=>{delete f.workspace.bundles;f.workspace.providers=[];},
    f=>f.workspace.providers=['claude'],f=>f.pipeline.bundles.extra=f.bundle]) {
    const f=fixture();change(f);assert.throws(()=>validateBundle(f.pipeline,f.workspace));
  }
});
test('unbundled sources keep standalone behavior and bundle members require explicit selection',()=>{
  const f=fixture();f.workspace.providers=['codex'];
  assert.deepEqual(resolveProviders(f.pipeline,f.workspace).providers,['claude','codex','grok']);
  delete f.workspace.bundles;f.workspace.providers=['claude'];
  assert.throws(()=>validateBundle(f.pipeline,f.workspace),e=>e.code==='bundle.select-bundle');
  delete f.pipeline.bundles;
  assert.deepEqual(validateBundle(f.pipeline,f.workspace).providers,['claude']);
});
test('remove selects the bundle atomically and rejects member-only deletion',()=>{
  const f=fixture(),active={providers:['claude','codex','grok'],bundles:{pair:f.bundle}};
  assert.deepEqual(selectBundleRemoval(active,{bundles:['pair']}).remaining,['codex']);
  assert.deepEqual(selectBundleRemoval(active).providers,['claude','codex','grok']);
  for(const options of [{providers:['claude']},{providers:['grok']},{providers:['claude','grok']},
    {bundles:['missing']},{bundles:['pair','pair']},{providers:[],bundles:[]}])assert.throws(()=>selectBundleRemoval(active,options));
});
test('CLI bundle selection is remove-preview only',()=>{
  const cwd=process.cwd();
  assert.deepEqual(parseCommand(['remove','--workspace',cwd,'--bundles','pair']).bundles,['pair']);
  for(const args of [['repair','--workspace',cwd,'--bundles','pair'],
    ['remove','--workspace',cwd,'--bundles','pair','--apply','--preview',cwd],
    ['remove','--workspace',cwd,'--bundles','pair,pair']])assert.throws(()=>parseCommand(args));
});
test('bundle full entry uses source body and wrapper substitutions, not a neutral stub or second Grok entry',async()=>{
  const f=fixture(['grok']),digest='sha256:'+'a'.repeat(64);
  const context={...f,snapshot:{digest,path:'.pipeline/snapshots/'+digest.slice(7)},
    files:new Map([['resources/process.md',Buffer.from('rules')],['instructions/CLAUDE.md',Buffer.from('# Full pipeline\nDocs: {{documentation}}\nFor Grok use its own tools.\n')]]),
    layout:{...validateBundle(f.pipeline,f.workspace),repositories:{game:{relative:'project',role:'code'}},
      documentation:{relative:'project/docs'},projectRoots:{}}};
  const requests=await sharedAdapter.plan(context);
  assert.equal(requests.find(r=>r.path==='CLAUDE.md').bytes.toString(),'# Full pipeline\nDocs: project/docs\nFor Grok use its own tools.\n');
  assert.ok(!requests.some(r=>r.path==='GROK.md'));
});
test('bundle retirement restores exact original files and refuses user drift',()=>{
  const original=Buffer.from('original'),managed=Buffer.from('managed');
  const record={owner:'grok',path:'.grok/skills/a/SKILL.md',kind:'file',pointer:null,
    beforeHash:sha256(original),managedHash:sha256(managed),backup:'.pipeline/backups/a.bin'};
  const previous={active:{bundles:{pair:{providers:['claude','grok']}},owned:[record]}};
  const selected={providers:['claude'],bundles:{pair:{providers:['claude']}}};
  assert.deepEqual(retiredBundleOwnership(previous,selected),[record]);
  assert.deepEqual(retiredBundleOwnership(previous,{providers:['claude']}),[]);
  const observed=new Map([[record.path,managed],[record.backup,original]]);
  assert.deepEqual(restoreRetired([record],observed)[0].bytes,original);
  observed.set(record.path,Buffer.from('user edit'));
  assert.throws(()=>restoreRetired([record],observed),e=>e.code==='ownership.drift');
});
