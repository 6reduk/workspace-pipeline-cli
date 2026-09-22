import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { planRepositoryIntents } from '../src/workspace/repositories.js';

const source = { type:'git', transport:'local', path:'pipeline', ref:'HEAD', subdirectory:'.' };
const pipeline = { schemaVersion:1, id:'example', version:'1.0.0', resources:'resources', inventory:'inventory.json',
  providers:{ codex:{skills:'skills',agents:null,mcp:null,entryInstructions:null,requires:[]} }, agentsDocument:{mode:'default'} };
const workspace = { schemaVersion:1, pipeline:source, providers:['codex'], layout:{kind:'single-repo',
  repositories:{game:{path:'project',role:'code',source}}, documentation:{repository:'game',path:'docs'},
  projectRoots:{unity:{repository:'game',path:'Game'}}} };
const root = path.join(tmpdir(), 'wpc-s7-planned-wrapper');
const plan = (choices, options = {}) => planRepositoryIntents(pipeline, workspace, root, choices, {command:'adopt',...options});
const rejects = (fn, code) => assert.throws(fn, error => error.code === code);

test('S7 explicit choices never infer clone from manifest; plan is not execution authority', () => {
  const before = JSON.stringify(workspace);
  for (const action of ['keep','directory','init','clone']) {
    const result = plan({game:{action}});
    assert.equal(result.operations[0].action, action);
    assert.equal(result.executionAuthorized, false);
    assert.equal(result.filesystem, 'not-inspected');
    assert.equal(result.layout.projectRoots.unity.path, path.join(root,'project','Game'));
    if (action === 'clone') result.operations[0].source.ref = 'changed';
    else assert.equal(result.operations[0].source, undefined);
  }
  assert.equal(JSON.stringify(workspace), before);
});
test('S7 exact selection and action fields required', () => {
  rejects(() => plan({}), 'repositories.selection');
  rejects(() => plan({game:{action:'keep'},foreign:{action:'init'}}), 'repositories.selection');
  rejects(() => plan({game:{action:'keep',from:root}}), 'repositories.fields');
  rejects(() => plan({game:{action:'delete'}}), 'repositories.action');
  rejects(() => plan({game:{action:'keep'}},{command:'setup'}), 'repositories.command');
});
test('S7 clone requires declared Git source', () => {
  const w = structuredClone(workspace); delete w.layout.repositories.game.source;
  rejects(() => planRepositoryIntents(pipeline,w,root,{game:{action:'clone'}},{command:'init'}), 'repositories.clone-source');
});
test('S7 wrap alias records explicit external move, but init rejects it', () => {
  const choices = {game:{action:'move',from:path.join(tmpdir(),'existing-game')}};
  assert.equal(plan(choices,{command:'wrap'}).command,'adopt');
  assert.equal(plan(choices).operations[0].from, choices.game.from);
  rejects(() => plan(choices,{command:'init'}), 'repositories.move-command');
});
test('S7 refuses wrapper/ancestor moves and overlapping destinations', () => {
  for (const from of [root,path.dirname(root)])
    rejects(() => plan({game:{action:'move',from}}), 'repositories.wrapper-source');
  for (const from of [path.join(root,'project'),path.join(root,'PROJECT','nested')])
    rejects(() => plan({game:{action:'move',from}}), 'repositories.overlap');
});
test('S7 multi repository deterministic ordering and overlapping sources rejected', () => {
  const w = structuredClone(workspace); w.layout.kind='multi-repo';
  w.layout.repositories.docs={path:'knowledge',role:'documentation'};
  w.layout.documentation={repository:'docs',path:'.'};
  const choices={game:{action:'keep'},docs:{action:'init'}};
  const result=planRepositoryIntents(pipeline,w,root,choices,{command:'adopt'});
  assert.deepEqual(result.operations.map(o=>o.repository),['docs','game']);
  choices.docs={action:'move',from:path.join(tmpdir(),'existing-docs')};
  choices.game={action:'move',from:path.join(tmpdir(),'existing-docs','child')};
  rejects(() => planRepositoryIntents(pipeline,w,root,choices,{command:'adopt'}), 'repositories.overlap');
});
