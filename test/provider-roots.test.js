import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRequestScope} from '../src/operations/plan.js';
import {assertUnreserved} from '../src/workspace/reserved.js';
import {reconcileFields} from '../src/operations/ownership.js';
import {contractDigest} from '../src/contracts/semantic.js';

const request=()=>({path:'.mcp.json',owner:'claude',kind:'json-fields',fields:[
  {pointer:'/mcpServers/unity-sdd-blender',present:true,value:{command:'example-not-executed'}}]});
test('Claude project MCP root permits only named server fields',()=>{
  assert.doesNotThrow(()=>assertRequestScope(request(),['claude']));
  for(const pointer of ['/mcpServers','/other/server','/mcpServers/','/mcpServers/x/args','/mcpServers/x~1y']){
    const r=request();r.fields[0].pointer=pointer;
    assert.throws(()=>assertRequestScope(r,['claude']),e=>e.code==='plan.scope');
  }
  assert.throws(()=>assertRequestScope({path:'.mcp.json',owner:'claude',kind:'file',bytes:Buffer.from('{}')},['claude']),e=>e.code==='plan.scope');
});
test('project MCP path is not available to other providers or alternate roots',()=>{
  for(const owner of ['codex','kimi','grok','shared']){
    const r=request();r.owner=owner;
    assert.throws(()=>assertRequestScope(r,['codex','claude','kimi','grok']),e=>e.code==='plan.scope');
  }
  for(const target of ['.mcp.json/child','.MCP.json','project/.mcp.json']){
    const r=request();r.path=target;
    assert.throws(()=>assertRequestScope(r,['claude']),e=>e.code==='plan.scope');
  }
});
test('repository destinations cannot occupy MCP config root, case insensitively',()=>{
  for(const name of ['.mcp.json','.MCP.JSON','.mcp.json/repository'])assert.throws(()=>assertUnreserved(name),e=>e.code==='layout.reserved');
  assert.doesNotThrow(()=>assertUnreserved('project/.mcp.json'));
});
test('MCP field add/remove preserves foreign servers and settings',()=>{
  const current={mcpServers:{foreign:{command:'user-command'}},userNote:'preserve'};
  const before=JSON.stringify(current),r=request();assertRequestScope(r,['claude']);
  const added=reconcileFields(current,r.fields);
  assert.equal(JSON.stringify(current),before);
  assert.deepEqual(JSON.parse(JSON.stringify(added.value.mcpServers.foreign)),current.mcpServers.foreign);
  const removed=reconcileFields(added.value,[{pointer:r.fields[0].pointer,present:false,managedHash:contractDigest(r.fields[0].value)}]);
  assert.deepEqual(JSON.parse(JSON.stringify(removed.value)),current);
  const collision=structuredClone(current);collision.mcpServers['unity-sdd-blender']={command:'foreign-command'};
  assert.throws(()=>reconcileFields(collision,r.fields),e=>e.code==='ownership.foreign');
});
