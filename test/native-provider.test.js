import test from 'node:test';
import assert from 'node:assert/strict';
import { posix } from 'node:path';
import { parseTOML, getStaticTOMLValue } from 'toml-eslint-parser';
import { codexAdapter, claudeAdapter } from '../src/providers/native.js';
import { assertAdapter } from '../src/providers/interface.js';
import { assertRequestScope } from '../src/operations/plan.js';
import { reconcileTOMLFields, readTOMLField } from '../src/operations/toml-fields.js';
import { sharedAdapter } from '../src/providers/shared.js';

export function nativeContext() {
  const digest = 'sha256:' + 'b'.repeat(64);
  const declaration = { skills: 'skills', agents: 'codex-agents', mcp: 'mcp.json', entryInstructions: 'entry.md', requires: [] };
  const files = new Map(Object.entries({
    'skills/sample-review/SKILL.md': '---\nname: sample-review\ndescription: "Review without edits"\n---\nRead [rules](../../resources/process.md).\n',
    'skills/sample-review/references/detail.md': 'Detail',
    'codex-agents/sample-review.toml': 'name="sample-review"\ndescription="Independent review"\ndeveloper_instructions="Review without editing; read the source rules."\n',
    'claude-agents/sample-review.md': '---\nname: sample-review\ndescription: "Independent review"\n---\nReview without editing.\n',
    'mcp.json': JSON.stringify({ mcpServers: { 'sample-tool': { type: 'stdio', command: 'never-executed', args: ['--arg'], env: { MODE: 'synthetic' } } } }),
    'entry.md': 'Use common pipeline.', 'resources/process.md': 'Require human approval.'
  }).map(([p, t]) => [p, Buffer.from(t)]));
  return { files, snapshot: { digest, path: '.pipeline/snapshots/' + digest.slice(7) },
    pipeline: { id: 'sample', resources: 'resources', providers: { codex: declaration, claude: { ...declaration, agents: 'claude-agents' } } },
    workspace: { providers: ['codex', 'claude'] },
    layout: { agentsDocument: { mode: 'default' },
      layout: { kind: 'single-repo', repositories: { game: { path: 'project', role: 'code' } }, documentation: { repository: 'game', path: 'docs' } },
      repositories: { game: { relative: 'project', role: 'code' } }, documentation: { relative: 'project/docs' }, projectRoots: {} } };
}
test('native adapters render bounded scoped requests and keep source bytes unchanged', async () => {
  const c = nativeContext(), before = structuredClone(c), names = new Set();
  for (const adapter of [codexAdapter, claudeAdapter]) {
    assertAdapter(adapter, adapter.id, c.pipeline.providers[adapter.id]);
    assert.deepEqual(await adapter.validate(c), { valid: true, runtime: 'not-run' });
    const requests = await adapter.plan(c);
    assert.deepEqual(await adapter.plan(c), requests);
    for (const request of requests) { assertRequestScope(request, c.workspace.providers); assert.ok(!names.has(request.path)); names.add(request.path); }
  }
  for (const request of await sharedAdapter.plan(c)) { assert.ok(!names.has(request.path)); names.add(request.path); }
  assert.deepEqual(structuredClone(c), before);
  assert.ok(names.has('CLAUDE.md')); assert.ok(names.has('AGENTS.md'));
});
test('skill routes resolve to exact source and preserve canonical relative links', async () => {
  const c = nativeContext();
  for (const adapter of [codexAdapter, claudeAdapter]) {
    const request = (await adapter.plan(c)).find(r => r.path.endsWith('/SKILL.md'));
    const link = /\]\(<([^>]+)>\)/.exec(request.bytes.toString())[1];
    const resolved = posix.normalize(posix.join(posix.dirname(request.path), link));
    assert.equal(resolved, c.snapshot.path + '/skills/sample-review/SKILL.md');
    assert.equal(posix.normalize(posix.join(posix.dirname(resolved), '../../resources/process.md')), c.snapshot.path + '/resources/process.md');
    assert.ok(request.bytes.toString().includes('grants no approval'));
  }
});
test('Codex combines named MCP and agent registration while preserving foreign TOML', async () => {
  const c = nativeContext(), requests = await codexAdapter.plan(c);
  const config = requests.find(r => r.path === '.codex/config.toml');
  assert.equal(config.fields.length, 2);
  const foreign = '# mine\r\nmodel="user-model"\r\n';
  const bytes = reconcileTOMLFields(Buffer.from(foreign), config.fields).bytes;
  assert.ok(bytes.toString().startsWith(foreign));
  assert.equal(readTOMLField(bytes, '/agents/sample-review').value.config_file, 'agents/sample-review.toml');
  assert.equal(readTOMLField(bytes, '/mcp_servers/sample-tool').value.command, 'never-executed');
  const agent = requests.find(r => r.path.endsWith('/sample-review.toml'));
  const value = getStaticTOMLValue(parseTOML(agent.bytes.toString()));
  assert.deepEqual(Object.keys(value), ['developer_instructions']);
  assert.ok(value.developer_instructions.includes('Review without editing'));
});
test('Claude uses common entry import and exact project MCP server fields', async () => {
  const c = nativeContext(), requests = await claudeAdapter.plan(c);
  assert.ok((await sharedAdapter.plan(c)).find(r => r.path === 'CLAUDE.md').bytes.toString().startsWith('@AGENTS.md\n'));
  assert.ok(!requests.some(r => r.path === 'CLAUDE.md'));
  const mcp = requests.find(r => r.path === '.mcp.json');
  assert.equal(mcp.kind, 'json-fields'); assert.equal(mcp.fields[0].pointer, '/mcpServers/sample-tool');
  assert.equal(mcp.fields[0].value.type, 'stdio');
  assert.ok(!requests.some(r => r.path.endsWith('settings.json') || r.path.endsWith('settings.local.json')));
});
test('malformed and unsupported skill metadata are rejected, never silently dropped', async () => {
  for (const input of ['no frontmatter', '---\nname: sample-review\ndescription: review\nmodel: fixed\n---\nBody',
    '---\nname: wrong\ndescription: review\n---\nBody', '---\nname: sample-review\ndescription: review\n---\n']) {
    const c = nativeContext(); c.files.set('skills/sample-review/SKILL.md', Buffer.from(input));
    await assert.rejects(codexAdapter.plan(c)); await assert.rejects(claudeAdapter.plan(c));
  }
  const c = nativeContext(); c.files.delete('skills/sample-review/SKILL.md');
  await assert.rejects(codexAdapter.plan(c), e => e.code === 'provider.source-missing');
});
test('Codex agent refuses model overrides, tables, poison keys and filename mismatch', async () => {
  for (const input of ['name="wrong"\ndescription="x"\ndeveloper_instructions="x"',
    'name="sample-review"\ndescription="x"\ndeveloper_instructions="x"\nmodel="other"',
    '[agent]\nname="sample-review"', '__proto__="x"\ndescription="x"\nname="sample-review"']) {
    const c = nativeContext(); c.files.set('codex-agents/sample-review.toml', Buffer.from(input));
    await assert.rejects(codexAdapter.plan(c));
  }
});
test('unsupported capability and unsafe MCP input fail closed', async () => {
  const c = nativeContext(); c.pipeline.providers.codex.requires = ['compatibility-isolation'];
  await assert.rejects(codexAdapter.plan(c), e => e.code === 'provider.unsupported');
  for (const server of [{ type: 'sse', url: 'https://example.invalid' }, { type: 'http', url: 'https://user:secret@example.invalid' },
    { type: 'http', url: 'file:///x' }, { type: 'stdio', command: 'x', autoApprove: true },
    { type: 'stdio', command: 'x', args: [1] }, { type: 'stdio', command: 'x', env: { BAD: 1 } }]) {
    const c = nativeContext(); c.files.set('mcp.json', Buffer.from(JSON.stringify({ mcpServers: { tool: server } })));
    for (const adapter of [codexAdapter, claudeAdapter]) await assert.rejects(adapter.plan(c));
  }
});
test('HTTP MCP translation and null components are explicit, without invocation', async () => {
  const c = nativeContext(); c.files.set('mcp.json', Buffer.from(JSON.stringify({ mcpServers: { tool: { type: 'http', url: 'http://127.0.0.1:9999/mcp' } } })));
  for (const adapter of [codexAdapter, claudeAdapter]) {
    const decl = c.pipeline.providers[adapter.id]; decl.skills = null; decl.agents = null; decl.entryInstructions = null;
    const requests = await adapter.plan(c), config = requests.find(r => r.fields);
    assert.equal(config.fields[0].value.url, 'http://127.0.0.1:9999/mcp');
    assert.equal(Object.hasOwn(config.fields[0].value, 'type'), adapter.id === 'claude');
  }
});
