import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, rename, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { codexAdapter, claudeAdapter } from '../src/providers/native.js';
import { kimiAdapter } from '../src/providers/kimi.js';
import { grokAdapter } from '../src/providers/grok.js';
import { runLaunch } from '../src/commands/launch.js';
import { providerRegistry } from '../src/providers/registry.js';
import { sharedAdapter } from '../src/providers/shared.js';
import { sha256 } from '../src/source/inventory.js';
import { prepareLifecycle, applyLifecycle } from '../src/operations/lifecycle.js';
import { inspectInstallation } from '../src/operations/doctor.js';
import { prepareRemoval } from '../src/operations/remove.js';
import { prepareRepairPlan } from '../src/operations/repair.js';
import { applyRemoval, applyRepair } from '../src/operations/apply.js';
import { acquireWorkspaceLock } from '../src/operations/lock.js';
import { readTOMLField } from '../src/operations/toml-fields.js';
import { contractDigest } from '../src/contracts/semantic.js';

for (const [includeKimi, includeGrok] of [[false, false], [true, false], [true, true]]) test(`native adapters install update repair and remove independently offline (Kimi=${includeKimi},Grok=${includeGrok})`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wpc-s8-native-'));
  const wrapper = path.join(root, 'a'), sibling = path.join(root, 'b'), repo = path.join(root, 'source');
  for (const p of [wrapper, sibling, repo]) await mkdir(p);
  const decl = { skills: 'skills', agents: 'codex-agents', mcp: 'mcp.json', entryInstructions: 'entry.md', requires: [] };
  const pipeline = { schemaVersion: 1, id: 'sample', version: '1.0.0', resources: 'resources', inventory: 'inventory.json', agentsDocument: { mode: 'default' },
    providers: { codex: decl, claude: { ...decl, agents: 'claude-agents' } } };
  if (includeKimi) pipeline.providers.kimi = { ...decl, agents: 'claude-agents' };
  if (includeGrok) pipeline.providers.grok = { ...decl, agents: 'claude-agents' };
  const files = {
    'pipeline.json': JSON.stringify(pipeline), 'resources/process.md': 'Approval required.', 'entry.md': 'Follow common project rules.',
    'skills/sample-review/SKILL.md': '---\nname: sample-review\ndescription: Review only\n---\nRead ../../resources/process.md.\n',
    'codex-agents/sample-review.toml': 'name="sample-review"\ndescription="Review only"\ndeveloper_instructions="Do not edit."\n',
    'claude-agents/sample-review.md': '---\nname: sample-review\ndescription: Review only\n---\nDo not edit.\n',
    'mcp.json': JSON.stringify({ mcpServers: { 'sample-tool': { type: 'stdio', command: 'never-executed' } } })
  };
  async function saveSource() {
    for (const [name, text] of Object.entries(files)) { const p = path.join(repo, name); await mkdir(path.dirname(p), { recursive: true }); await writeFile(p, text); }
    await writeFile(path.join(repo, 'inventory.json'), JSON.stringify(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, sha256(Buffer.from(text))]))));
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
  function git(args) {
    const r = spawnSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { env, windowsHide: true, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
  await saveSource(); git(['init', '--initial-branch=main', '--template=']);
  const commit = () => { git(['add', '--all']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']); };
  commit();
  const manifest = { schemaVersion: 1, pipeline: { type: 'git', transport: 'local', path: '../source', ref: 'main', subdirectory: '.' },
    providers: ['codex', 'claude'], layout: { kind: 'single-repo', repositories: { game: { path: 'project', role: 'code' } }, documentation: { repository: 'game', path: 'docs' } } };
  const manifestPath = path.join(wrapper, 'workspace.json'); await writeFile(manifestPath, JSON.stringify(manifest));
  if (includeKimi) {
    manifest.providers.push('kimi');
    await writeFile(manifestPath, JSON.stringify(manifest));
    await mkdir(path.join(wrapper, '.kimi-code'));
    await writeFile(path.join(wrapper, '.kimi-code/mcp.json'), JSON.stringify({ mcpServers: { foreign: { command: 'kimi-user-owned' } }, note: 'keep' }));
  }
  const grokForeign = '# personal Grok\r\n[models]\r\ndefault="user-selected"\r\n[mcp_servers.foreign]\r\ncommand="user-owned"\r\n';
  if (includeGrok) {
    manifest.providers.push('grok');
    await writeFile(manifestPath, JSON.stringify(manifest));
    await mkdir(path.join(wrapper, '.grok'));
    await writeFile(path.join(wrapper, '.grok/config.toml'), grokForeign);
  }
  await mkdir(path.join(wrapper, '.codex'));
  const foreign = '# personal\r\nmodel="user-selected"\r\n';
  await writeFile(path.join(wrapper, '.codex/config.toml'), foreign);
  await writeFile(path.join(wrapper, '.mcp.json'), JSON.stringify({ mcpServers: { foreign: { command: 'user-owned' } }, userNote: 'preserve' }));
  const registry = includeGrok ? providerRegistry : {
    adapters: { codex: codexAdapter, claude: claudeAdapter, ...(includeKimi ? { kimi: kimiAdapter } : {}) }, sharedAdapter
  };
  async function install(command) {
    const prepared = await prepareLifecycle({ command, wrapper, manifestPath, tempRoot: root }, registry);
    const report = await applyLifecycle({ command, wrapper, prepared, approval: { decision: 'approve', preparedDigest: prepared.digest } }, registry);
    assert.equal(report.status, 'ready', JSON.stringify(report));
  }
  await install('setup');
  assert.equal((await inspectInstallation(wrapper)).ready, true);
  for (const name of ['.agents/skills/sample-review/SKILL.md', '.claude/skills/sample-review/SKILL.md', 'CLAUDE.md']) assert.ok((await readFile(path.join(wrapper, name))).length);
  if (includeKimi) for (const name of ['.kimi-code/skills/sample-review/SKILL.md', '.kimi-code/agents/sample-review.md']) assert.ok((await readFile(path.join(wrapper, name))).length);
  if (includeGrok) for (const name of ['.grok/skills/sample-review/SKILL.md', '.grok/agents/sample-review.md']) assert.ok((await readFile(path.join(wrapper, name))).length);
  if (includeGrok) {
    let output = '', calls = 0;
    const launch = { command: 'launch', provider: 'grok', workspace: wrapper, executable: process.execPath, inspect: true, execute: false };
    const dependencies = { start: async (exe, args, options) => {
      calls++; assert.equal(exe, process.execPath); assert.deepEqual(args, ['inspect', '--json']);
      assert.equal(options.cwd, wrapper); assert.equal(options.env.GROK_CLAUDE_SKILLS_ENABLED, 'false');
      return { code: 0 };
    } };
    const capture = async text => { output += text; };
    assert.equal(await runLaunch(launch, capture, async () => {}, dependencies), 0);
    assert.equal(calls, 0); assert.equal(JSON.parse(output).runtime, 'not-run');
    assert.equal(await runLaunch({ ...launch, execute: true }, async () => {}, async () => {}, dependencies), 0);
    assert.equal(calls, 1); // Instrumented spawn boundary; no native model invoked.
  }
  pipeline.version = '1.0.1'; files['pipeline.json'] = JSON.stringify(pipeline); files['resources/process.md'] += '\nUpdated rules.';
  await saveSource(); commit(); await install('update');
  const entry = await readFile(path.join(wrapper, 'AGENTS.md'));
  const skill = includeGrok ? '.grok/skills/sample-review/SKILL.md' : includeKimi ? '.kimi-code/skills/sample-review/SKILL.md' : '.agents/skills/sample-review/SKILL.md', expected = await readFile(path.join(wrapper, skill));
  await rename(path.join(wrapper, skill), path.join(root, 'saved-skill.md'));
  const repair = await prepareRepairPlan(wrapper, registry), repairLock = await acquireWorkspaceLock(wrapper);
  try { await applyRepair(repairLock, repair, { decision: 'approve', preparedDigest: repair.digest }, registry); } finally { await repairLock.release(); }
  assert.deepEqual(await readFile(path.join(wrapper, skill)), expected);
  async function remove(providers) {
    const prepared = await prepareRemoval(wrapper, registry, providers ? { providers } : {}), lock = await acquireWorkspaceLock(wrapper);
    try { await applyRemoval(lock, prepared, { decision: 'approve', preparedDigest: prepared.digest }, registry); } finally { await lock.release(); }
  }
  if (includeGrok) {
    const kimiBefore = await readFile(path.join(wrapper, '.kimi-code/skills/sample-review/SKILL.md'));
    await remove(['grok']);
    await assert.rejects(readFile(path.join(wrapper, '.grok/skills/sample-review/SKILL.md')), e => e.code === 'ENOENT');
    await assert.rejects(readFile(path.join(wrapper, '.grok/agents/sample-review.md')), e => e.code === 'ENOENT');
    assert.equal(await readFile(path.join(wrapper, '.grok/config.toml'), 'utf8'), grokForeign);
    assert.deepEqual(await readFile(path.join(wrapper, '.kimi-code/skills/sample-review/SKILL.md')), kimiBefore);
    assert.deepEqual(await readFile(path.join(wrapper, 'AGENTS.md')), entry);
    assert.equal((await inspectInstallation(wrapper)).ready, true);
  }
  if (includeKimi) {
    const codexBefore = await readFile(path.join(wrapper, '.agents/skills/sample-review/SKILL.md'));
    const claudeBefore = await readFile(path.join(wrapper, '.claude/skills/sample-review/SKILL.md'));
    await remove(['kimi']);
    await assert.rejects(readFile(path.join(wrapper, '.kimi-code/skills/sample-review/SKILL.md')), e => e.code === 'ENOENT');
    await assert.rejects(readFile(path.join(wrapper, '.kimi-code/agents/sample-review.md')), e => e.code === 'ENOENT');
    assert.deepEqual(JSON.parse(await readFile(path.join(wrapper, '.kimi-code/mcp.json'), 'utf8')), { mcpServers: { foreign: { command: 'kimi-user-owned' } }, note: 'keep' });
    assert.deepEqual(await readFile(path.join(wrapper, '.agents/skills/sample-review/SKILL.md')), codexBefore);
    assert.deepEqual(await readFile(path.join(wrapper, '.claude/skills/sample-review/SKILL.md')), claudeBefore);
    assert.deepEqual(await readFile(path.join(wrapper, 'AGENTS.md')), entry);
    assert.equal((await inspectInstallation(wrapper)).ready, true);
    // Removing owned Kimi files is not evidence that native Kimi stops reading
    // the generic .agents routes belonging to Codex.
  }
  await remove(['claude']);
  const {active}=JSON.parse(await readFile(path.join(wrapper,'.pipeline/state.json'),'utf8'));
  assert.equal(active.id,'deployment-'+contractDigest({snapshot:active.snapshot,layout:active.layout,
    agentsDocument:active.agentsDocument,providers:active.providers,owned:active.owned}).slice(7));
  assert.deepEqual(await readFile(path.join(wrapper, 'AGENTS.md')), entry);
  await assert.rejects(readFile(path.join(wrapper, 'CLAUDE.md')), e => e.code === 'ENOENT');
  assert.equal((await inspectInstallation(wrapper)).ready, true);
  // Second removal replays common and remaining Codex outputs after partial removal.
  await remove();
  const final = await readFile(path.join(wrapper, '.codex/config.toml'));
  assert.equal(final.toString(),foreign);
  assert.equal(readTOMLField(final, '/agents/sample-review').present, false);
  assert.equal(readTOMLField(final, '/mcp_servers/sample-tool').present, false);
  assert.deepEqual(JSON.parse(await readFile(path.join(wrapper, '.mcp.json'), 'utf8')), { mcpServers: { foreign: { command: 'user-owned' } }, userNote: 'preserve' });
  await assert.rejects(readFile(path.join(wrapper, 'AGENTS.md')), e => e.code === 'ENOENT');
  assert.deepEqual(await readdir(sibling), []);
});
