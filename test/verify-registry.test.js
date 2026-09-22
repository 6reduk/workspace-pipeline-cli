import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyRegistry } from '../scripts/verify-registry.mjs';

const metadata = { name: '@6reduk/workspace-pipeline', version: '0.2.0', dist: { integrity: 'sha512-test' } };
function fixture(statuses, body = metadata) {
  const calls = []; const waits = [];
  return { calls, waits, options: {
    attempts: 3, log() {}, sleep: async ms => { waits.push(ms); },
    fetchImpl: async (url, options) => {
      calls.push(url); assert.ok(options.signal);
      return new Response(JSON.stringify(body), { status: statuses.shift() });
    },
  } };
}
test('registry propagation retries 404 then validates exact metadata', async () => {
  const f = fixture([404, 404, 200]);
  await verifyRegistry('0.2.0', 'sha512-test', f.options);
  assert.equal(f.calls.length, 3); assert.equal(f.waits.length, 2);
});
test('registry absence has a finite retry budget', async () => {
  const f = fixture([404, 404, 404]);
  await assert.rejects(verifyRegistry('0.2.0', 'sha512-test', f.options), /after 3 attempts/);
  assert.equal(f.calls.length, 3); assert.equal(f.waits.length, 2);
});
for (const status of [401, 403, 429, 500]) test(`HTTP ${status} fails without retry`, async () => {
  const f = fixture([status]);
  await assert.rejects(verifyRegistry('0.2.0', 'sha512-test', f.options), /refusing retry/);
  assert.equal(f.calls.length, 1); assert.equal(f.waits.length, 0);
});
for (const body of [{ ...metadata, version: '0.1.0' }, { ...metadata, name: 'foreign' },
  { ...metadata, dist: { integrity: 'different' } }]) test('metadata mismatch fails immediately', async () => {
  const f = fixture([200], body);
  await assert.rejects(verifyRegistry('0.2.0', 'sha512-test', f.options), /mismatch/);
  assert.equal(f.calls.length, 1); assert.equal(f.waits.length, 0);
});
test('network failure is not hidden as propagation', async () => {
  await assert.rejects(verifyRegistry('0.2.0', 'sha512-test', {
    fetchImpl: async () => { throw Error('network unavailable'); },
  }), /network unavailable/);
});
