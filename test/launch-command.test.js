import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseLaunch, runLaunch } from '../src/commands/launch.js';
import { parseCommand } from '../src/commands/dispatch.js';

const workspace = path.resolve('synthetic workspace'), executable = path.resolve('synthetic grok.exe');
const command = extra => parseLaunch(['launch', 'grok', '--workspace', workspace, '--executable', executable, ...extra]);
function fixture() {
  const result = { stdout: '', stderr: '', calls: [] };
  const deps = { doctor: async () => ({ ready: true, pipeline: { providers: ['grok'] } }),
    state: async () => ({ digest: 'same-state', value: { active: { providers: ['grok'] }, pending: null } }),
    stat: async () => ({ isFile: () => true, isSymbolicLink: () => false }),
    start: async (...args) => { result.calls.push(args); return { code: 0 }; }, platform: 'win32', tty: true,
    env: { Path: 'keep', GROK_HOME: 'unchanged', XAI_API_KEY: 'synthetic-secret', grok_claude_skills_enabled: 'true' } };
  return { result, deps, stdout: async text => { result.stdout += text; }, stderr: async text => { result.stderr += text; } };
}
test('launch preview never spawns and does not disclose parent credentials', async () => {
  const f = fixture(); assert.equal(await runLaunch(command([]), f.stdout, f.stderr, f.deps), 0);
  assert.equal(f.result.calls.length, 0);
  assert.ok(!f.result.stdout.includes('synthetic-secret'));
  assert.equal(JSON.parse(f.result.stdout).runtime, 'not-run');
});
test('public dispatcher recognizes strict launch syntax', () => {
  assert.deepEqual(parseCommand(['launch', 'grok', '--workspace', workspace, '--executable', executable]), command([]));
  assert.throws(() => parseCommand(['launch', 'grok', '--workspace', workspace, '--executable', executable, '--always-approve']));
});
test('explicit Grok inspect launch uses verified cwd, argv and child-only overlay', async () => {
  const f = fixture(), before = structuredClone(f.deps.env);
  assert.equal(await runLaunch(command(['--execute', '--inspect']), f.stdout, f.stderr, f.deps), 0);
  const [exe, args, options] = f.result.calls[0];
  assert.equal(exe, executable); assert.deepEqual(args, ['inspect', '--json']); assert.equal(options.cwd, workspace);
  assert.equal(options.env.GROK_CLAUDE_SKILLS_ENABLED, 'false'); assert.equal(options.env.GROK_HOME, 'unchanged');
  assert.equal(options.env.grok_claude_skills_enabled, undefined); assert.deepEqual(f.deps.env, before);
  assert.ok(!f.result.stderr.includes('synthetic-secret'));
});
test('launch rejects scope-changing arguments, duplicate options and missing executable', () => {
  for (const args of [['--cwd', workspace], ['--', '--worktree'], ['--model', 'x'], ['--execute', '--execute']]) assert.throws(() => command(args));
  assert.throws(() => parseLaunch(['launch', 'kimi', '--workspace', workspace, '--executable', executable]));
  assert.throws(() => parseLaunch(['launch', 'grok', '--workspace', workspace]), e => e.code === 'launch.executable-required');
});
test('launch refuses unready or non-Grok installation without spawning', async () => {
  for (const report of [{ ready: false }, { ready: true, pipeline: { providers: ['codex'] } }]) {
    const f = fixture(); f.deps.doctor = async () => report;
    await assert.rejects(runLaunch(command(['--execute']), f.stdout, f.stderr, f.deps), e => e.code === 'launch.not-ready');
    assert.equal(f.result.calls.length, 0);
  }
});
test('launch refuses state drift during inspection and just before spawning', async () => {
  for (const point of [2, 3]) {
    const f = fixture(), state = f.deps.state; let count = 0;
    f.deps.state = async () => ({ ...await state(), digest: ++count >= point ? 'changed' : 'same-state' });
    await assert.rejects(runLaunch(command(['--execute']), f.stdout, f.stderr, f.deps), e => e.code === 'launch.state-drift');
    assert.equal(f.result.calls.length, 0);
  }
});
test('launch rejects script executables and noninteractive TUI, propagates child failure', async () => {
  const f = fixture();
  await assert.rejects(runLaunch({ ...command([]), executable: path.resolve('grok.cmd') }, f.stdout, f.stderr, f.deps), e => e.code === 'launch.executable-format');
  f.deps.tty = false;
  await assert.rejects(runLaunch(command(['--execute']), f.stdout, f.stderr, f.deps), e => e.code === 'launch.terminal-required');
  f.deps.start = async () => ({ code: 7 });
  assert.equal(await runLaunch(command(['--execute', '--inspect']), f.stdout, f.stderr, f.deps), 7);
  f.deps.start = async () => ({ code: null, signal: 'SIGTERM' });
  assert.equal(await runLaunch(command(['--execute', '--inspect']), f.stdout, f.stderr, f.deps), 1);
});
