import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileTOMLFields,readTOMLField} from '../src/operations/toml-fields.js';
import {contractDigest} from '../src/contracts/semantic.js';
const pointer='/agents/unity_review';
const value={description:'Review docs',config_file:'agents/review.toml'};
const add=(extra={})=>({pointer,present:true,value,...extra});
const buf=s=>Buffer.from(s);

test('generated multi-entry cycles do not accumulate blank lines and preserve foreign bytes',()=>{
  for(const nl of ['\n','\r\n'])for(const foreign of ['', '# foreign'+nl+'model="mine"'+nl+nl]){
    const requests=[add(),{pointer:'/mcp_servers/probe',present:true,value:{command:'noop'}}];
    let bytes=buf(foreign),first;
    for(let cycle=0;cycle<4;cycle++){
      const created=reconcileTOMLFields(bytes,requests).bytes;
      first??=created;assert.deepEqual(created,first);
      bytes=reconcileTOMLFields(created,requests.map(r=>({pointer:r.pointer,present:false,managedHash:contractDigest(r.value)}))).bytes;
      assert.equal(bytes.toString(),foreign);
    }
  }
});

test('removal preserves inline comments, blank lines, indentation and foreign neighbor exactly',()=>{
  for(const nl of ['\n','\r\n']){
    const tail=nl+'# neighbor'+nl+'[agents.other]'+nl+'description="mine"';
    const text='[agents.unity_review] # header'+nl+'description="old" # value'+nl+'  '+nl+tail;
    const old=readTOMLField(buf(text),pointer).value;
    const out=reconcileTOMLFields(buf(text),[{pointer,present:false,managedHash:contractDigest(old)}]).bytes;
    assert.equal(out.toString(),' # header'+nl+' # value'+nl+'  '+nl+tail);
  }
});

