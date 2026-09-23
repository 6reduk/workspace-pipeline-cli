import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdtemp,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {formatResult,outputWriter} from '../src/commands/output.js';
import {parseCommand} from '../src/commands/dispatch.js';

test('rebind and reset admit machine output without changing command semantics',()=>{
  for(const args of [
    ['rebind','--workspace',path.resolve('wrapper'),'--manifest',path.resolve('manifest.json')],
    ['reset','--workspace',path.resolve('wrapper'),'--all'],
    ['reset','--workspace',path.resolve('wrapper'),'--apply','--preview',path.resolve('preview.json')],
  ]) {
    assert.deepEqual(parseCommand([...args,'--json']),parseCommand(args));
    assert.throws(()=>parseCommand([...args,'--json','--json']));
  }
});

test('doctor shows status and every diagnostic, not an inferred pass',()=>{
  const result=formatResult({ready:false,status:'drift',workspace:'example',diagnostics:[{code:'doctor.owned-drift',subject:'.grok/config.toml'}]});
  assert.match(result,/NOT READY/);assert.match(result,/doctor.owned-drift/);assert.match(result,/not verified/);
});
test('presentation escapes control sequences and hides embedded private payloads',()=>{
  const result=formatResult({path:'a\x1b[2J',bytes:'sensitive',preview:{content:'secret'}});
  assert.ok(!result.includes('\x1b'));assert.ok(!result.includes('sensitive'));assert.ok(!result.includes(': secret'));
  assert.match(result,/not an apply preview/);
});
test('json writer preserves exact bytes; human output passes help through',async()=>{
  const output=[];const write=text=>output.push(text);
  const bytes='{"payload":"original"}\n';await outputWriter(write,true)(bytes);
  await outputWriter(write,false)('Usage: help\n');assert.deepEqual(output,[bytes,'Usage: help\n']);
});
test('executable uses readable errors by default and machine errors with --json',()=>{
  const cli=fileURLToPath(new URL('../src/cli.js',import.meta.url));
  for(const json of [false,true]){
    const result=spawnSync(process.execPath,[cli,'unknown',...(json?['--json']:[])],{encoding:'utf8',windowsHide:true});
    assert.equal(result.status,2);
    if(json)assert.equal(JSON.parse(result.stderr).error,'cli.command-unavailable');
    else {assert.match(result.stderr,/Workspace Pipeline/);assert.match(result.stderr,/error:/);}
  }
});
test('redirected doctor remains readable by default; --json preserves complete report',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wpc-output-'));
  const cli=fileURLToPath(new URL('../src/cli.js',import.meta.url));
  const invoke=flags=>spawnSync(process.execPath,[cli,'doctor','--workspace',root,...flags],{encoding:'utf8',windowsHide:true});
  const human=invoke([]),machine=invoke(['--json']);
  assert.equal(human.status,1);assert.equal(machine.status,1);
  assert.match(human.stdout,/Workspace Pipeline — doctor/);assert.match(human.stdout,/NOT READY/);
  assert.equal(JSON.parse(machine.stdout).status,'not-installed');
  assert.deepEqual(await readdir(root),[]);
});
