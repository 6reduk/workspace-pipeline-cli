import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, MAX_INPUT_BYTES, ContractError } from '../src/contracts/parse.js';
import { validateStructure } from '../src/contracts/validate.js';
import { validateBundle, validateInventory, renderEntry, resolveEntryChange, validateState,
  validateOperation, validateReceiptForPlan, contractDigest, validateTransition } from '../src/contracts/semantic.js';
import { providerDouble } from './fixtures/provider-double.js';

const hash = 'sha256:' + 'a'.repeat(64), other = 'sha256:' + 'b'.repeat(64);
const clone = structuredClone;
const source = { type: 'git', transport: 'local', path: '../source', ref: 'main', subdirectory: '.' };
const layout = { kind: 'single-repo', repositories: { game: { path: 'project', role: 'code' } },
  documentation: { repository: 'game', path: 'docs' }, projectRoots: { unity: { repository: 'game', path: 'Game' } } };
const decl = { skills: 'providers/codex/skills', agents: null, mcp: null, entryInstructions: null, requires: [] };
const pipeline = { schemaVersion: 1, id: 'example', version: '1.0.0', resources: 'resources',
  providers: { codex: decl }, agentsDocument: { mode: 'default' }, inventory: 'inventory.json',
  workspaceProfiles: { unity: layout } };
const workspace = { schemaVersion: 1, pipeline: source, providers: ['codex'], layout };
const adapters = { codex: providerDouble('codex') };
const snapshot = { source, commit: 'a'.repeat(40), path: '.pipeline/snapshots/a', digest: hash,
  inventoryDigest: hash, origin: { path: 'C:/ws/workspace.yaml', base: 'C:/ws', digest: hash, resolvedSource: 'C:/source' } };
const owned = { path: 'AGENTS.md', kind: 'file', pointer: null, owner: 'shared',
  beforeHash: null, managedHash: hash, backup: null };
const deployment = { id: 'install-1', pipelineId: 'example', version: '1.0.0', snapshot, layout,
  providers: ['codex'], adapterVersions: { codex: 'test-double-1' }, owned: [owned] };
const state = { schemaVersion: 1, workspace: 'C:/ws', status: 'ready', runtime: 'not-run',
  active: deployment, pending: null };
const target = { id: 'op-1', path: 'AGENTS.md', action: 'create', owner: 'shared',
  beforeHash: null, desiredHash: hash, fields: [] };
const plan = { schemaVersion: 1, kind: 'plan', workspace: 'C:/ws', command: 'setup',
  beforeStateHash: null, source: snapshot, desired: deployment, targets: [target] };
const receipt = { schemaVersion: 1, kind: 'receipt', planDigest: contractDigest(plan), status: 'completed',
  operations: [{ operationId: 'op-1', status: 'completed', beforeHash: null, desiredHash: hash, observedHash: hash }] };
const rejected = f => assert.throws(f, e => e instanceof ContractError);
test('state activation is optional strict operational metadata',()=>{
  validateState(state);
  const activation={recovery:'.pipeline/transactions/00000000-0000-0000-0000-000000000000/recovery.json',recoveryHash:hash,journalHead:{sequence:3,hash}};
  validateState({...state,activation});
  for(const change of [{recovery:'../escape'},{recoveryHash:'bad'},{extra:true},{journalHead:{sequence:0,hash}},{journalHead:{sequence:3,hash,extra:true}}])
    rejected(()=>validateState({...state,activation:{...activation,...change}}));
});
test('absence readback is removal-only with null hashes and no fields',()=>{
  const removal={...plan,command:'remove',desired:null,targets:[{...target,action:'verify-absent',desiredHash:null}]};
  validateOperation(removal);
  for(const change of [{beforeHash:hash},{desiredHash:hash},{fields:[{pointer:'/x',beforeHash:null,desiredHash:null}]}])
    rejected(()=>validateOperation({...removal,targets:[{...removal.targets[0],...change}]}));
  rejected(()=>validateOperation({...removal,command:'repair',desired:deployment}));
});
for (const [label, text, format] of [
  ['JSON duplicate', '{"x":1,"x":2}', 'json'],
  ['JSON escaped duplicate', '{"x":1,"\\u0078":2}', 'json'],
  ['nested duplicate', '{"x":{"a":1,"a":2}}', 'json'],
  ['YAML duplicate', 'x: 1\nx: 2', 'yaml'],
  ['alias', 'x: &a [1]\ny: *a', 'yaml'],
  ['custom tag', 'x: !evil abc', 'yaml'],
  ['explicit tag', 'x: !!str abc', 'yaml'],
  ['complex key', '? [x, y]\n: 1', 'yaml'],
  ['numeric key', '1: abc', 'yaml'],
  ['prototype', '{"__proto__": {"pwn": true}}', 'json'],
  ['merge', '<<: {x: 1}', 'yaml'],
  ['multiple docs', 'x: 1\n---\ny: 2', 'yaml'],
  ['yaml11', '%YAML 1.1\n---\nx: yes', 'yaml'],
  ['infinity', 'x: .inf', 'yaml'],
  ['unsafe integer', '{"x":9007199254740993}', 'json'],
  ['JSON trailing comma', '{"x":1,}', 'json'],
  ['JSON comment', '{"x":1/*no*/}', 'json'],
  ['depth', '['.repeat(66) + '0' + ']'.repeat(66), 'json'],
  ['size', ' '.repeat(MAX_INPUT_BYTES + 1), 'yaml']
]) test('parser rejects ' + label, () => rejected(() => parse(text, format)));

