import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, stat, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { ContractError, fail } from '../contracts/parse.js';
import { validateStructure } from '../contracts/validate.js';
import { portablePath } from '../contracts/semantic.js';
import { LIMITS, cap, utf8, verifyPackage } from './inventory.js';
import { materialize } from './snapshot.js';
import {verifyDesiredPackage} from './desired-package.js';
import { repositoryBudget } from './repository-budget.js';

const oid = value => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
// Git for Windows understands /dev/null, but not Node's \\.\nul spelling.
const devNull = '/dev/null';
export function validateSource(source) {
  // Reuse the reviewed Git union via its public workspace envelope, no new schema.
  validateStructure('workspace', { schemaVersion: 1, pipeline: source, providers: ['codex'], profile: 'source-validation' });
  if (source.subdirectory !== '.') portablePath(source.subdirectory);
  if (source.ref !== 'HEAD' && !oid(source.ref)) {
    if (source.ref.startsWith('refs/') && !/^refs\/(?:heads|tags)\//.test(source.ref)) fail('source.ref');
    if (source.ref.endsWith('.') || source.ref.split('/').some(p => p.startsWith('.') || p.endsWith('.lock'))) fail('source.ref');
  }
  if (source.transport === 'remote') {
    let url;
    try { url = new URL(source.url); } catch { fail('source.url'); }
    const rawAuthority = source.url.split('/')[2];
    const port = /:(\d+)$/.exec(rawAuthority)?.[1];
    if (port !== undefined && (+port < 1 || +port > 65535)) fail('source.port');
    if (url.hostname.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) fail('source.host');
    let decoded;
    try { decoded = decodeURIComponent(url.pathname); } catch { fail('source.url'); }
    if (/[%\\\s\u0000-\u001f\u007f\u0085\ufeff?#]/u.test(decoded)) fail('source.url');
  }
  return source;
}
export function environment(network, alternate) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^GIT_/i.test(k) || ['GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT', 'GIT_ASKPASS',
      ...(network ? ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM'] : [])].includes(k.toUpperCase())) env[k] = v;
  }
  Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1', GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0' });
  // Local object reads need no authentication or global Git configuration.
  if (!network) Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull });
  // Git accepts C-quoted entries, preventing separators in a path from becoming
  // additional object stores. This is internal discovery, never package input.
  if (alternate) env.GIT_ALTERNATE_OBJECT_DIRECTORIES = JSON.stringify(alternate.replaceAll('\\', '/'));
  return env;
}
async function bytesIn(directory) {
  let size = 0;
  for (const e of await readdir(directory, { withFileTypes: true })) {
    const p = path.join(directory, e.name);
    if (e.isSymbolicLink()) fail('source.preparation-link');
    try { size += e.isDirectory() ? await bytesIn(p) : (await stat(p)).size; }
    catch (e) { if (e.code !== 'ENOENT') throw e; } // pack temporary file renamed
  }
  return size;
}
export function gitArgs(cwd, args) {
  return ['--no-pager', '--no-replace-objects', '--no-lazy-fetch', '--literal-pathspecs', '-C', cwd,
    '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=' + devNull,
    '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-c', 'fetch.writeCommitGraph=false',
    '-c', 'protocol.ext.allow=never', ...args];
}
// Output and stored-object caps are independent. On Windows terminate the owned
// child process tree; never kill by process name or touch unrelated sessions.
export function runGit(cwd, args, options = {}, runtime = {}) {
  return runBoundedGit(LIMITS, cwd, args, options, runtime);
}
export function runRepositoryGit(cwd, args, options = {}, runtime = {}) {
  const budget = repositoryBudget(options);
  return runBoundedGit({...LIMITS, blob:256*1024*1024, pack:budget.packLimit, gitMs:budget.gitMs, acquisitionMs:budget.acquisitionMs},
    cwd, args, {...options, packLimit:budget.packLimit}, runtime);
}
async function runBoundedGit(limits, cwd, args, { deadline = performance.now() + limits.acquisitionMs,
  outputLimit = LIMITS.metadata, network = false, objects, packLimit = LIMITS.pack, allowMissing = false, alternate,
  diagnoseUnadvertised = false } = {}, runtime = {}) {
  cap(packLimit, limits.pack, 'source.pack-limit');
  cap(outputLimit, limits.blob, 'source.output-limit');
  const timeout = Math.min(limits.gitMs, deadline - performance.now());
  if (timeout <= 0) fail('source.timeout');
  return new Promise((resolve, reject) => {
    const launch = runtime.spawn ?? spawn;
    const child = launch('git', gitArgs(cwd, args), {
      shell: false, windowsHide: true, env: environment(network, alternate), stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    });
    let failure, length = 0, stderrLength = 0, chunks = [], monitoring = false, closed = false, settled = false, terminationTimer;
    let stderrTail = '', unadvertised = false;
    const stop = code => {
      if (failure || closed) return;
      failure = code;
      // A surviving descendant can retain the pipe after Git exits. Never wait
      // indefinitely for close; report uncertainty rather than pretending it died.
      terminationTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); clearInterval(monitor);
        child.stdout.destroy(); child.stderr.destroy(); child.unref();
        const error = new ContractError('source.termination-unconfirmed');
        error.processId = child.pid;
        reject(error);
      }, 2000);
      if (child.pid) {
        if ((runtime.platform ?? process.platform) === 'win32') {
          const killer = launch('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
          killer.on('error', () => child.kill());
          killer.on('exit', code => { if (code !== 0 && !closed) child.kill(); });
        } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill(); } }
      }
    };
    const timer = setTimeout(() => stop('source.timeout'), timeout);
    const monitor = objects ? setInterval(async () => {
      if (monitoring || failure) return;
      monitoring = true;
      try { if (await bytesIn(objects) > packLimit) stop('source.pack'); }
      catch { stop('source.pack-monitor'); }
      finally { monitoring = false; }
    }, 25) : null;
    child.stdout.on('data', b => {
      length += b.length;
      if (length > outputLimit) stop('source.output');
      else chunks.push(b);
    });
    child.stderr.on('data', b => {
      stderrLength += b.length;
      if (stderrLength > LIMITS.metadata) { stop('source.stderr'); return; }
      if (diagnoseUnadvertised) {
        // Recognize a fixed native diagnostic only. Never expose remote stderr,
        // URLs or credentials; chunk boundaries must not change classification.
        const text = stderrTail + b.toString('utf8');
        unadvertised ||= /Server does not allow request for unadvertised object/i.test(text);
        stderrTail = text.slice(-128);
      }
    });
    child.on('error', () => { settled = true; clearTimeout(timer); clearTimeout(terminationTimer); clearInterval(monitor); reject(new ContractError('source.git-unavailable')); });
    child.on('close', async code => {
      closed = true;
      clearTimeout(timer); clearTimeout(terminationTimer); clearInterval(monitor);
      if (settled) return;
      settled = true;
      try {
        if (objects && await bytesIn(objects) > packLimit) failure = 'source.pack';
        if (failure) fail(failure);
        if (code !== 0 && !(allowMissing && code === 1)) fail(unadvertised ? 'source.unadvertised-commit' : 'source.git-failed');
        resolve({ code, bytes: Buffer.concat(chunks) });
      } catch (e) { reject(e instanceof ContractError ? e : new ContractError('source.git-failed')); }
    });
  });
}
// Source Git is used only for bounded metadata discovery. Ref peeling and all
// object interpretation run in a fresh bare repo: no source config/index/hooks
// are copied. The temporary read-only alternate is never part of the snapshot.
async function localRepo(sourceRepo, ref, preparation, options) {
  const inspect = async args => utf8((await runGit(sourceRepo, args, options)).bytes).trim();
  const bare = await inspect(['rev-parse', '--is-bare-repository']) === 'true';
  const root = await inspect(['rev-parse', bare ? '--absolute-git-dir' : '--show-toplevel']);
  if (await realpath(root) !== sourceRepo) fail('source.repository-root');
  const common = await inspect(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const alternate = await realpath(path.join(common, 'objects'));
  const format = await inspect(['rev-parse', '--show-object-format=storage']);
  if (!['sha1', 'sha256'].includes(format)) fail('source.object-format');
  const repo = path.join(preparation, 'objects.git');
  await mkdir(repo);
  await runGit(repo, ['init', '--bare', '--template=', '--object-format=' + format], options);
  const names = ref === 'HEAD' || oid(ref) || ref.startsWith('refs/') ? [ref] : ['refs/heads/' + ref, 'refs/tags/' + ref];
  for (const name of names) {
    if (oid(name)) continue;
    const found = await runGit(sourceRepo, ['rev-parse', '--verify', '--quiet', '--end-of-options', name], { ...options, allowMissing: true });
    if (found.code !== 0) continue;
    const value = utf8(found.bytes).trim();
    if (!oid(value)) fail('source.ref-output');
    // Packed refs and reftable are read by native Git, not guessed on disk.
    const target = path.join(repo, ...name.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, value + '\n');
  }
  const isolatedOptions = { ...options, alternate };
  const commit = await resolveLocal(repo, ref, isolatedOptions);
  return { repo, commit, alternate };
}
async function resolveLocal(repo, ref, options) {
  async function candidate(name) {
    const r = await runGit(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', name + '^{commit}'], { ...options, allowMissing: true });
    return r.code === 0 ? utf8(r.bytes).trim() : null;
  }
  let values;
  if (ref === 'HEAD' || oid(ref) || ref.startsWith('refs/')) values = [await candidate(ref)];
  else {
    values = [await candidate('refs/heads/' + ref), await candidate('refs/tags/' + ref)];
    if (values.filter(Boolean).length > 1) fail('source.ambiguous-ref');
  }
  const value = values.find(Boolean);
  if (!value || !oid(value)) fail('source.missing-ref');
  if (oid(ref) && value !== ref) fail('source.not-commit');
  return value;
}
export function parseListing(buffer) {
  const text = utf8(buffer);
  if (text && !text.endsWith('\0')) fail('source.tree-output');
  return text.split('\0').filter(Boolean).map(line => {
    const match = /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40}|[a-f0-9]{64})\s+(\d+|-)\t([\s\S]+)$/.exec(line);
    if (!match) fail('source.tree-output');
    return { mode: match[1], type: match[2], oid: match[3], size: match[4] === '-' ? 0 : Number(match[4]), path: match[5] };
  });
}
const runBoundedSourceGit = runGit;
async function remoteRepo(source, options, preparation, runGit = runBoundedSourceGit) {
  const repo = path.join(preparation, 'objects.git');
  await mkdir(repo);
  await runGit(repo, ['init', '--bare', '--template='], options);
  const protocol = source.url.startsWith('https:') ? 'https' : 'ssh';
  const transport = ['-c', 'protocol.allow=never', '-c', 'protocol.' + protocol + '.allow=always',
    '-c', 'http.followRedirects=false'];
  let wanted = source.ref;
  if (!oid(wanted)) {
    const refs = wanted === 'HEAD' || wanted.startsWith('refs/') ? [wanted] : ['refs/heads/' + wanted, 'refs/tags/' + wanted];
    const listing = await runGit(repo, [...transport, 'ls-remote', '--', source.url, ...refs], { ...options, network: true });
    const found = utf8(listing.bytes).trim().split('\n').filter(Boolean).map(l => l.split('\t')).filter(([, ref]) => refs.includes(ref));
    if (found.length > 1) fail('source.ambiguous-ref');
    if (found.length !== 1 || !oid(found[0][0])) fail('source.missing-ref');
    wanted = found[0][0];
  }
  await runGit(repo, [...transport, '-c', 'fetch.unpackLimit=0', '-c', 'transfer.unpackLimit=0',
    'fetch', '--depth=1', '--no-tags', '--no-recurse-submodules', '--no-auto-maintenance',
    '--no-write-fetch-head', '--keep', '--', source.url, wanted],
    { ...options, network: true, objects: path.join(repo, 'objects'), diagnoseUnadvertised: oid(source.ref) });
  const resolved = await runGit(repo, ['rev-parse', '--verify', '--end-of-options', wanted + '^{commit}'], options);
  const commit = utf8(resolved.bytes).trim();
  if (!oid(commit)) fail('source.missing-ref');
  if (oid(source.ref) && commit !== source.ref) fail('source.not-commit');
  return { repo, commit };
}
// S7 repository preparation reuses bounded transport, not package validation.
// Internal only: caller must keep tempRoot outside workspace/user repositories.
// Failure retains the owned preparation path; never delete user data as rollback.
export async function acquireRemoteRepository(source, { tempRoot, network = false, ...requestedBudget } = {}) {
  validateSource(source);
  if (source.transport !== 'remote' || source.subdirectory !== '.') fail('repository-source.kind');
  if (network !== true) fail('source.network-required');
  if (!path.isAbsolute(tempRoot ?? '')) fail('repository-source.temp-root');
  const budget = repositoryBudget(requestedBudget);
  let preparation;
  const options = {...budget,deadline:performance.now()+budget.acquisitionMs};
  try {
    const parent = await realpath(tempRoot);
    preparation = await mkdtemp(path.join(parent,'wpc-repository-'));
    const {repo,commit} = await remoteRepo(source,options,preparation,runRepositoryGit);
    await runRepositoryGit(repo,['fsck','--connectivity-only','--no-reflogs','--no-progress'],options);
    return {source:structuredClone(source),resolvedSource:source.url,preparation,repo,commit,
      ...budget,history:'shallow-depth-1',checkout:'not-performed',executionAuthorized:false};
  } catch (cause) {
    const error = cause instanceof ContractError ? cause : new ContractError('repository-source.io');
    if (preparation) error.preparation=preparation;
    throw error;
  }
}

