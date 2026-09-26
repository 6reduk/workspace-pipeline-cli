import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,mkdir,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {applyDesiredFiles} from '../src/desired-state/apply-files.js';

async function fixture(t) {
  const workspace=await mkdtemp(path.join(os.tmpdir(),'wpc-local-settings-'));
  t.after(()=>rm(workspace,{recursive:true,force:true}));
  await writeFile(path.join(workspace,'CLAUDE.md'),'old entry');
  await writeFile(path.join(workspace,'.mcp.json'),JSON.stringify({custom:true,mcpServers:{mine:{command:'mine'},pipeline:{command:'old'}}}));
  const declaration={schemaVersion:2,id:'example',version:'1.0.0',adapters:{claude:{providers:['claude'],
    files:[{source:'entry.md',target:'CLAUDE.md',kind:'file'}],
    settings:[{target:'claude.mcp',pointer:'/mcpServers/pipeline',operation:'set',value:{command:'new'}}]}}};
  return {workspace,declaration,input:{workspace,manifest:JSON.stringify(declaration),selected:['claude'],protectedPaths:['project'],source:new Map([['entry.md',Buffer.from('new entry')]])}};
}
test('one operation replaces files and declared config field with no default backup',async t=>{
  const {workspace,input}=await fixture(t),result=await applyDesiredFiles(input);
  assert.equal(result.status,'applied');assert.equal(result.backupDirectory,null);
  assert.equal(await readFile(path.join(workspace,'CLAUDE.md'),'utf8'),'new entry');
  assert.deepEqual(JSON.parse(await readFile(path.join(workspace,'.mcp.json'),'utf8')),
    {custom:true,mcpServers:{mine:{command:'mine'},pipeline:{command:'new'}}});
  assert.deepEqual(await readdir(path.join(workspace,'.pipeline')),['desired-install.json']);
  assert.equal((await applyDesiredFiles(input)).status,'unchanged');
});
test('backup includes original shared config and original adapter file',async t=>{
  const {workspace,input}=await fixture(t),before=await readFile(path.join(workspace,'.mcp.json'));
  const result=await applyDesiredFiles({...input,backup:true});
  assert.deepEqual(await readFile(path.join(result.backupDirectory,'.mcp.json')),before);
  assert.equal(await readFile(path.join(result.backupDirectory,'CLAUDE.md'),'utf8'),'old entry');
});
test('malformed or forbidden configuration fails before file replacement',async t=>{
  const {workspace,input,declaration}=await fixture(t);
  await writeFile(path.join(workspace,'.mcp.json'),'broken');
  await assert.rejects(applyDesiredFiles(input));
  assert.equal(await readFile(path.join(workspace,'CLAUDE.md'),'utf8'),'old entry');
  declaration.adapters.claude.settings=[{target:'claude.workspace',pointer:'/permissions',operation:'set',value:{}}];
  await assert.rejects(applyDesiredFiles({...input,manifest:JSON.stringify(declaration)}),e=>e.code==='desired.config-scope');
  assert.equal(await readFile(path.join(workspace,'CLAUDE.md'),'utf8'),'old entry');
});
test('configuration-only install creates missing parent and preserves unrelated files',async t=>{
  const {workspace,input,declaration}=await fixture(t);
  declaration.adapters.claude.files=[];
  declaration.adapters.claude.settings=[{target:'claude.workspace',pointer:'/enabledMcpjsonServers',operation:'set',value:['pipeline']}];
  const options={...input,manifest:JSON.stringify(declaration)};
  await applyDesiredFiles(options);
  assert.equal(await readFile(path.join(workspace,'CLAUDE.md'),'utf8'),'old entry');
  assert.deepEqual(JSON.parse(await readFile(path.join(workspace,'.claude/settings.local.json'),'utf8')),{enabledMcpjsonServers:['pipeline']});
  assert.equal((await applyDesiredFiles(options)).status,'unchanged');
});
test('global settings resolve to explicit host home, never workspace config',async t=>{
  const {workspace,input,declaration}=await fixture(t);
  const userHome=await mkdtemp(path.join(os.tmpdir(),'wpc-test-home-'));
  t.after(()=>rm(userHome,{recursive:true,force:true}));
  declaration.adapters.claude.settings=[{target:'grok.user',pointer:'/compat/claude/skills',operation:'set',value:true}];
  const result=await applyDesiredFiles({...input,manifest:JSON.stringify(declaration)},{userHome});
  assert.equal(result.globalConfigPath,path.join(userHome,'.grok/config.toml'));
  assert.match(await readFile(result.globalConfigPath,'utf8'),/skills = true/);
  await assert.rejects(readFile(path.join(workspace,'.grok/config.toml')),{code:'ENOENT'});
});
