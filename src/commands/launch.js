import { lstat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fail } from '../contracts/parse.js';
import { absoluteRoot, resolveChild } from '../workspace/paths.js';
import { readState } from '../operations/state.js';
import { inspectInstallation } from '../operations/doctor.js';
import { grokEnvironment } from '../launch/grok.js';

export function parseLaunch(args) {
  if (args[0] !== 'launch' || args[1] !== 'grok') fail('cli.arguments');
  const result = { command: 'launch', provider: 'grok', execute: false, inspect: false }, seen = new Set();
  for (let i = 2; i < args.length; i++) {
    const flag = args[i];
    if (!['--workspace', '--executable', '--execute', '--inspect'].includes(flag) || seen.has(flag)) fail('cli.arguments');
    seen.add(flag);
    if (flag === '--execute') { result.execute = true; continue; }
    if (flag === '--inspect') { result.inspect = true; continue; }
    const value = args[++i];
    if (value === undefined || value.startsWith('--')) fail('cli.arguments');
    result[flag === '--workspace' ? 'workspace' : 'executable'] = absoluteRoot(value);
  }
  if (!result.workspace) fail('cli.workspace-required');
  if (!result.executable) fail('launch.executable-required');
  return result;
}

function spawnNative(executable, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { ...options, shell: false, stdio: 'inherit' });
    child.once('error', () => reject(new Error('launch.spawn')));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

// Dependencies are trusted embedding/test functions, never package data.
export async function runLaunch(command, stdout, stderr, dependencies = {}) {
  const doctor = dependencies.doctor ?? inspectInstallation;
  const state = dependencies.state ?? (wrapper => readState(resolveChild(wrapper, '.pipeline/state.json')));
  const stat = dependencies.stat ?? lstat;
  const start = dependencies.start ?? spawnNative;
  const platform = dependencies.platform ?? process.platform;
  const parentEnv = dependencies.env ?? process.env;
  const tty = dependencies.tty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  // No arbitrary harness arguments: --cwd, worktrees or prompt/config overrides
  // must not silently change the verified launch scope.
  const before = await state(command.workspace);
  const report = await doctor(command.workspace);
  const after = await state(command.workspace);
  if (before.digest !== after.digest) fail('launch.state-drift');
  if (!report.ready || !report.pipeline?.providers.includes('grok')) fail('launch.not-ready');
  if (!after.value.active?.providers.includes('grok') || after.value.pending !== null) fail('launch.not-ready');
  if (platform === 'win32' && !/\.exe$/i.test(command.executable)) fail('launch.executable-format');
  const executable = await stat(command.executable);
  if (!executable.isFile() || executable.isSymbolicLink()) fail('launch.executable-format');
  const args = command.inspect ? ['inspect', '--json'] : [];
  const overlay = grokEnvironment({}, platform);
  const preview = { command: 'launch', provider: 'grok', workspace: command.workspace,
    executable: command.executable, args, environmentOverrides: overlay,
    stateHash: after.digest, configuration: 'verified', runtime: 'not-run',
    warning: 'Close pipeline configuration editors/updaters during launch. No ongoing configuration lock or runtime certification. Harness may start configured MCP servers.' };
  if (!command.execute) { await stdout(JSON.stringify(preview) + '\n'); return 0; }
  if (!command.inspect && !tty) fail('launch.terminal-required');
  await stderr(JSON.stringify(preview) + '\n');
  // Fail if a concurrent installer changed state while the launch report was emitted.
  if ((await state(command.workspace)).digest !== after.digest) fail('launch.state-drift');
  const result = await start(command.executable, args, { cwd: command.workspace, env: grokEnvironment(parentEnv, platform) });
  // Process exit is not a statement about model-visible skills or task acceptance.
  return Number.isInteger(result.code) && result.code >= 0 && result.code <= 255 ? result.code : 1;
}
