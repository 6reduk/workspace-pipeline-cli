import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,readFile,writeFile,unlink,rm,readdir} from 'node:fs/promises';
import {applyDesiredFiles} from '../src/desired-state/apply-files.js';
import {inspectDesiredInstallation} from '../src/desired-state/doctor.js';
import {runCli} from '../src/commands/dispatch.js';
import {formatResult} from '../src/commands/output.js';

async function fixture(t) {
  const workspace=await mkdtemp(path.join(os.tmpdir(),'wpc-desired-doctor-'));
  t.after(()=>rm(workspace,{recursive:true,force:true}));
  const manifest=JSON.stringify({schemaVersion:2,id:'example',version:'1.0.0',adapters:{claude:{providers:['claude'],
    files:[{source:'skills',target:'.claude/skills',kind:'directory'}],
    settings:[{target:'claude.mcp',pointer:'/mcpServers/test',operation:'set',value:{command:'test'}}]}}});
  await applyDesiredFiles({workspace,manifest,selected:['claude'],protectedPaths:['project'],source:new Map([
    ['skills/a.md',Buffer.from('a')],['skills/b.md',Buffer.from('b')]])});
  return workspace;
}
test('public doctor routes desired state and returns ready without writes',async t=>{
  const workspace=await fixture(t),before=await readFile(path.join(workspace,'.pipeline/desired-install.json'));
  let out='',err='';const code=await runCli(['doctor','--workspace',workspace],{stdout:async s=>{out+=s;},stderr:async s=>{err+=s;}});
  assert.equal(code,0);assert.equal(err,'');assert.equal(JSON.parse(out).ready,true);
  assert.deepEqual(await readFile(path.join(workspace,'.pipeline/desired-install.json')),before);
  assert.deepEqual(await readdir(path.join(workspace,'.pipeline')),['desired-install.json']);
});
test('doctor lists extra, modified, missing and differing settings, not secrets',async t=>{
  const workspace=await fixture(t);
  await writeFile(path.join(workspace,'.claude/skills/extra.md'),'private extra');
  await writeFile(path.join(workspace,'.claude/skills/a.md'),'private modified');
  await unlink(path.join(workspace,'.claude/skills/b.md'));
  await writeFile(path.join(workspace,'.mcp.json'),'{}');
  const result=await inspectDesiredInstallation(workspace);
  assert.equal(result.ready,false);
  assert.deepEqual(result.files.extra.map(e=>e.path),['.claude/skills/extra.md']);
  assert.deepEqual(result.files.modified.map(e=>e.path),['.claude/skills/a.md']);
  assert.deepEqual(result.files.missing.map(e=>e.path),['.claude/skills/b.md']);
  assert.equal(result.settings[0].status,'different');
  const text=formatResult(result);assert.match(text,/Extra — removed: 1/);assert.match(text,/extra.md/);
  assert.ok(!JSON.stringify(result).includes('private modified'));assert.ok(!text.includes('private extra'));
});
test('pending record prevents ready even when file contents match',async t=>{
  const workspace=await fixture(t),record=await readFile(path.join(workspace,'.pipeline/desired-install.json'));
  await writeFile(path.join(workspace,'.pipeline/desired-pending.json'),record);
  const result=await inspectDesiredInstallation(workspace);
  assert.equal(result.ready,false);assert.equal(result.status,'incomplete');
});
test('uninstalled workspace returns null for legacy doctor routing',async t=>{
  const workspace=await mkdtemp(path.join(os.tmpdir(),'wpc-no-desired-'));
  t.after(()=>rm(workspace,{recursive:true,force:true}));
  assert.equal(await inspectDesiredInstallation(workspace),null);
});
