import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,mkdir,writeFile,readFile,lstat,rm} from 'node:fs/promises';
import {applyDesiredFiles} from '../src/desired-state/apply-files.js';

async function fixture(t) {
  const workspace=await mkdtemp(path.join(os.tmpdir(),'wpc-retire-'));
  t.after(()=>rm(workspace,{recursive:true,force:true}));
  await mkdir(path.join(workspace,'project'));await writeFile(path.join(workspace,'project/game.cs'),'game');
  const declaration={schemaVersion:2,id:'test',version:'1.0.0',adapters:{claude:{providers:['claude'],files:[
    {source:'old.md',target:'CLAUDE.md',kind:'file'},
    {source:'skills',target:'.claude/skills',kind:'directory'}],settings:[
    {target:'claude.mcp',pointer:'/mcpServers/pipeline',operation:'set',value:{command:'old'}}]}}};
  const input={workspace,selected:['claude'],protectedPaths:['project'],source:new Map([
    ['old.md',Buffer.from('old')],['skills/review/SKILL.md',Buffer.from('review')]])};
  const apply=()=>applyDesiredFiles({...input,manifest:JSON.stringify(declaration)});
  await apply();return {workspace,declaration,input,apply};
}
test('retired file/tree and field removed, custom tree contents follow owned scope',async t=>{
  const {workspace,declaration,apply}=await fixture(t);
  await writeFile(path.join(workspace,'.claude/skills/custom.md'),'custom');
  const config=JSON.parse(await readFile(path.join(workspace,'.mcp.json'),'utf8'));
  config.mcpServers.mine={command:'mine'};await writeFile(path.join(workspace,'.mcp.json'),JSON.stringify(config));
  declaration.version='1.1.0';declaration.adapters.claude.files=[];declaration.adapters.claude.settings=[];
  await apply();
  for(const name of ['CLAUDE.md','.claude/skills'])await assert.rejects(lstat(path.join(workspace,name)),{code:'ENOENT'});
  assert.deepEqual(JSON.parse(await readFile(path.join(workspace,'.mcp.json'),'utf8')),{mcpServers:{mine:{command:'mine'}}});
  assert.equal(await readFile(path.join(workspace,'project/game.cs'),'utf8'),'game');
  assert.equal((await apply()).status,'unchanged');
});
test('narrowing an owned directory removes siblings but preserves new file target',async t=>{
  const {workspace,declaration,apply}=await fixture(t);
  await writeFile(path.join(workspace,'.claude/skills/custom.md'),'custom');
  declaration.adapters.claude.files=[{source:'skills/review/SKILL.md',target:'.claude/skills/review/SKILL.md',kind:'file'}];
  await apply();
  assert.equal(await readFile(path.join(workspace,'.claude/skills/review/SKILL.md'),'utf8'),'review');
  await assert.rejects(lstat(path.join(workspace,'.claude/skills/custom.md')),{code:'ENOENT'});
  assert.equal((await apply()).status,'unchanged');
});
test('tampered old scope cannot grant deletion of project',async t=>{
  const {workspace,declaration,apply}=await fixture(t);
  const filename=path.join(workspace,'.pipeline/desired-install.json'),record=JSON.parse(await readFile(filename,'utf8'));
  record.scopes.push({path:'project',kind:'directory'});await writeFile(filename,JSON.stringify(record));
  declaration.adapters.claude.files=[];
  await assert.rejects(apply(),e=>e.code==='desired.scope');
  assert.equal(await readFile(path.join(workspace,'project/game.cs'),'utf8'),'game');
  assert.equal(await readFile(path.join(workspace,'CLAUDE.md'),'utf8'),'old');
});
test('tampered old setting cannot grant deletion of authentication',async t=>{
  const {workspace,apply}=await fixture(t),filename=path.join(workspace,'.pipeline/desired-install.json');
  const record=JSON.parse(await readFile(filename,'utf8'));
  record.settings.push({target:'grok.user',pointer:'/auth',operation:'set',valueHash:'sha256:'+'a'.repeat(64)});
  await writeFile(filename,JSON.stringify(record));
  await assert.rejects(apply(),e=>e.code==='desired.config-scope');
});
