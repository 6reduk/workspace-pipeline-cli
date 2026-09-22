import test from 'node:test';
import assert from 'node:assert/strict';
import { posix } from 'node:path';
import { kimiAdapter } from '../src/providers/kimi.js';
import { assertAdapter } from '../src/providers/interface.js';
import { assertRequestScope } from '../src/operations/plan.js';

function fixture() {
  const digest = 'sha256:' + 'c'.repeat(64);
  const files = new Map(Object.entries({
    'skills/sample-review/SKILL.md': '---\nname: sample-review\ndescription: Review only\n---\nRead the source rules.\n',
    'agents/sample-review.md': '---\nname: sample-review\ndescription: Review only\n---\nDo not edit production.\n',
    'entry.md': 'Follow the common workflow.',
    'resources/rules.md': 'Require actual approval.',
    'mcp.json': JSON.stringify({ mcpServers: {
      local: { type: 'stdio', command: 'never-executed', args: ['--test'] },
      remote: { type: 'http', url: 'https://example.invalid/mcp' },
    } }),
  }).map(([name, body]) => [name, Buffer.from(body)]));
  return { files, snapshot: { digest, path: '.pipeline/snapshots/' + digest.slice(7) },
    pipeline: { resources: 'resources', providers: { kimi: {
      skills: 'skills', agents: 'agents', mcp: 'mcp.json', entryInstructions: 'entry.md', requires: [],
    } } } };
}

test('Kimi renders deterministic owned files without changing source or creating global settings', async () => {
  const context = fixture(), before = structuredClone(context);
  assertAdapter(kimiAdapter, 'kimi', context.pipeline.providers.kimi);
  const requests = await kimiAdapter.plan(context);
  assert.deepEqual(requests, await kimiAdapter.plan(context));
  assert.deepEqual(structuredClone(context), before);
  assert.deepEqual(requests.map(r => r.path), [
    '.kimi-code/skills/sample-review/SKILL.md', '.kimi-code/agents/sample-review.md', '.kimi-code/mcp.json',
  ]);
  for (const r of requests) assertRequestScope(r, ['kimi']);
  assert.deepEqual(await kimiAdapter.validate(context), { valid: true, runtime: 'not-run' });
});

test('Kimi routes skills and agents to immutable source locations', async () => {
  const context = fixture();
  for (const r of (await kimiAdapter.plan(context)).filter(r => r.kind === 'file')) {
    const target = /\]\(<([^>]+)>\)/.exec(r.bytes.toString())[1];
    const source = r.path.endsWith('SKILL.md') ? 'skills/sample-review/SKILL.md' : 'agents/sample-review.md';
    assert.equal(posix.normalize(posix.join(posix.dirname(r.path), target)), context.snapshot.path + '/' + source);
    assert.match(r.bytes.toString(), /grants no approval/);
  }
});

test('Kimi MCP translation emits named JSON fields, without canonical transport tags', async () => {
  const r = (await kimiAdapter.plan(fixture())).find(r => r.kind === 'json-fields');
  assert.deepEqual(r.fields.map(f => f.pointer), ['/mcpServers/local', '/mcpServers/remote']);
  assert.equal(r.fields[0].value.command, 'never-executed');
  assert.equal(r.fields[1].value.url, 'https://example.invalid/mcp');
  assert.ok(r.fields.every(f => !Object.hasOwn(f.value, 'type')));
});

test('Kimi rejects builtin agent collisions and metadata overrides', async () => {
  for (const name of ['agent', 'coder', 'explore', 'plan']) {
    const c = fixture(); c.files.delete('agents/sample-review.md');
    c.files.set(`agents/${name}.md`, Buffer.from(`---\nname: ${name}\ndescription: x\n---\nBody`));
    await assert.rejects(kimiAdapter.plan(c), e => e.code === 'provider.name');
  }
  const c = fixture(); c.files.set('agents/sample-review.md', Buffer.from(
    '---\nname: sample-review\ndescription: x\noverride: true\n---\nBody'));
  await assert.rejects(kimiAdapter.plan(c), e => e.code === 'provider.format');
});

test('Kimi does not invent agents or claim compatibility isolation', async () => {
  const c = fixture(); c.pipeline.providers.kimi.agents = null;
  assert.ok(!(await kimiAdapter.plan(c)).some(r => r.path.includes('/agents/')));
  c.pipeline.providers.kimi.requires = ['compatibility-isolation'];
  await assert.rejects(kimiAdapter.plan(c), e => e.code === 'provider.unsupported');
});

test('Kimi rejects unsafe MCP, missing source and invalid snapshot', async () => {
  const c = fixture(); c.files.set('mcp.json', Buffer.from(JSON.stringify({ mcpServers: {
    tool: { type: 'http', url: 'https://user:secret@example.invalid' },
  } })));
  await assert.rejects(kimiAdapter.plan(c), e => e.code === 'provider.mcp');
  const missing = fixture(); missing.files.delete('entry.md');
  await assert.rejects(kimiAdapter.plan(missing), e => e.code === 'provider.source-missing');
  const invalid = fixture(); invalid.snapshot.path = '../other';
  await assert.rejects(kimiAdapter.plan(invalid), e => e.code === 'provider.snapshot');
});

test('Kimi MCP ownership cannot replace the whole file or the server collection', () => {
  assert.throws(() => assertRequestScope({ owner: 'kimi', path: '.kimi-code/mcp.json', kind: 'file', bytes: Buffer.from('{}') }, ['kimi']), e => e.code === 'plan.scope');
  for (const pointer of ['/mcpServers', '/other', '/mcpServers/tool/command']) {
    assert.throws(() => assertRequestScope({ owner: 'kimi', path: '.kimi-code/mcp.json', kind: 'json-fields',
      fields: [{ pointer, present: true, value: {} }] }, ['kimi']), e => e.code === 'plan.scope');
  }
});