test('parse UTF8 BOM/CRLF + YAML/JSON equality', () => {
  const a = parse('\ufeff{"x":"Привет","yes":true}', 'json');
  const b = parse('x: Привет\r\nyes: true\r\n');
  assert.deepEqual(a, b); assert.equal(Object.getPrototypeOf(a), null);
});
test('parser errors do not echo source secret', () => {
  try { parse('x: !evil SECRET'); assert.fail(); }
  catch (e) { assert.equal(e instanceof ContractError, true); assert.ok(!e.message.includes('SECRET')); }
});
test('schema validator no mutation/coercion', () => {
  const w = clone(workspace), before = clone(w);
  validateStructure('workspace', w); assert.deepEqual(w, before);
  w.schemaVersion = '1'; rejected(() => validateStructure('workspace', w));
});
test('schema rejects unknown kind and fields', () => {
  rejected(() => validateStructure('unknown', {}));
  rejected(() => validateStructure('workspace', { ...workspace, hooks: [] }));
});
test('SEM-01 valid inferred skill + behavioural isolation', () => {
  const p = clone(pipeline); p.providers.codex.requires = ['compatibility-isolation'];
  assert.deepEqual(validateBundle(p, workspace, adapters).layout, layout);
});
for (const [label, change] of [
  ['required null', p => p.providers.codex.requires.push('mcp')],
  ['empty', p => p.providers.codex.skills = null],
  ['unsafe component path', p => p.providers.codex.skills = 'providers/nul.txt'],
  ['unknown docs repo', p => p.workspaceProfiles.unity.documentation.repository = 'missing']
]) test('SEM rejects ' + label, () => { const p = clone(pipeline); change(p); rejected(() => validateBundle(p, workspace, adapters)); });
test('SEM inferred missing adapter capability', () => {
  rejected(() => validateBundle(pipeline, workspace, { codex: { ...adapters.codex, capabilities: [] } }));
});
test('SEM adapter interface', () => {
  rejected(() => validateBundle(pipeline, workspace, {}));
  rejected(() => validateBundle(pipeline, workspace, { codex: { ...adapters.codex, plan: null } }));
});
test('SEM provider absent', () => rejected(() => validateBundle(pipeline, { ...workspace, providers: ['kimi'] })));
test('profile selection and entry override', () => {
  const w = clone(workspace); delete w.layout; w.profile = 'unity'; w.agentsDocument = { mode: 'source', path: 'entry.md' };
  const result = validateBundle(pipeline, w); assert.deepEqual(result.layout, layout);
  assert.equal(result.agentsDocument.path, 'entry.md');
  w.profile = 'missing'; rejected(() => validateBundle(pipeline, w));
});
test('layout and profile cannot merge', () => rejected(() => validateBundle(pipeline, { ...workspace, profile: 'unity' })));
test('repository clone subdir must dot', () => {
  const w = clone(workspace); w.layout.repositories.game.source = { ...source, subdirectory: 'package' };
  rejected(() => validateBundle(pipeline, w));
});
test('ENTRY-01 known tokens', () => assert.equal(renderEntry('{{repository.game}} {{documentation}}', layout), 'project project/docs'));
for (const text of ['{{repository.missing}}', '{{unknown}}', '{{documentation.foo}}', '{{documentation', '{{{{documentation}}}}'])
  test('ENTRY rejects ' + text, () => rejected(() => renderEntry(text, layout)));
