import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {parseCommand,runCli} from '../src/commands/dispatch.js';

test('public acquisition commands reject retired network flag and help no longer advertises it',async()=>{
  const root=path.resolve('fixture-workspace'),file=path.resolve('fixture.json');
  const prefixes=[
    ...['setup','update'].map(verb=>[verb,'--workspace',root]),
    ['switch','--workspace',root,'--manifest',file],
    ...['init','adopt','wrap'].map(verb=>[verb,'--workspace',root,'--choices',file]),
    ['migration','unity','preview','--workspace',root,'--manifest',file]
  ];
  for(const args of prefixes){
    assert.doesNotThrow(()=>parseCommand(args));
    assert.throws(()=>parseCommand([...args,'--network']),e=>e.code==='cli.arguments');
  }
  let out='';
  assert.equal(await runCli(['--help'],{stdout:async s=>{out+=s;},stderr:async()=>{}}),0);
  assert.doesNotMatch(out,/--network/);
});
