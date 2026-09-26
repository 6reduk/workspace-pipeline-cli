import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTOML,getStaticTOMLValue} from 'toml-eslint-parser';
import {compileDesiredSettings as edit} from '../src/desired-state/settings.js';
const set=(target,pointer,value)=>({target,pointer,operation:'set',value});
const remove=(target,pointer)=>({target,pointer,operation:'remove'});
test('JSON replaces named MCP and preserves unrelated auth and servers',()=>{
  const before=Buffer.from('{"auth":"secret","mcpServers":{"user":{"command":"mine"},"pipeline":{"command":"old"}}}');
  const result=edit('claude.mcp',before,[set('claude.mcp','/mcpServers/pipeline',{command:'new'})]);
  assert.deepEqual(JSON.parse(result.bytes),{auth:'secret',mcpServers:{user:{command:'mine'},pipeline:{command:'new'}}});
  const removed=edit('claude.mcp',result.bytes,[remove('claude.mcp','/mcpServers/pipeline')]);
  assert.deepEqual(JSON.parse(removed.bytes),{auth:'secret',mcpServers:{user:{command:'mine'}}});
});
test('unchanged JSON retains exact bytes and absent removal is no-op',()=>{
  const bytes=Buffer.from('{ "custom": true }');
  const result=edit('claude.mcp',bytes,[remove('claude.mcp','/mcpServers/pipeline')]);
  assert.equal(result.changed,false);assert.deepEqual(result.bytes,bytes);
});
test('Codex TOML replaces drifted named entry without changing model or foreign text',()=>{
  const prefix='# user\nmodel = "mine"\n',bytes=Buffer.from(prefix+'[mcp_servers.pipeline]\ncommand = "old"\n');
  const result=edit('codex.workspace',bytes,[set('codex.workspace','/mcp_servers/pipeline',{command:'new'})]);
  assert.ok(result.bytes.toString().startsWith(prefix));
  const parsed=getStaticTOMLValue(parseTOML(result.bytes.toString()));
  assert.equal(parsed.model,'mine');assert.equal(parsed.mcp_servers.pipeline.command,'new');
});
test('Grok compatibility sets true/false and removes only declared flags',()=>{
  const bytes=Buffer.from('# user\nmodel = "mine"\n[compat.claude]\nskills = false\nrules = true\n');
  const result=edit('grok.user',bytes,[set('grok.user','/compat/claude/skills',true),set('grok.user','/compat/claude/rules',false)]);
  assert.equal(getStaticTOMLValue(parseTOML(result.bytes.toString())).compat.claude.skills,true);
  const removed=edit('grok.user',result.bytes,[remove('grok.user','/compat/claude/rules')]);
  const parsed=getStaticTOMLValue(parseTOML(removed.bytes.toString()));
  assert.equal(parsed.model,'mine');assert.deepEqual(parsed.compat.claude,{skills:true});
});
test('missing Grok keys and empty file can be initialized',()=>{
  const result=edit('grok.user',null,[set('grok.user','/compat/claude/skills',true)]);
  assert.equal(getStaticTOMLValue(parseTOML(result.bytes.toString())).compat.claude.skills,true);
  assert.equal(edit('grok.user',result.bytes,[set('grok.user','/compat/claude/skills',true)]).changed,false);
  const existing=Buffer.from('[compat.claude]\nrules = true\n');
  const added=edit('grok.user',existing,[set('grok.user','/compat/claude/skills',true)]);
  assert.deepEqual(getStaticTOMLValue(parseTOML(added.bytes.toString())).compat.claude,{skills:true,rules:true});
});
test('auth, model, permission and arbitrary global fields rejected',()=>{
  for(const [target,pointer] of [['codex.workspace','/model'],['claude.workspace','/permissions'],['grok.user','/auth'],['grok.workspace','/model'],['codex.workspace','/agents/default_subagent_model']])
    assert.throws(()=>edit(target,null,[set(target,pointer,'bad')]),e=>e.code==='desired.config-scope');
});
test('invalid configs, overlaps and ambiguous inline ancestors fail without output',()=>{
  assert.throws(()=>edit('claude.mcp',Buffer.from('{'),[remove('claude.mcp','/mcpServers/x')]));
  assert.throws(()=>edit('grok.user',null,[set('grok.user','/compat/claude/skills',true),remove('grok.user','/compat/claude/skills')]),e=>e.code==='desired.field-overlap');
  assert.throws(()=>edit('grok.user',Buffer.from('compat = {claude = {skills = false}}'),[set('grok.user','/compat/claude/skills',true)]),e=>e.code==='desired.config-inline-ancestor');
});
