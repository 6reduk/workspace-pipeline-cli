import test from 'node:test';
import assert from 'node:assert/strict';
import { sharedAdapter } from '../src/providers/shared.js';
import { sourceBytes, sourceText, snapshotResourcePath } from '../src/providers/source.js';
import { assertRequestScope } from '../src/operations/plan.js';

function fixture(multi = false) {
  const digest = 'sha256:' + 'a'.repeat(64);
  const repositories = multi ? { game: { path: 'game', role: 'code' }, docs: { path: 'knowledge', role: 'documentation' } }
    : { game: { path: 'project', role: 'code' } };
  const documentation = { repository: multi ? 'docs' : 'game', path: 'docs' };
  const layout = { kind: multi ? 'multi-repo' : 'single-repo', repositories, documentation };
  return { workspace: { providers: ['codex'] }, pipeline: { resources: 'resources' }, snapshot: { digest, path: '.pipeline/snapshots/' + digest.slice(7) },
    files: new Map([['resources/process.md', Buffer.from('Rules')], ['entry.md', Buffer.from('Docs: {{documentation}}; code: {{repository.game}}')]]),
    layout: { agentsDocument: { mode: 'default' }, layout,
      repositories: Object.fromEntries(Object.entries(repositories).map(([id, r]) => [id, { relative: r.path, role: r.role }])),
      documentation: { relative: repositories[documentation.repository].path + '/docs' },
      projectRoots: { unity: { relative: repositories.game.path + '/Game' } } } };
}

test('shared entry routes single and multi repo without private absolute paths', async () => {
  for (const multi of [false, true]) {
    const context = fixture(multi), before = structuredClone(context);
    const requests = await sharedAdapter.plan(context);
    assert.equal(requests.length, 1); assertRequestScope(requests[0], ['codex', 'claude']);
    const text = requests[0].bytes.toString();
    assert.ok(text.includes(multi ? 'knowledge/docs' : 'project/docs'));
    assert.ok(text.includes(multi ? 'game/Game' : 'project/Game'));
    assert.ok(text.includes(snapshotResourcePath(context)));
    assert.ok(text.includes('does not pin project documents'));
    assert.deepEqual(structuredClone(context), before);
    assert.deepEqual(await sharedAdapter.plan(context), requests);
  }
});
test('selected custom entry uses bounded existing layout substitutions', async () => {
  const context = fixture(true); context.layout.agentsDocument = { mode: 'source', path: 'entry.md' };
  assert.match((await sharedAdapter.plan(context))[0].bytes.toString(), /^Docs: knowledge\/docs; code: game/);
  context.files.set('entry.md', Buffer.from('{{unknown}}'));
  await assert.rejects(sharedAdapter.plan(context), e => e.code === 'entry.token');
});
test('entry and resources cannot fall back to the filesystem or a moving source', async () => {
  const context = fixture(); context.layout.agentsDocument = { mode: 'source', path: 'missing.md' };
  await assert.rejects(sharedAdapter.plan(context), e => e.code === 'provider.source-missing');
  context.layout.agentsDocument = { mode: 'default' };
  for (const replacement of ['../outside', '.pipeline/snapshots/latest']) {
    const c = fixture(); c.snapshot.path = replacement;
    await assert.rejects(sharedAdapter.plan(c), e => e.code === 'provider.snapshot');
  }
  context.files.delete('resources/process.md');
  await assert.rejects(sharedAdapter.plan(context), e => e.code === 'provider.resources');
});
test('verified source readers return copies and reject malformed UTF8 and traversal', () => {
  const c = fixture(), copy = sourceBytes(c, 'entry.md'); copy.fill(0);
  assert.notEqual(sourceText(c, 'entry.md').charCodeAt(0), 0);
  assert.throws(() => sourceBytes(c, '../entry.md'), e => e.code === 'path.invalid');
  c.files.set('broken.md', Buffer.from([0xff]));
  assert.throws(() => sourceText(c, 'broken.md'), e => e.code === 'source.utf8');
});
test('entry modes, resource traversal, oversized content and unknown references fail closed', async () => {
  const c = fixture(); c.layout.agentsDocument = { mode: 'other' };
  await assert.rejects(sharedAdapter.plan(c), e => e.code === 'entry.input');
  c.layout.agentsDocument = { mode: 'source', path: 'entry.md' };
  for (const text of ['{{repository.absent}}', 'x'.repeat(2 * 1024 * 1024 + 1)]) {
    c.files.set('entry.md', Buffer.from(text));
    await assert.rejects(sharedAdapter.plan(c));
  }
  c.layout.agentsDocument = { mode: 'default' }; c.pipeline.resources = '../resources';
  await assert.rejects(sharedAdapter.plan(c), e => e.code === 'path.invalid');
});
