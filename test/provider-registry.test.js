import test from 'node:test';
import assert from 'node:assert/strict';
import { providerRegistry } from '../src/providers/registry.js';
import { assertAdapter } from '../src/providers/interface.js';

test('public registry contains four immutable compiled adapters with bounded capabilities', () => {
  assert.deepEqual(Object.keys(providerRegistry.adapters).sort(), ['claude', 'codex', 'grok', 'kimi']);
  assert.ok(Object.isFrozen(providerRegistry));
  assert.ok(Object.isFrozen(providerRegistry.adapters));
  for (const [id, adapter] of Object.entries(providerRegistry.adapters)) {
    assertAdapter(adapter, id, { skills: 'skills', agents: 'agents', mcp: 'mcp.json', entryInstructions: 'entry.md', requires: [] });
    assert.ok(Object.isFrozen(adapter));
    assert.ok(!adapter.capabilities.includes('compatibility-isolation'));
  }
});