test('ENTRY foreign content decisions', () => {
  assert.equal(resolveEntryChange(null, 'new', null, null), 'create');
  assert.equal(resolveEntryChange('old', 'new', null, hash, 'preserve'), 'preserve');
  assert.equal(resolveEntryChange('old', 'new', hash, hash), 'replace');
  rejected(() => resolveEntryChange('old', 'new', hash, other));
  rejected(() => resolveEntryChange('old', 'new', null, hash));
  assert.equal(resolveEntryChange('old', 'new', null, hash, 'replace'), 'replace');
});
test('INV-01 valid dot file + manifest', () => validateInventory({ 'pipeline.yaml': hash, 'providers/.mcp.json': hash },
  { inventoryPath: 'inventory.json', manifestPath: 'pipeline.yaml' }));
for (const [label, entries] of [
  ['self', { 'pipeline.yaml': hash, 'inventory.json': hash }],
  ['missing manifest', { 'x': hash }],
  ['case', { 'pipeline.yaml': hash, 'A': hash, 'a': hash }],
  ['dot', { 'pipeline.yaml': hash, 'a.': hash }],
  ['space', { 'pipeline.yaml': hash, 'a ': hash }],
  ['traversal', { 'pipeline.yaml': hash, '../a': hash }],
  ['git metadata', { 'pipeline.yaml': hash, '.git/config': hash }],
  ['uppercase hash', { 'pipeline.yaml': 'sha256:' + 'A'.repeat(64) }]
]) test('INV rejects ' + label, () => rejected(() => validateInventory(entries, { inventoryPath: 'inventory.json', manifestPath: 'pipeline.yaml' })));
test('INV total cap includes inventory', () => {
  const entries = Object.fromEntries(Array.from({ length: 9999 }, (_, i) => ['f' + i, hash]));
  validateStructure('inventory', entries); entries.extra = hash;
  rejected(() => validateStructure('inventory', entries));
});
test('state valid and version not task gate', () => { validateState(state); const s = clone(state); s.active.version = '9.0.0'; validateState(s); });
for (const [label, change] of [
  ['ready pending', s => s.pending = hash], ['ready no active', s => s.active = null],
  ['not-installed active', s => s.status = 'not-installed'],
  ['relative workspace', s => s.workspace = 'relative'],
  ['missing adapter version', s => s.active.adapterVersions = {}],
  ['foreign owner', s => s.active.owned[0].owner = 'kimi'],
  ['field missing pointer', s => s.active.owned[0].kind = 'field'],
  ['file with pointer', s => s.active.owned[0].pointer = '/x'],
  ['duplicate ownership', s => s.active.owned.push(clone(s.active.owned[0]))],
  ['backup escape', s => s.active.owned[0].backup = '../backup'],
  ['origin base relative', s => s.active.snapshot.origin.base = '../source']
]) test('state rejects ' + label, () => { const s = clone(state); change(s); rejected(() => validateState(s)); });
test('state allows independent owned fields but not ancestor overlap', () => {
  const s = clone(state); s.active.owned = ['/a', '/b'].map(pointer => ({ ...owned, kind: 'field', pointer }));
  validateState(s); s.active.owned[1].pointer = '/a/b'; rejected(() => validateState(s));
});
test('plan and exact receipt', () => validateReceiptForPlan(receipt, plan));
for (const [label, change] of [
  ['duplicate id', p => p.targets.push({ ...target, path: 'OTHER.md' })],
  ['duplicate path', p => p.targets.push({ ...target, id: 'op2' })],
  ['create before exists', p => p.targets[0].beforeHash = hash],
  ['source mismatch', p => p.source = { ...p.source, digest: other }],
  ['no deployment', p => p.desired = null],
  ['field set on file', p => p.targets[0].fields.push({ pointer: '/a', beforeHash: null, desiredHash: hash })]
]) test('plan rejects ' + label, () => { const p = clone(plan); change(p); rejected(() => validateOperation(p)); });
test('receipt rejects lost coverage / stale plan / false readback', () => {
  rejected(() => validateReceiptForPlan({ ...receipt, planDigest: other }, plan));
  rejected(() => validateReceiptForPlan({ ...receipt, operations: [] }, plan));
  const r = clone(receipt); r.operations[0].observedHash = other; rejected(() => validateOperation(r));
});
test('receipt stop-on-error ordering, failed/uncertain distinctions', () => {
  const r = clone(receipt); r.status = 'uncertain'; r.operations[0].status = 'uncertain';
  r.operations[0].observedHash = null; validateOperation(r);
  r.operations.push({ ...receipt.operations[0], operationId: 'op2' }); rejected(() => validateOperation(r));
  r.operations[1].status = 'skipped'; validateOperation(r);
  r.status = 'failed'; r.operations[0].status = 'failed'; validateOperation(r);
  r.operations[0].observedHash = other; rejected(() => validateOperation(r));
});

