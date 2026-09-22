import test from 'node:test';
import assert from 'node:assert/strict';
import { grokEnvironment, GROK_CLAUDE_PIPELINE_KEYS } from '../src/launch/grok.js';

test('Grok overlay changes only five child-process compatibility keys', () => {
  const parent = Object.freeze({ PATH: 'unchanged', GROK_HOME: 'existing-profile',
    XAI_API_KEY: 'synthetic-never-used', GROK_CLAUDE_SESSIONS_ENABLED: 'true',
    GROK_CURSOR_SKILLS_ENABLED: 'true', GROK_CLAUDE_SKILLS_ENABLED: 'true' });
  const child = grokEnvironment(parent, 'linux');
  for (const key of GROK_CLAUDE_PIPELINE_KEYS) assert.equal(child[key], 'false');
  for (const key of ['PATH', 'GROK_HOME', 'XAI_API_KEY', 'GROK_CLAUDE_SESSIONS_ENABLED', 'GROK_CURSOR_SKILLS_ENABLED']) assert.equal(child[key], parent[key]);
  assert.equal(parent.GROK_CLAUDE_SKILLS_ENABLED, 'true');
  assert.equal(Object.keys(child).length, Object.keys(parent).length + 4);
});
test('Grok Windows overlay removes conflicting environment key spellings', () => {
  const parent = { grok_claude_skills_enabled: 'true', Grok_Claude_Skills_Enabled: 'true',
    GROK_CLAUDE_SKILLS_ENABLED: 'true', Path: 'preserve-spelling' };
  const child = grokEnvironment(parent, 'win32');
  assert.deepEqual(Object.keys(child).filter(k => k.toUpperCase() === 'GROK_CLAUDE_SKILLS_ENABLED'), ['GROK_CLAUDE_SKILLS_ENABLED']);
  assert.equal(child.Path, 'preserve-spelling');
  assert.equal(parent.grok_claude_skills_enabled, 'true');
});
test('Grok POSIX overlay preserves unrelated differently cased keys', () => {
  const child = grokEnvironment({ grok_claude_skills_enabled: 'literal', EMPTY: '', ABSENT: undefined }, 'darwin');
  assert.equal(child.grok_claude_skills_enabled, 'literal');
  assert.equal(child.GROK_CLAUDE_SKILLS_ENABLED, 'false');
  assert.equal(child.EMPTY, ''); assert.equal(Object.hasOwn(child, 'ABSENT'), false);
});
test('Grok environment helper rejects invalid input and preserves process env', () => {
  const before = { ...process.env };
  grokEnvironment(process.env);
  assert.deepEqual({ ...process.env }, before);
  for (const value of [null, [], 'text']) assert.throws(() => grokEnvironment(value), /launch.environment/);
  assert.throws(() => grokEnvironment({}, 'unsupported'), /launch.platform/);
});
