import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { providerRegistry } from '../src/providers/registry.js';
import { sharedAdapter } from '../src/providers/shared.js';
import { claudeAdapter } from '../src/providers/native.js';
import { commonEntryText, removedWithProviders } from '../src/providers/common-entry.js';
import { sha256 } from '../src/source/inventory.js';
import { prepareLifecycle, applyLifecycle } from '../src/operations/lifecycle.js';
import { inspectRepair, prepareRepairPlan } from '../src/operations/repair.js';
import { prepareRemoval, selectRemovalProviders } from '../src/operations/remove.js';
import { applyRepair, applyRemoval, applyPrepared, applyContinuation } from '../src/operations/apply.js';
import { prepareContinuation } from '../src/operations/reconciliation.js';
import { acquireWorkspaceLock } from '../src/operations/lock.js';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'wpc-common-entry-'));
  const wrapper = path.join(root, 'wrapper'), source = path.join(root, 'source');
  await mkdir(wrapper); await mkdir(source);
  const declaration = { skills: null, agents: null, mcp: null, entryInstructions: 'entry.md', requires: [] };
  const pipeline = { schemaVersion: 1, id: 'sample', version: '1.0.0', resources: 'resources',
    inventory: 'inventory.json', agentsDocument: { mode: 'default' },
    providers: Object.fromEntries(['codex', 'claude', 'grok'].map(id => [id, declaration])) };
  const files = { 'pipeline.json': JSON.stringify(pipeline), 'entry.md': 'Use your own provider instructions.',
    'resources/process.md': 'No approval is implied.' };
  for (const [name, bytes] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(source, name)), { recursive: true });
    await writeFile(path.join(source, name), bytes);
  }
  await writeFile(path.join(source, 'inventory.json'), JSON.stringify(Object.fromEntries(
    Object.entries(files).map(([name, bytes]) => [name, sha256(Buffer.from(bytes))]))));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
  for (const args of [['init', '--initial-branch=main', '--template='], ['add', '--all'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']]) {
    const r = spawnSync('git', ['-C', source, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
      { env, encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
  }
  const manifestPath = path.join(wrapper, 'workspace.json');
  async function manifest(providers) {
    await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1,
      pipeline: { type: 'git', transport: 'local', path: '../source', ref: 'main', subdirectory: '.' }, providers,
      layout: { kind: 'single-repo', repositories: { game: { path: 'project', role: 'code' } },
        documentation: { repository: 'game', path: 'docs' } } }));
  }
  const prepare = (command, registry = providerRegistry) => prepareLifecycle({ command, wrapper, manifestPath, tempRoot: root }, registry);
  async function install(command, registry = providerRegistry) {
    const prepared = await prepare(command, registry);
    const result = await applyLifecycle({ command, wrapper, prepared,
      approval: { decision: 'approve', preparedDigest: prepared.digest } }, registry);
    assert.equal(result.status, 'ready', JSON.stringify(result));
    return prepared;
  }
  async function remove(providers) {
    const prepared = await prepareRemoval(wrapper, providerRegistry, { providers });
    const lock = await acquireWorkspaceLock(wrapper);
    try { await applyRemoval(lock, prepared, { decision: 'approve', preparedDigest: prepared.digest }, providerRegistry); }
    finally { await lock.release(); }
  }
  const state = async () => JSON.parse(await readFile(path.join(wrapper, '.pipeline/state.json'), 'utf8'));
  const entry = () => readFile(path.join(wrapper, 'CLAUDE.md'), 'utf8');
  async function publishBundle(members) {
    pipeline.bundles={pair:{providers:members,entry:{source:'instructions/CLAUDE.md',target:'CLAUDE.md'}}};
    for(const id of ['claude','grok'])pipeline.providers[id]={...declaration,skills:'skills',mcp:'mcp.json'};
    files['pipeline.json']=JSON.stringify(pipeline);
    files['instructions/CLAUDE.md']='# Full shared pipeline\nRead project/docs.\nClaude and Grok use their own tools.\n';
    files['skills/sample/SKILL.md']='---\nname: sample\ndescription: Sample\n---\nRequire approval.\n';
    files['mcp.json']=JSON.stringify({mcpServers:{sample:{type:'stdio',command:'never-executed'}}});
    for(const [name,bytes] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(source,name)),{recursive:true});await writeFile(path.join(source,name),bytes);
    }
    await writeFile(path.join(source,'inventory.json'),JSON.stringify(Object.fromEntries(Object.entries(files).map(([name,bytes])=>[name,sha256(Buffer.from(bytes))]))));
    for(const args of [['add','--all'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','bundle']]) {
      const r=spawnSync('git',['-C',source,'-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],{env,encoding:'utf8',windowsHide:true});
      assert.equal(r.status,0,r.stderr);
    }
  }
  async function bundleManifest() {
    await manifest(['codex']);const value=JSON.parse(await readFile(manifestPath,'utf8'));
    value.bundles=['pair'];await writeFile(manifestPath,JSON.stringify(value));
  }
  async function removeBundle() {
    const prepared=await prepareRemoval(wrapper,providerRegistry,{bundles:['pair']}),lock=await acquireWorkspaceLock(wrapper);
    try {await applyRemoval(lock,prepared,{decision:'approve',preparedDigest:prepared.digest},providerRegistry);}
    finally {await lock.release();}
  }
  return { root, source, wrapper, manifest, prepare, install, remove, state, entry, publishBundle, bundleManifest, removeBundle };
}

test('common entry lifetime is limited to its consumers, not every provider', () => {
  const owned = { owner: 'shared', path: 'CLAUDE.md' };
  for (const id of ['claude', 'grok']) {
    assert.equal(removedWithProviders(owned, selectRemovalProviders(['claude', 'grok', 'codex'], [id])), false);
  }
  assert.equal(removedWithProviders(owned, selectRemovalProviders(['claude', 'grok', 'codex'], ['claude', 'grok'])), true);
  assert.equal(removedWithProviders({ ...owned, path: 'AGENTS.md' }, selectRemovalProviders(['claude', 'codex'], ['claude'])), false);
});

for (const first of ['claude', 'grok']) test(`common entry lifecycle: ${first} first, remove it first`, async () => {
  const f = await fixture(), second = first === 'claude' ? 'grok' : 'claude';
  await f.manifest(['codex', first]);
  await f.prepare('setup');
  await assert.rejects(f.entry(), e => e.code === 'ENOENT'); // preview never writes
  await f.install('setup'); assert.equal(await f.entry(), commonEntryText);
  await f.manifest(['codex', second, first]); await f.install('update');
  const repeated = await f.prepare('update'); assert.equal(repeated.preview.plan.targets.length, 0);
  assert.equal((await f.state()).active.owned.find(o => o.path === 'CLAUDE.md').owner, 'shared');
  await f.remove([first]); assert.equal(await f.entry(), commonEntryText);
  assert.ok((await inspectRepair(f.wrapper, providerRegistry)).entries.every(e => e.disposition === 'intact'));
  await rename(path.join(f.wrapper, 'CLAUDE.md'), path.join(f.root, 'saved-entry'));
  const repair = await prepareRepairPlan(f.wrapper, providerRegistry), lock = await acquireWorkspaceLock(f.wrapper);
  try { await applyRepair(lock, repair, { decision: 'approve', preparedDigest: repair.digest }, providerRegistry); }
  finally { await lock.release(); }
  assert.equal(await f.entry(), commonEntryText);
  await f.remove([second]); await assert.rejects(f.entry(), e => e.code === 'ENOENT');
  assert.ok((await readFile(path.join(f.wrapper, 'AGENTS.md'))).length);
  assert.ok((await inspectRepair(f.wrapper, providerRegistry)).entries.every(e => e.disposition === 'intact'));
  await f.remove(['codex']);
});

test('legacy Claude entry replays, migrates with exact bytes, refuses drift and preserves original backup', async () => {
  const f = await fixture(); await f.manifest(['claude']);
  const foreign = 'Original user entry\n';
  await writeFile(path.join(f.wrapper, 'CLAUDE.md'), foreign);
  const historical = c => ({ ...c, installedAdapterVersions: { claude: '1' } });
  const legacy = { adapters: { claude: { ...claudeAdapter, version: '1',
    plan: async c => (await claudeAdapter.plan(historical(c))).map(r => r.path !== 'CLAUDE.md' ? r :
      { ...r, takeover: { beforeHash: sha256(Buffer.from(foreign)), desiredHash: sha256(r.bytes) } }),
    validate: c => claudeAdapter.validate(historical(c)) } },
    sharedAdapter: { plan: c => sharedAdapter.plan(historical(c)) } };
  await f.install('setup', legacy);
  const original = await f.entry(); assert.notEqual(original, commonEntryText);
  assert.ok((await inspectRepair(f.wrapper, providerRegistry)).entries.every(e => e.disposition === 'intact'));
  const before = (await f.state()).active.owned.find(o => o.path === 'CLAUDE.md');
  assert.equal(before.beforeHash, sha256(Buffer.from(foreign))); assert.notEqual(before.backup, null);
  await writeFile(path.join(f.wrapper, 'CLAUDE.md'), 'user edit');
  await assert.rejects(f.prepare('update'), e => e.code === 'ownership.drift');
  assert.equal(await f.entry(), 'user edit');
  await writeFile(path.join(f.wrapper, 'CLAUDE.md'), original);
  await f.manifest(['claude', 'grok']); await f.install('update');
  const after = (await f.state()).active.owned.find(o => o.path === 'CLAUDE.md');
  assert.equal(after.owner, 'shared'); assert.equal(after.beforeHash, before.beforeHash); assert.equal(after.backup, before.backup);
  assert.equal(await f.entry(), commonEntryText);
  await f.remove(['claude']); assert.equal(await f.entry(), commonEntryText);
  await f.remove(['grok']); assert.equal(await f.entry(), foreign);
});

test('foreign CLAUDE.md conflicts without overwrite', async () => {
  const f = await fixture(); await f.manifest(['grok']);
  await writeFile(path.join(f.wrapper, 'CLAUDE.md'), 'personal rules');
  await assert.rejects(f.prepare('setup'), e => e.code === 'ownership.foreign');
  assert.equal(await f.entry(), 'personal rules');
});

test('bundle lifecycle migrates standalone, adds and retires members, repairs offline and removes atomically',async()=>{
  const f=await fixture();await f.manifest(['codex','claude']);await f.install('setup');
  await f.publishBundle(['claude']);await f.bundleManifest();await f.install('update');
  assert.match(await f.entry(),/^# Full shared pipeline/);
  assert.deepEqual((await f.state()).active.bundles.pair.providers,['claude']);
  await assert.rejects(f.remove(['claude']),e=>e.code==='remove.bundle-required');
  await f.publishBundle(['claude','grok']);await f.install('update');
  assert.ok((await readFile(path.join(f.wrapper,'.grok/skills/sample/SKILL.md'))).length);
  await writeFile(path.join(f.wrapper,'.grok/config.toml'),(await readFile(path.join(f.wrapper,'.grok/config.toml'),'utf8'))+'\n[user_note]\nkeep="yes"\n');
  await f.publishBundle(['claude']);
  const update=await f.prepare('update'),before=await f.state();
  const deleteIndex=update.preview.plan.targets.findIndex(t=>t.action==='delete');
  assert.ok(deleteIndex>=0);
  let recoveryPath;
  const updateLock=await acquireWorkspaceLock(f.wrapper);
  try {
    await assert.rejects(applyPrepared(updateLock,update,{decision:'approve',preparedDigest:update.digest},providerRegistry,before,{
      onJournal:async location=>{recoveryPath=location.relative.replace('/journals/','/transactions/')+'/recovery.json';},
      boundary:async(phase,index)=>{if(phase==='write' && index===deleteIndex)throw new Error('synthetic-crash-after-delete');}
    }),/synthetic-crash-after-delete/);
  } finally {await updateLock.release();}
  assert.equal((await f.state()).status,'needs-reconciliation');
  const continuation=await prepareContinuation(f.wrapper,recoveryPath),continuationLock=await acquireWorkspaceLock(f.wrapper);
  try {await applyContinuation(continuationLock,continuation,{decision:'approve',preparedDigest:continuation.digest});}
  finally {await continuationLock.release();}
  assert.equal((await f.state()).status,'ready');
  await assert.rejects(readFile(path.join(f.wrapper,'.grok/skills/sample/SKILL.md')),e=>e.code==='ENOENT');
  assert.match(await readFile(path.join(f.wrapper,'.grok/config.toml'),'utf8'),/keep="yes"/);
  assert.ok(!(await readFile(path.join(f.wrapper,'.grok/config.toml'),'utf8')).includes('never-executed'));
  await rename(f.source,path.join(f.root,'source-offline'));
  await rename(path.join(f.wrapper,'CLAUDE.md'),path.join(f.root,'saved-bundle-entry'));
  const repair=await prepareRepairPlan(f.wrapper,providerRegistry),lock=await acquireWorkspaceLock(f.wrapper);
  try {await applyRepair(lock,repair,{decision:'approve',preparedDigest:repair.digest},providerRegistry);}
  finally {await lock.release();}
  assert.match(await f.entry(),/^# Full shared pipeline/);
  await f.removeBundle();await assert.rejects(f.entry(),e=>e.code==='ENOENT');
  assert.ok((await readFile(path.join(f.wrapper,'AGENTS.md'))).length);
  await f.remove(['codex']);
});