test('lifecycle completed setup / partial setup cannot become ready', () => {
  validateTransition(null, state, plan, receipt);
  const r = clone(receipt); r.status = 'uncertain'; r.operations[0].status = 'uncertain';
  r.operations[0].observedHash = null;
  rejected(() => validateTransition(null, state, plan, r));
  const next = { ...state, status: 'needs-reconciliation', active: null, pending: contractDigest(plan) };
  validateTransition(null, next, plan, r);
});
test('lifecycle before-state and runtime cannot be fabricated', () => {
  rejected(() => validateTransition(state, state, plan, receipt));
  rejected(() => validateTransition(null, { ...state, runtime: 'pass' }, plan, receipt));
  const next = clone(state); next.active.version = '2.0.0';
  rejected(() => validateTransition(null, next, plan, receipt));
});
test('lifecycle remove uses actual before-state and null desired', () => {
  const p = { ...plan, command: 'remove', beforeStateHash: contractDigest(state), source: null,
    desired: null, targets: [{ ...target, action: 'delete', beforeHash: hash, desiredHash: null }] };
  const r = { ...receipt, planDigest: contractDigest(p),
    operations: [{ ...receipt.operations[0], beforeHash: hash, desiredHash: null, observedHash: null }] };
  validateTransition(state, { ...state, active: null, status: 'not-installed' }, p, r);
});
test('canonical digest is order-independent for object keys, not arrays', () => {
  assert.equal(contractDigest({ a: 1, b: 2 }), contractDigest({ b: 2, a: 1 }));
  assert.notEqual(contractDigest([1, 2]), contractDigest([2, 1]));
});
test('overwritten ownership requires a local backup', () => {
  const s = clone(state); s.active.owned[0].beforeHash = other;
  rejected(() => validateState(s));
  s.active.owned[0].backup = '.pipeline/backups/one'; validateState(s);
  s.active.owned[0].backup = 'project/backup'; rejected(() => validateState(s));
});

for (const char of ['\u0085', '\ufeff', '\u2028', '\u2029', '\\\\'])
  test('portable schema URL rejection ' + JSON.stringify(char), () => {
    const w = clone(workspace);
    w.pipeline = { type: 'git', transport: 'remote', url: 'https://host/repo' + char + '.git',
      ref: 'main', subdirectory: '.' };
    rejected(() => validateStructure('workspace', w));
  });
for (const version of ['1.0.0-.', '1.0.0-..', '1.0.0-01', '1.0.0-alpha..1', '1.0.0+build'])
  test('portable schema prerelease rejection ' + version, () => {
    rejected(() => validateStructure('pipeline', { ...pipeline, version }));
  });
test('parser node limit bounds flat documents', () => {
  rejected(() => parse(JSON.stringify(Array(50001).fill(null)), 'json'));
});
test('state and operation reject unsupported schema versions', () => {
  rejected(() => validateState({ ...state, schemaVersion: 999 }));
  rejected(() => validateOperation({ ...plan, schemaVersion: 999 }));
});

const errorCode = (fn, code) => assert.throws(fn, e => e instanceof ContractError && e.code === code);
for (const text of ['!!str x: 1', '? !!str "x"\n: 1', 'outer:\n  !!str x: 1'])
  test('R1 tagged mapping key ' + JSON.stringify(text), () => errorCode(() => parse(text), 'parse.tag'));
for (const text of ['&a x: 1', '? &a x\n: 1\ny: 2', 'outer:\n  &a x: 1'])
  test('R1 anchored mapping key ' + JSON.stringify(text), () => errorCode(() => parse(text), 'parse.alias'));
