import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {parseCommand,runCli} from '../src/commands/dispatch.js';
const workspace=path.resolve('synthetic-never-created'),manifest=path.resolve('synthetic-manifest.json');
test('migration parser requires explicit source/phase and rejects write switches',()=>{
 const prefix=['migration','unity','preview','--workspace',workspace,'--manifest',manifest];
 assert.equal(parseCommand(prefix).action,'preview');assert.equal(parseCommand([...prefix,'--network']).network,true);
 for(const extra of [['--apply'],['--manifest',manifest],['--phase','closeout'],['--recovery','x']])assert.throws(()=>parseCommand([...prefix,...extra]));
 const recovery='.pipeline/migrations/11111111-1111-1111-1111-111111111111/recovery.json';
 for(const phase of ['deactivation','installation','recovery','closeout','compensation'])
  assert.equal(parseCommand(['migration','unity','inspect','--workspace',workspace,'--recovery',recovery,'--phase',phase]).phase,phase);
 for(const phase of ['__proto__','constructor','latest'])assert.throws(()=>parseCommand(['migration','unity','inspect','--workspace',workspace,'--recovery',recovery,'--phase',phase]));
 assert.throws(()=>parseCommand(['migration','unity','inspect','--workspace',workspace,'--recovery','../recovery.json','--phase','closeout']));
});
test('migration write invocation fails before filesystem access and help discloses preview limits',async()=>{
 let out='',err='';const io={stdout:async text=>{out+=text;},stderr:async text=>{err+=text;}};
 assert.equal(await runCli(['migration','unity','preview','--workspace',workspace,'--manifest',manifest,'--apply'],io),2);
 assert.equal(out,'');assert.match(err,/cli.arguments/);
 out='';err='';assert.equal(await runCli(['--help'],io),0);assert.match(out,/Migration commands/);assert.match(out,/installer-bound envelope/);
});
test('migration apply accepts only saved preview and workspace, never acquisition overrides',()=>{
 const args=['migration','unity','apply','--workspace',workspace,'--preview',manifest];
 assert.equal(parseCommand(args).previewFile,manifest);
 for(const extra of [['--network'],['--manifest',manifest],['--phase','closeout'],['--preview',manifest]])assert.throws(()=>parseCommand([...args,...extra]));
 assert.throws(()=>parseCommand(['migration','unity','apply','--workspace',workspace]));
});