export async function acquire(source, { manifestBase, tempRoot = tmpdir(), network = false, packLimit = LIMITS.pack, packageFormat='legacy' } = {}) {
  if(!['legacy','desired'].includes(packageFormat))fail('source.package-format');
  validateSource(source);
  cap(packLimit, LIMITS.pack, 'source.pack-limit');
  if (!path.isAbsolute(manifestBase ?? '')) fail('source.manifest-base');
  if (source.transport === 'remote' && !network) fail('source.network-required');
  const deadline = performance.now() + LIMITS.acquisitionMs, options = { deadline, packLimit };
  let preparation, snapshotPath;
  try {
  const parent = await realpath(tempRoot);
  preparation = await mkdtemp(path.join(parent, 'wpc-git-'));
  let repo, commit, resolvedSource;
  if (source.transport === 'local') {
    try { resolvedSource = await realpath(path.resolve(manifestBase, source.path)); }
    catch (e) { fail(e.code === 'ENOENT' ? 'source.missing-repository' : 'source.repository-unavailable'); }
    const local = await localRepo(resolvedSource, source.ref, preparation, options);
    ({ repo, commit } = local);
    options.alternate = local.alternate;
  } else {
    resolvedSource = source.url;
    ({ repo, commit } = await remoteRepo(source, options, preparation));
  }
  const treeish = commit + ':' + (source.subdirectory === '.' ? '' : source.subdirectory);
  const rootType = await runGit(repo, ['cat-file', '-t', treeish], options);
  if (utf8(rootType.bytes).trim() !== 'tree') fail('source.package-root');
  const listing = await runGit(repo, ['ls-tree', '-r', '-l', '-z', '--full-tree', treeish], options);
  const verify=packageFormat==='desired'?verifyDesiredPackage:verifyPackage;
  const verified = await verify(parseListing(listing.bytes), async entry => {
    const r = await runGit(repo, ['cat-file', 'blob', entry.oid], { ...options, outputLimit: LIMITS.blob });
    return r.bytes;
  });
  if (performance.now() > deadline) fail('source.timeout');
  snapshotPath = await materialize(verified, parent);
  if (performance.now() > deadline) fail('source.timeout');
  return { source: structuredClone(source), resolvedSource, commit, preparation, snapshotPath,
    manifest: verified.manifest, inventoryDigest: verified.inventoryDigest,
    digest: verified.digest, fileHashes: verified.fileHashes, runtime: 'not-run',
    ...(packageFormat==='desired'?{files:verified.files}: {}) };
  } catch (cause) {
    const error = cause instanceof ContractError ? cause : new ContractError('source.io');
    if (preparation) error.preparation = preparation;
    if (snapshotPath) error.snapshotPath = snapshotPath;
    throw error;
  }
}
