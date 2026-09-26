import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {desiredArguments,initialDescriptor} from '../src/commands/desired-setup.js';

const workspace=path.resolve('fixture-workspace');
const make=flags=>initialDescriptor(workspace,desiredArguments(['setup','--workspace',workspace,...flags]));
test('desired-state commands reject the legacy network flag instead of silently ignoring it',()=>{
  for(const verb of ['setup','update','reset'])
    assert.throws(()=>desiredArguments([verb,'--workspace',workspace,'--network']),e=>e.code==='cli.arguments');
});
test('initial setup accepts local Git and explicitly defaults single repository layout',()=>{
  const d=make(['--source',path.resolve('fixture-source'),'--adapters','codex,claude-grok']);
  assert.equal(d.pipeline.path,'../fixture-source');assert.equal(d.pipeline.ref,'HEAD');
  assert.deepEqual([...d.adapters],['codex','claude-grok']);
  assert.equal(d.layout.repositories.game.path,'project');assert.equal(d.layout.documentation.path,'docs');
});
test('remote setup supports multi repository bindings without cloning them',()=>{
  const d=make(['--source','https://example.com/pipeline.git','--ref','main','--subdirectory','pipelines/shared',
    '--adapters','codex','--repository','api=services/api','--repository','docs=knowledge','--documentation','docs=.']);
  assert.equal(d.pipeline.transport,'remote');assert.equal(d.layout.kind,'multi-repo');
  assert.equal(d.layout.documentation.repository,'docs');assert.equal(d.layout.documentation.path,'.');
});
test('ambiguous, reserved and malformed setup arguments reject',()=>{
  const base=['--source','../source','--adapters','codex'];
  for(const extra of [['--repository','a=one','--repository','b=two'],['--repository','a=one','--repository','a=two'],
    ['--repository','a=workspace.json'],['--repository','a=.pipeline'],['--repository','missing-equals'],
    ['--documentation','unknown=docs'],['--adapters','claude'],['--yes','--yes']])assert.throws(()=>make([...base,...extra]));
  assert.throws(()=>make(['--source','../source']));
  assert.throws(()=>make(['--source','https://user:secret@example.com/repo','--adapters','codex']));
});
