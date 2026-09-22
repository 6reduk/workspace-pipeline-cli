import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareLegacyUnityOptOut as prepare,prepareLegacyUnityDeactivation as plan,
 validateLegacyUnityDeactivation as validate,inspectLegacyUnityDeactivation as inspect} from '../src/migrations/legacy-unity.js';
import {contractDigest} from '../src/contracts/semantic.js';
import {parse} from '../src/contracts/parse.js';
const id='unity-sdd-pipeline@unity-sdd';
test('Codex edit preserves foreign bytes and line endings; repeated preparation is no-op',()=>{
 for(const nl of ['\n','\r\n'])for(const entry of [`[plugins."${id}"]${nl}enabled = true`,`plugins."${id}".enabled = true`]){
  const before=Buffer.from(`model="mine"${nl}# keep${nl}${entry} # note${nl}`),result=prepare('codex',before);
  assert.equal(result.bytes.toString(),before.toString().replace('enabled = true','enabled = false'));
  assert.equal(result.changed,true);assert.notEqual(result.beforeHash,result.afterHash);
  assert.equal(prepare('codex',result.bytes).changed,false);
 }
});
test('Claude scalar-only edit preserves escaped keys and foreign settings',()=>{
 for(const key of [id,'unity-sdd-pipeline\\u0040unity-sdd']){
  const text=`{\r\n "model":"mine", "enabledPlugins":{"other":true,"${key}" : true},"tail":[{},42] }`;
  const result=prepare('claude',Buffer.from(text));
  assert.equal(result.bytes.toString(),text.replace(`"${key}" : true`,`"${key}" : false`));
  assert.equal(prepare('claude',result.bytes).changed,false);
 }
});
test('missing, duplicate, malformed, inline and unsupported inputs fail closed',()=>{
 for(const [provider,text] of [['codex','model="x"'],['codex',`plugins={"${id}"={enabled=true}}`],['codex',`[plugins."${id}"]\nenabled=true\nenabled=false`],['claude','{}'],['claude',`{"enabledPlugins":{"${id}":true,"${id}":false}}`],['claude',`{"enabledPlugins":{"${id}":"true"}}`]])assert.throws(()=>prepare(provider,Buffer.from(text)));
 assert.throws(()=>prepare('grok',Buffer.from('{}')));
 assert.throws(()=>prepare('codex',Buffer.alloc(2*1024*1024+1)));
});

const fixture=()=>[
 {provider:'codex',bytes:Buffer.from(`[plugins."${id}"]\nenabled=true\nmodel_hint="untouched"\n`)},
 {provider:'claude',bytes:Buffer.from(JSON.stringify({enabledPlugins:{[id]:true,other:true},model:'mine'}))}
];
test('deterministic records bind complete config bytes and rebuild after JSON serialization',()=>{
 const input=fixture(),record=plan(input);
 assert.deepEqual(plan([...input].reverse()),record);
 assert.deepEqual(validate(JSON.parse(JSON.stringify(record))),record);
 assert.deepEqual(validate(parse(JSON.stringify(record),'json')),record);
 assert.deepEqual(inspect(record,input).map(x=>x.state),['before','before']);
});
test('partial interruption classified without claiming ownership or auto rollback',()=>{
 const input=fixture(),record=plan(input);
 for(let count=0;count<=2;count++){
  const current=input.map((x,i)=>({provider:x.provider,bytes:i<count?Buffer.from(record.targets[i].after,'base64'):x.bytes}));
  assert.deepEqual(inspect(record,current).map(x=>x.state),input.map((_,i)=>i<count?'after':'before'));
 }
 const missing=[{provider:'codex',bytes:null},input[1]];
 assert.equal(inspect(record,missing)[0].state,'conflict');
 const edited=[{provider:'codex',bytes:Buffer.concat([input[0].bytes,Buffer.from('# user edit')])},input[1]];
 assert.equal(inspect(record,edited)[0].state,'conflict');
});
test('disabled input is distinguished from a completed write',()=>{
 const input=fixture().map(x=>({provider:x.provider,bytes:prepare(x.provider,x.bytes).bytes}));
 assert.deepEqual(inspect(plan(input),input).map(x=>x.state),['unchanged-disabled','unchanged-disabled']);
});
test('tampered payload/path/digest rejected even with recomputed outer hash',()=>{
 const record=plan(fixture());
 for(const edit of [r=>r.targets[0].path='../project/AGENTS.md',r=>r.targets[0].after=Buffer.from('foreign').toString('base64'),r=>r.targets.reverse()]){
  const mutated=structuredClone(record);edit(mutated);const {digest,...body}=mutated;mutated.digest=contractDigest(body);
  assert.throws(()=>validate(mutated));
 }
 assert.throws(()=>validate({...record,digest:'sha256:'+'0'.repeat(64)}));
});
test('missing/duplicate providers and accessors fail before invoking getters',()=>{
 const input=fixture(),record=plan(input);
 for(const bad of [[],[input[0],input[0]],input.concat(input[0])]){
  assert.throws(()=>plan(bad));assert.throws(()=>inspect(record,bad));
 }
 let called=false;const item={bytes:input[0].bytes};Object.defineProperty(item,'provider',{enumerable:true,get(){called=true;return 'codex';}});
 assert.throws(()=>plan([item,input[1]]));assert.equal(called,false);
});