test('R2 multiple documents preserve precise error code', () => {
  errorCode(() => parse('x: 1\n---\ny: 2'), 'parse.documents');
  errorCode(() => parse('['), 'parse.syntax');
});
test('R3 state invariants retain legitimate preinstall conflicts', () => {
  const empty = { ...state, active: null };
  errorCode(() => validateState({ ...empty, status: 'needs-reconciliation' }), 'state.pending');
  errorCode(() => validateState({ ...empty, status: 'drift' }), 'state.drift');
  validateState({ ...state, status: 'drift' });
  validateState({ ...empty, status: 'needs-reconciliation', pending: hash });
  for (const status of ['conflict', 'unsupported']) validateState({ ...empty, status });
});
test('R4 fresh setup rejects unselected owner', () => {
  const p = clone(plan); p.targets[0].owner = 'kimi';
  errorCode(() => validateOperation(p), 'operation.owner');
});
test('R4 prior-state plans require the actual bound previous state', () => {
  const p = { ...plan, command: 'update', beforeStateHash: contractDigest(state) };
  errorCode(() => validateOperation(p), 'plan.previous-required');
  const stale = clone(state); stale.active.version = '2.0.0';
  errorCode(() => validateOperation(p, stale), 'plan.previous');
  validateOperation(p, state);
});
function removingProvider() {
  const previous = clone(state);
  previous.active.providers.push('kimi');
  previous.active.adapterVersions.kimi = 'test-double-1';
  previous.active.owned.push({ ...owned, path: '.kimi-code/skills/example/SKILL.md', owner: 'kimi' });
  const p = { ...plan, command: 'remove', beforeStateHash: contractDigest(previous),
    targets: [{ ...target, path: '.kimi-code/skills/example/SKILL.md', owner: 'kimi',
      action: 'delete', beforeHash: hash, desiredHash: null }] };
  const r = { ...receipt, planDigest: contractDigest(p), operations: [{
    ...receipt.operations[0], beforeHash: hash, desiredHash: null, observedHash: null
  }] };
  return { previous, p, r };
}
test('R4 remove old provider while retaining desired providers', () => {
  const { previous, p, r } = removingProvider();
  validateOperation(p, previous);
  validateReceiptForPlan(r, p, previous);
  validateTransition(previous, state, p, r);
  p.targets[0].owner = 'grok';
  errorCode(() => validateOperation(p, previous), 'operation.owner');
});
test('R4 partial cleanup retains non-null previous installation', () => {
  const { previous, p, r } = removingProvider();
  r.status = 'uncertain'; r.operations[0].status = 'uncertain';
  const next = { ...previous, status: 'needs-reconciliation', pending: contractDigest(p) };
  validateTransition(previous, next, p, r);
  errorCode(() => validateTransition(previous, { ...next, active: deployment }, p, r), 'transition.partial');
});
test('R4 field restoration for removed owner remains supported', () => {
  const { previous, p } = removingProvider();
  p.targets = [{ ...target, path: '.kimi-code/settings.json', owner: 'kimi', action: 'edit-fields',
    beforeHash: hash, desiredHash: other, fields: [{ pointer: '/skills', beforeHash: hash, desiredHash: null }] }];
  validateOperation(p, previous);
});
test('R5 common reference library is not a document kind', () => {
  for (const v of [1, {}, null]) errorCode(() => validateStructure('common', v), 'schema.kind');
  validateStructure('workspace', workspace);
});
for (const subdirectory of ['pipelines/services.', 'pipelines/CON', 'pipelines/name '])
  test('GLM R1 invalid source subdirectory ' + subdirectory, () => {
    const w = clone(workspace); w.pipeline.subdirectory = subdirectory;
    errorCode(() => validateBundle(pipeline, w), 'path.invalid');
    const s = clone(state); s.active.snapshot.source.subdirectory = subdirectory;
    errorCode(() => validateState(s), 'path.invalid');
  });
test('GLM R1 valid dot and nested source subdirectory', () => {
  validateBundle(pipeline, workspace);
  const w = clone(workspace); w.pipeline.subdirectory = 'pipelines/unity';
  validateBundle(pipeline, w);
});
for (const text of ['{{{documentation}}', '{{{documentation}}}', '{{documentation}}}', '{{repository.game}}}'])
  test('GLM R3 malformed token border ' + text, () => errorCode(() => renderEntry(text, layout), 'entry.token'));
test('GLM R3 ordinary JSON braces are preserved', () => {
  assert.equal(renderEntry('{"path": "{{documentation}}"}', layout), '{"path": "project/docs"}');
  assert.equal(renderEntry('{ prose }', layout), '{ prose }');
});
test('GLM R4 digest intentionally follows JSON negative-zero normalization', () => {
  assert.equal(contractDigest({ x: -0 }), contractDigest({ x: 0 }));
  assert.notEqual(contractDigest({ x: '-0' }), contractDigest({ x: '0' }));
});
