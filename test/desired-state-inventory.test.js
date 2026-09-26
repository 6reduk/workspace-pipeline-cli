import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {compileDesiredManifest} from '../src/contracts/desired-state.js';
import {materializeDesiredFiles,inspectDesiredFiles} from '../src/desired-state/inventory.js';

function desired(source=new Map([['skills/review/SKILL.md',Buffer.from('new')],['entry.md',Buffer.from('entry')]])) {
  return materializeDesiredFiles(compileDesiredManifest(JSON.stringify({schemaVersion:2,id:'example',version:'1.0.0',adapters:{
    claude:{providers:['claude'],files:[{source:'skills',target:'.claude/skills',kind:'directory'},
      {source:'entry.md',target:'CLAUDE.md',kind:'file'}],settings:[]}}}),{selected:['claude'],protectedPaths:['project']}),source);
}
async function temp(t) {
  const root=await mkdtemp(path.join(os.tmpdir(),'wpc-desired-inventory-'));
  t.after(()=>rm(root,{recursive:true,force:true}));return root;
}
test('inventory lists custom Unicode file, modified and missing delivery without writes',async t=>{
  const root=await temp(t);
  await mkdir(path.join(root,'.claude/skills/review'),{recursive:true});
  await writeFile(path.join(root,'.claude/skills/review/SKILL.md'),'custom');
  await writeFile(path.join(root,'.claude/skills/мои заметки.md'),'keep until apply');
  await mkdir(path.join(root,'project'));await writeFile(path.join(root,'project/game.cs'),'game');
  const result=await inspectDesiredFiles(root,desired());
  assert.equal(result.ready,true);assert.equal(result.backupDefault,false);
  assert.deepEqual(result.extra.map(x=>x.path),['.claude/skills/мои заметки.md']);
  assert.deepEqual(result.modified.map(x=>x.path),['.claude/skills/review/SKILL.md']);
  assert.deepEqual(result.missing.map(x=>x.path),['CLAUDE.md']);
  assert.equal(await readFile(path.join(root,'.claude/skills/review/SKILL.md'),'utf8'),'custom');
  assert.equal(await readFile(path.join(root,'project/game.cs'),'utf8'),'game');
});
test('missing source fails before inventory; source buffers are copied',()=>{
  assert.throws(()=>desired(new Map([['entry.md',Buffer.from('entry')]])),e=>e.code==='desired.source-missing');
  const content=Buffer.from('new'),result=desired(new Map([['skills/review/SKILL.md',content],['entry.md',Buffer.from('entry')]]));
  content.fill(0);assert.equal(result.entries.find(x=>x.path.endsWith('SKILL.md')).bytes.toString(),'new');
});
test('fresh workspace reports missing items, matched delivery reports no loss',async t=>{
  const root=await temp(t),want=desired();
  assert.equal((await inspectDesiredFiles(root,want)).missing.length,4);
  for(const entry of want.entries) {
    const target=path.join(root,entry.path);
    if(entry.kind==='directory')await mkdir(target,{recursive:true});
    else{await mkdir(path.dirname(target),{recursive:true});await writeFile(target,entry.bytes);}
  }
  const result=await inspectDesiredFiles(root,want);
  assert.equal(result.unchanged.length,4);
  assert.deepEqual([result.extra,result.modified,result.missing,result.blocked],[[],[],[],[]]);
});
test('type replacement is visible and nested repository blocks destructive use',async t=>{
  const root=await temp(t);await mkdir(path.join(root,'CLAUDE.md/.git'),{recursive:true});
  const result=await inspectDesiredFiles(root,desired());
  assert.equal(result.ready,false);assert.equal(result.modified[0].currentKind,'directory');
  assert.deepEqual(result.blocked,[{path:'CLAUDE.md/.git',reason:'nested-repository'}]);
});
test('directory links do not expand observation into unrelated content',async t=>{
  const root=await temp(t);await mkdir(path.join(root,'project'));await mkdir(path.join(root,'.claude'));
  await symlink(path.join(root,'project'),path.join(root,'.claude/skills'),'junction');
  const result=await inspectDesiredFiles(root,desired());
  assert.equal(result.ready,false);assert.equal(result.blocked[0].reason,'link');
});