test('TOML create, semantic read and no-op preserve exact bytes',()=>{
  const first=reconcileTOMLFields(null,[add()]);
  assert.deepEqual(JSON.parse(JSON.stringify(readTOMLField(first.bytes,pointer).value)),value);
  const again=reconcileTOMLFields(first.bytes,[add({managedHash:contractDigest(value)})]);
  assert.deepEqual(again.bytes,first.bytes);
});
test('foreign text, comments, dates, NaN, huge integers and CRLF survive update/remove',()=>{
  const foreign='# user\r\nmodel = "my-choice" # keep\r\nwhen = 1979-05-27T07:32:00Z\r\nbig = 9223372036854775807\r\nn = nan\r\n[agents.foreign]\r\ndescription = "mine"\r\n';
  const first=reconcileTOMLFields(buf(foreign),[add()]);
  assert.ok(first.bytes.toString().startsWith(foreign));
  const updated={...value,description:'New'};
  const second=reconcileTOMLFields(first.bytes,[{pointer,present:true,value:updated,managedHash:contractDigest(value)}]);
  assert.ok(second.bytes.toString().startsWith(foreign));
  const removed=reconcileTOMLFields(second.bytes,[{pointer,present:false,managedHash:contractDigest(updated)}]);
  assert.ok(removed.bytes.toString().startsWith(foreign));
  assert.equal(readTOMLField(removed.bytes,pointer).present,false);
});
test('owned nested MCP tables can be replaced without touching neighboring servers',()=>{
  const text='[mcp_servers.ours]\ncommand="old" # historical note\n[mcp_servers.ours.env]\nTOKEN="env-ref"\n[mcp_servers.other]\ncommand="foreign"\n';
  const p='/mcp_servers/ours',old=readTOMLField(buf(text),p).value;
  const next=reconcileTOMLFields(buf(text),[{pointer:p,present:true,value:{command:'new',args:['--safe']},managedHash:contractDigest(old)}]);
  assert.ok(next.bytes.toString().includes('# historical note'));
  assert.ok(next.bytes.toString().includes('[mcp_servers.other]\ncommand="foreign"\n'));
});
test('dotted and quoted keys bind by semantics, not textual spelling',()=>{
  for(const text of ['agents.unity_review = {description="old"}\n','["agents".\'unity_review\']\ndescription="old"\n','[agents]\nunity_review.description="old"\n']){
    const old=readTOMLField(buf(text),pointer).value;
    const result=reconcileTOMLFields(buf(text),[add({managedHash:contractDigest(old)})]);
    assert.equal(readTOMLField(result.bytes,pointer).value.description,value.description);
  }
});
test('foreign equality does not acquire ownership; drift and collisions reject',()=>{
  const first=reconcileTOMLFields(null,[add()]);
  assert.equal(reconcileTOMLFields(first.bytes,[add()]).decisions[0].owned,false);
  assert.throws(()=>reconcileTOMLFields(first.bytes,[{...add(),value:{description:'other'}}]),e=>e.code==='ownership.foreign');
  assert.throws(()=>reconcileTOMLFields(first.bytes,[add({managedHash:'sha256:'+'0'.repeat(64)})]),e=>e.code==='ownership.drift');
});
test('inline ancestor refuses rather than rewriting foreign fields',()=>{
  assert.throws(()=>reconcileTOMLFields(buf('agents={foreign={description="mine"}}\n'),[add()]),e=>e.code==='toml.inline-ancestor');
});
test('sensitive roots, parent scopes and prototype keys reject',()=>{
  for(const p of ['/model/x','/projects/x','/agents','/agents/x/config_file','/mcp_servers/__proto__','/agents/constructor','/agents/enabled','/agents/default_subagent_model'])assert.throws(()=>reconcileTOMLFields(null,[{...add(),pointer:p}]),e=>e.code==='toml.scope');
  assert.throws(()=>reconcileTOMLFields(buf('["__proto__"]\nx=1\n'),[add()]),e=>e.code==='toml.key');
});
test('syntax/duplicate errors are redacted',()=>{
  for(const text of ['token="SECRET"\ntoken="OTHER"','[agents\nsecret=bad'])assert.throws(()=>reconcileTOMLFields(buf(text),[add()]),e=>e.code==='toml.syntax'&&!e.message.includes('SECRET'));
});
test('invalid desired values, duplicate requests and scalar parents reject',()=>{
  for(const bad of [{x:null},{x:NaN},{x:2n},{x:new Date()},[]])assert.throws(()=>reconcileTOMLFields(null,[{...add(),value:bad}]));
  assert.throws(()=>reconcileTOMLFields(null,[add(),add()]),e=>e.code==='ownership.overlap');
  assert.throws(()=>reconcileTOMLFields(buf('agents=1'),[add()]),e=>e.code==='toml.ancestor');
});
test('strings are TOML-safe including controls, Unicode and triple-quote text',()=>{
  const v={description:'Русский\u0000\u007f\n"""\\text',config_file:'a\\b.toml',args:['x',true,3],env:{A:'B'}};
  const result=reconcileTOMLFields(null,[{...add(),value:v}]);
  assert.deepEqual(JSON.parse(JSON.stringify(readTOMLField(result.bytes,pointer).value)),v);
});
test('oversized input rejects before parse; missing field read is explicit',()=>{
  assert.throws(()=>reconcileTOMLFields(Buffer.alloc(2*1024*1024+1,32),[add()]),e=>e.code==='toml.size');
  assert.deepEqual(readTOMLField(null,pointer),{present:false});
});

test('request accessors reject without execution; array-of-tables cannot be an owned entry',()=>{
  let invoked=false;const request={present:true,value};
  Object.defineProperty(request,'pointer',{enumerable:true,get(){invoked=true;return pointer;}});
  assert.throws(()=>reconcileTOMLFields(null,[request]),e=>e.code==='toml.requests');assert.equal(invoked,false);
  assert.throws(()=>reconcileTOMLFields(buf('[[agents.unity_review]]\ndescription="x"\n'),[add()]),e=>e.code==='toml.entry');
});
