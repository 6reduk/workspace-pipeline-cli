import test from 'node:test';
import assert from 'node:assert/strict';
import { posix } from 'node:path';
import { grokAdapter } from '../src/providers/grok.js';
import { assertAdapter } from '../src/providers/interface.js';
import { assertRequestScope } from '../src/operations/plan.js';
import { reconcileConfigFields, readConfigField } from '../src/operations/config-fields.js';
import { contractDigest } from '../src/contracts/semantic.js';

function fixture() {
  const digest = 'sha256:' + 'd'.repeat(64);
  return { snapshot: { digest, path: '.pipeline/snapshots/' + digest.slice(7) },
    pipeline: { resources: 'resources', providers: { grok: {
      skills: 'skills', agents: 'agents', mcp: 'mcp.json', entryInstructions: 'entry.md', requires: [],
    } } }, files: new Map(Object.entries({
      'skills/sample-review/SKILL.md': '---\nname: sample-review\ndescription: Review only\n---\nRead rules.\n',
      'agents/sample-review.md': '---\nname: sample-review\ndescription: Review only\n---\nRead rules.\n',
      'entry.md': 'Follow common pipeline.', 'resources/rules.md': 'Approval required.',
      'mcp.json': JSON.stringify({ mcpServers: { local: { type: 'stdio', command: 'never-executed', args: ['--test'] },
        remote: { type: 'http', url: 'https://example.invalid/mcp' } } }),
    }).map(([name, text]) => [name, Buffer.from(text)])) };
}
test('Grok renders bounded native components with immutable routing, not a plugin', async () => {
  const c = fixture(), before = structuredClone(c);
  assertAdapter(grokAdapter, 'grok', c.pipeline.providers.grok);
  const requests = await grokAdapter.plan(c);
  assert.deepEqual(await grokAdapter.plan(c), requests);
  assert.deepEqual(structuredClone(c), before);
  assert.deepEqual(requests.map(r => r.path), ['.grok/skills/sample-review/SKILL.md', '.grok/agents/sample-review.md', '.grok/config.toml']);
  for (const r of requests) {
    assertRequestScope(r, ['grok']);
    if (r.kind !== 'file') continue;
    const relative = /\]\(<([^>]+)>\)/.exec(r.bytes.toString())[1];
    assert.equal(posix.normalize(posix.join(posix.dirname(r.path), relative)), c.snapshot.path + '/' + r.path.slice('.grok/'.length));
    assert.match(r.bytes.toString(), /grants no approval/);
  }
  assert.deepEqual(await grokAdapter.validate(c), { valid: true, runtime: 'not-run' });
});
test('Grok MCP uses TOML codec and restores foreign bytes after removal', async () => {
  const config = (await grokAdapter.plan(fixture())).find(r => r.kind === 'toml-fields');
  const original = Buffer.from('# personal\r\n[models]\r\ndefault="user-selected"\r\n[mcp_servers.foreign]\r\ncommand="user-owned"\r\n');
  const added = reconcileConfigFields(config.path, original, config.fields).bytes;
  assert.ok(added.toString().startsWith(original.toString()));
  assert.equal(readConfigField(config.path, added, '/mcp_servers/local').value.command, 'never-executed');
  assert.equal(readConfigField(config.path, added, '/mcp_servers/remote').value.url, 'https://example.invalid/mcp');
  assert.ok(config.fields.every(f => !Object.hasOwn(f.value, 'type')));
  const removals = config.fields.map(f => ({ pointer: f.pointer, present: false, managedHash: contractDigest(f.value) }));
  assert.deepEqual(reconcileConfigFields(config.path, added, removals).bytes, original);
});
test('Grok refuses whole config replacement, unrelated fields and alternate codecs', () => {
  const base = { owner: 'grok', path: '.grok/config.toml', kind: 'toml-fields' };
  for (const pointer of ['/models/default', '/compat/claude/skills', '/mcp_servers', '/mcp_servers/a/command']) {
    assert.throws(() => assertRequestScope({ ...base, fields: [{ pointer, present: true, value: 'x' }] }, ['grok']), e => e.code === 'plan.scope');
  }
  assert.throws(() => assertRequestScope({ ...base, kind: 'file', bytes: Buffer.from('') }, ['grok']), e => e.code === 'plan.scope');
  assert.throws(() => assertRequestScope({ ...base, kind: 'json-fields', fields: [{ pointer: '/mcp_servers/tool', present: true, value: {} }] }, ['grok']), e => e.code === 'plan.scope');
  assert.throws(() => assertRequestScope({ ...base, path: '.grok/other.toml', fields: [] }, ['grok']));
});
test('Grok refuses builtin agent shadowing and unsupported compatibility claim', async () => {
  for (const name of ['general-purpose', 'explore', 'plan']) {
    const c = fixture(); c.files.delete('agents/sample-review.md');
    c.files.set(`agents/${name}.md`, Buffer.from(`---\nname: ${name}\ndescription: x\n---\nBody`));
    await assert.rejects(grokAdapter.plan(c), e => e.code === 'provider.name');
  }
  const c = fixture(); c.pipeline.providers.grok.requires = ['compatibility-isolation'];
  await assert.rejects(grokAdapter.plan(c), e => e.code === 'provider.unsupported');
});
test('Grok rejects unsafe MCP, source overrides and forged snapshot', async () => {
  const c = fixture(); c.files.set('mcp.json', Buffer.from('{"mcpServers":{"tool":{"type":"stdio","command":"x","autoApprove":true}}}'));
  await assert.rejects(grokAdapter.plan(c), e => e.code === 'provider.format');
  const override = fixture(); override.files.set('agents/sample-review.md', Buffer.from('---\nname: sample-review\ndescription: x\nmodel: other\n---\nBody'));
  await assert.rejects(grokAdapter.plan(override), e => e.code === 'provider.format');
  const bad = fixture(); bad.snapshot.path = '../other';
  await assert.rejects(grokAdapter.plan(bad), e => e.code === 'provider.snapshot');
});
