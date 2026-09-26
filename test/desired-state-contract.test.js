import test from 'node:test';
import assert from 'node:assert/strict';
import {compileDesiredManifest} from '../src/contracts/desired-state.js';

const fixture=()=>({schemaVersion:2,id:'unity-sdd',version:'1.0.0',adapters:{
  'claude-grok':{providers:['claude','grok'],files:[{source:'entry.md',target:'CLAUDE.md',kind:'file'},
    {source:'skills',target:'.claude/skills',kind:'directory'}],settings:[
    {target:'grok.user',pointer:'/compat/claude/skills',operation:'set',value:true}]}}});
const compile=value=>compileDesiredManifest(JSON.stringify(value),{selected:['claude-grok'],protectedPaths:['project']});
const reject=(mutate,code)=>{const value=fixture();mutate(value);assert.throws(()=>compile(value),e=>e.code===code);};

test('one delivery serves Claude and Grok with one entry and explicit destinations',()=>{
  const result=compile(fixture());
  assert.deepEqual(result.providers,['claude','grok']);
  assert.equal(result.files.length,2);
  assert.equal(result.settings[0].value,true);
});
test('schema rejects executable hooks, unknown targets and ambiguous setting values',()=>{
  reject(v=>v.hooks=['cmd'],'desired.schema');
  reject(v=>v.adapters['claude-grok'].settings[0].target='arbitrary.user','desired.schema');
  reject(v=>delete v.adapters['claude-grok'].settings[0].value,'desired.schema');
  reject(v=>v.adapters['claude-grok'].settings[0].operation='remove','desired.schema');
});
test('project, metadata and shared config cannot be whole-owned',()=>{
  for(const target of ['project','project/docs','.pipeline','.claude','.mcp.json','workspace.json'])
    reject(v=>v.adapters['claude-grok'].files[0].target=target,'desired.scope');
  reject(v=>v.adapters['claude-grok'].files[0].target='.git/config','path.invalid');
});
test('file scopes cannot overlap or collide by case',()=>{
  for(const target of ['claude.MD','.claude/skills/nested'])
    reject(v=>v.adapters['claude-grok'].files.push({source:'other',target,kind:'file'}),'desired.target-overlap');
});
test('field overlap and unsafe pointers fail',()=>{
  reject(v=>v.adapters['claude-grok'].settings.push({target:'grok.user',pointer:'/compat',operation:'remove'}),'desired.field-overlap');
  for(const pointer of ['/__proto__/x','/compat/~2','/compat//x'])
    reject(v=>v.adapters['claude-grok'].settings[0].pointer=pointer,'desired.pointer');
});
test('selection is explicit and remove has no value',()=>{
  const value=fixture();value.adapters['claude-grok'].settings[0]={target:'grok.user',pointer:'/compat/claude/skills',operation:'remove'};
  assert.equal(compile(value).settings[0].operation,'remove');
  assert.throws(()=>compileDesiredManifest(JSON.stringify(value),{selected:[]}),e=>e.code==='desired.selection');
});

test('common payload is included once with one or multiple adapters',()=>{
  const value=fixture();
  value.files=[{source:'core',target:'.sdx',kind:'directory'}];
  value.adapters.codex={providers:['codex'],files:[{source:'codex',target:'.agents/skills',kind:'directory'}],settings:[]};
  for(const selected of [['codex'],['claude-grok'],['codex','claude-grok']]) {
    const result=compileDesiredManifest(JSON.stringify(value),{selected});
    assert.equal(result.files.filter(f=>f.target==='.sdx').length,1);
    assert.deepEqual(result.adapters,[...selected].sort());
  }
});

test('common payload uses identical scope, schema and overlap checks',()=>{
  for(const target of ['project/docs','.pipeline/core','.claude'])
    reject(v=>v.files=[{source:'core',target,kind:'directory'}],'desired.scope');
  reject(v=>v.files=[{source:'core',target:'.CLAUDE/skills',kind:'directory'}],'desired.target-overlap');
  reject(v=>v.files=[{source:'core',target:'safe',kind:'directory',execute:true}],'desired.schema');
});
