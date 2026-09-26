import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,mkdir,writeFile,readFile,readdir,lstat,rm,symlink} from 'node:fs/promises';
import {applyDesiredFiles} from '../src/desired-state/apply-files.js';

async function fixture(t) {
  const workspace=await mkdtemp(path.join(os.tmpdir(),'wpc-desired-apply-'));
  t.after(()=>rm(workspace,{recursive:true,force:true}));
  await mkdir(path.join(workspace,'.claude/skills'),{recursive:true});
  await writeFile(path.join(workspace,'.claude/skills/custom.md'),'custom');
  await writeFile(path.join(workspace,'CLAUDE.md'),'old');
  await mkdir(path.join(workspace,'project'));await writeFile(path.join(workspace,'project/game.cs'),'untouched');
  const manifest=JSON.stringify({schemaVersion:2,id:'test',version:'1.0.0',adapters:{claude:{providers:['claude'],settings:[],files:[
    {source:'skills',target:'.claude/skills',kind:'directory'},{source:'entry.md',target:'CLAUDE.md',kind:'file'}]}}});
  return {workspace,manifest,selected:['claude'],protectedPaths:['project'],source:new Map([
    ['skills/review/SKILL.md',Buffer.from('review')],['entry.md',Buffer.from('new')]])};
}
test('replace custom state without backup by default and preserve project',async t=>{
  const input=await fixture(t),result=await applyDesiredFiles(input);
  assert.equal(result.status,'applied');assert.equal(result.backupDirectory,null);
  assert.equal(await readFile(path.join(input.workspace,'CLAUDE.md'),'utf8'),'new');
  assert.equal(await readFile(path.join(input.workspace,'project/game.cs'),'utf8'),'untouched');
  await assert.rejects(lstat(path.join(input.workspace,'.claude/skills/custom.md')),{code:'ENOENT'});
  assert.deepEqual(await readdir(path.join(input.workspace,'.pipeline')),['desired-install.json']);
  assert.equal((await applyDesiredFiles(input)).status,'unchanged');
});
test('optional backup contains modified and custom state before replacement',async t=>{
  const input=await fixture(t),result=await applyDesiredFiles({...input,backup:true});
  assert.equal(await readFile(path.join(result.backupDirectory,'CLAUDE.md'),'utf8'),'old');
  assert.equal(await readFile(path.join(result.backupDirectory,'.claude/skills/custom.md'),'utf8'),'custom');
});
test('backup destination failure leaves all installed contents unchanged',async t=>{
  const input=await fixture(t);await mkdir(path.join(input.workspace,'.pipeline'));
  await writeFile(path.join(input.workspace,'.pipeline/backups'),'not a directory');
  await assert.rejects(applyDesiredFiles({...input,backup:true}));
  assert.equal(await readFile(path.join(input.workspace,'CLAUDE.md'),'utf8'),'old');
  assert.equal(await readFile(path.join(input.workspace,'.claude/skills/custom.md'),'utf8'),'custom');
});
test('missing source fails before deleting installed files',async t=>{
  const input=await fixture(t);input.source.delete('entry.md');
  await assert.rejects(applyDesiredFiles(input),e=>e.code==='desired.source-missing');
  assert.equal(await readFile(path.join(input.workspace,'CLAUDE.md'),'utf8'),'old');
});
test('linked target blocks the complete replacement before mutation',async t=>{
  const input=await fixture(t);
  await symlink(path.join(input.workspace,'project'),path.join(input.workspace,'.claude/skills/link'),'junction');
  await assert.rejects(applyDesiredFiles(input),e=>e.code==='desired.unsafe-target' && e.desiredState.mutations===0);
  assert.equal(await readFile(path.join(input.workspace,'CLAUDE.md'),'utf8'),'old');
});
