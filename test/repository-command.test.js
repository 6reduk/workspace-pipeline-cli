import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rename} from 'node:fs/promises';
import {runGit} from '../src/source/git.js';
import {sha256} from '../src/source/inventory.js';
import {runCli,parseCommand} from '../src/commands/dispatch.js';
import {readRepositoryInputs} from '../src/operations/repository-inputs.js';
import {parse} from '../src/contracts/parse.js';
import {inventoryRepository} from '../src/workspace/repository-inventory.js';
import {repositoryContentDigest,summarizeInventory} from '../src/workspace/repository-observation.js';

async function fixture() {
  const root=await mkdtemp(path.join(tmpdir(),'wpc-command-')),source=path.join(root,'pipeline'),wrapper=path.join(root,'wrapper');
  await mkdir(source);
  const pipeline={schemaVersion:1,id:'fixture',version:'1.0.0',resources:'resources',inventory:'inventory.json',
    agentsDocument:{mode:'default'},providers:{codex:{skills:'skills',agents:null,mcp:null,entryInstructions:null,requires:[]}}};
  const files=new Map(Object.entries({'pipeline.json':JSON.stringify(pipeline),'resources/process.md':'rules','skills/test/SKILL.md':'skill'}).map(([p,s])=>[p,Buffer.from(s)]));
  files.set('inventory.json',Buffer.from(JSON.stringify(Object.fromEntries([...files].map(([p,b])=>[p,sha256(b)])))));
  for(const [p,b] of files){await mkdir(path.dirname(path.join(source,p)),{recursive:true});await writeFile(path.join(source,p),b);}
  await runGit(source,['init','--template=','--initial-branch=main']);await runGit(source,['add','.']);
  await runGit(source,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture']);
  const workspace={schemaVersion:1,pipeline:{type:'git',transport:'local',path:'pipeline',ref:'main',subdirectory:'.'},
    providers:['codex'],layout:{kind:'single-repo',repositories:{game:{path:'project',role:'code'}},documentation:{repository:'game',path:'docs'}}};
  const manifest=path.join(root,'workspace.json'),choices=path.join(root,'choices.json'),preview=path.join(root,'preview.json');
  await writeFile(manifest,JSON.stringify(workspace));await writeFile(choices,JSON.stringify({game:{action:'directory'}}));
  return {root,source,wrapper,manifest,choices,preview};
}
async function invoke(args){let out='',err='';const code=await runCli(args,{stdout:s=>{out+=s;},stderr:s=>{err+=s;}});return {code,out,err};}

test('S7 large ignored/untracked tree survives public saved wrap, evidence and finalization',async()=>{
  const f=await fixture(),original=path.join(f.root,'game');await mkdir(original);
  await runGit(original,['init','--template=','--initial-branch=main']);
  await writeFile(path.join(original,'.gitignore'),'Library/\n');
  await writeFile(path.join(original,'tracked.txt'),'original');await runGit(original,['add','.']);
  await runGit(original,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','game']);
  await writeFile(path.join(original,'tracked.txt'),'dirty');await writeFile(path.join(original,'untracked.txt'),'preserve');
  await mkdir(path.join(original,'Library'));
  for(let start=0;start<4100;start+=50)await Promise.all(Array.from({length:Math.min(50,4100-start)},(_,j)=>
    writeFile(path.join(original,'Library',String(start+j)+'.bin'),'cache-'+(start+j))));
  const before=await inventoryRepository(original);
  assert.throws(()=>parse(JSON.stringify(before),'json'),e=>['parse.complexity','parse.size'].includes(e.code));
  await writeFile(f.choices,JSON.stringify({game:{action:'move',from:original}}));
  const prepared=await preview(f,'wrap');assert.ok(Buffer.byteLength(JSON.stringify(prepared))<50000);
  assert.deepEqual(prepared.preview.operations[0].existing.inventory,summarizeInventory(before));
  const result=await invoke(['wrap','--workspace',f.wrapper,'--apply','--preview',f.preview]);
  assert.equal(result.code,0,result.err);const applied=JSON.parse(result.out);
  const after=await inventoryRepository(path.join(f.wrapper,'project'));
  assert.equal(repositoryContentDigest(after),repositoryContentDigest(before));
  const input=await readRepositoryInputs(f.wrapper,applied.journal,applied.executionPreview.digest);
  assert.ok(Buffer.byteLength(input.previewText)<50000);parse(input.previewText,'json');
  assert.equal(applied.finalization.status,'repository-effects-verified');
  const evidenceRoot=path.join(f.wrapper,'.pipeline/repository-evidence',path.basename(applied.journal));
  const evidence=await readFile(path.join(evidenceRoot,'000000.json'),'utf8');
  assert.ok(Buffer.byteLength(evidence)<5000);assert.equal(parse(evidence,'json').inventory.entryCount,after.entries.length);
  await assert.rejects(readdir(original),e=>e.code==='ENOENT');
});
async function preview(f,verb='init') {
  const result=await invoke([verb,'--workspace',f.wrapper,'--manifest',f.manifest,'--choices',f.choices]);
  assert.equal(result.code,0,result.err);await writeFile(f.preview,result.out);return JSON.parse(result.out);
}

test('S7 repository CLI parses explicit choices and isolates apply flags',()=>{
  const root=path.resolve('workspace'),file=path.resolve('choices.json');
  assert.equal(parseCommand(['wrap','--workspace',root,'--choices',file]).command,'adopt');
  for(const extra of [[],['--apply'],['--preview',file],['--apply','--preview',file,'--choices',file],
    ['--choices',file,'--network','--network'],['--choices','relative']])
    assert.throws(()=>parseCommand(['init','--workspace',root,...extra]));
});

test('S7 public preview marks missing target parents blocked before any workspace writes',async()=>{
  const f=await fixture();const manifest=JSON.parse(await readFile(f.manifest,'utf8'));
  manifest.layout.repositories.game.path='repos/project';await writeFile(f.manifest,JSON.stringify(manifest));
  const r=await invoke(['init','--workspace',f.wrapper,'--manifest',f.manifest,'--choices',f.choices]);
  assert.equal(r.code,1,r.err);const p=JSON.parse(r.out);
  assert.equal(p.preview.status,'blocked');
  assert.ok(p.preview.blockers.some(b=>b.code==='repositories.target-parent-missing'));
  await assert.rejects(readdir(f.wrapper),e=>e.code==='ENOENT');
});

test('S7 repository CLI previews from Git and applies repositories without providers',async()=>{
  const f=await fixture();const p=await preview(f);
  await assert.rejects(readdir(f.wrapper),e=>e.code==='ENOENT');
  assert.equal(p.pipelineActivated,false);
  const result=await invoke(['init','--workspace',f.wrapper,'--apply','--preview',f.preview]);
  assert.equal(result.code,0,result.err);const applied=JSON.parse(result.out);
  assert.equal(applied.status,'repositories-prepared');assert.equal(applied.pipelineActivated,false);
  assert.deepEqual(await readdir(path.join(f.wrapper,'project')),[]);
  await assert.rejects(readFile(path.join(f.wrapper,'.pipeline/repository-operation.json')),e=>e.code==='ENOENT');
  assert.ok(await readFile(applied.finalization.receiptFile));
  const inputs=await readRepositoryInputs(f.wrapper,applied.journal,applied.executionPreview.digest);
  assert.deepEqual(JSON.parse(inputs.previewText),applied.executionPreview);
  await assert.rejects(readdir(path.join(f.wrapper,'.codex')),e=>e.code==='ENOENT');
  assert.match(result.err,/repository-location/);
});

test('S7 existing wrapper retains recovery input independent of user preview file',async()=>{
  const f=await fixture();await mkdir(f.wrapper);const prepared=await preview(f);
  const result=await invoke(['init','--workspace',f.wrapper,'--apply','--preview',f.preview]);
  assert.equal(result.code,0,result.err);const applied=JSON.parse(result.out);
  await writeFile(f.preview,'user preview no longer available');
  const input=await readRepositoryInputs(f.wrapper,applied.journal,prepared.preview.digest);
  assert.deepEqual(JSON.parse(input.previewText),prepared.preview);
  await assert.rejects(readRepositoryInputs(f.wrapper,applied.journal,'sha256:'+'0'.repeat(64)),e=>e.code==='repository-inputs.preview');
  await writeFile(input.path,'{}');
  await assert.rejects(readRepositoryInputs(f.wrapper,applied.journal,prepared.preview.digest),e=>e.code==='repository-inputs.binding');
});

test('S7 repository CLI rejects stale manifest and altered preview without creating wrapper',async()=>{
  const f=await fixture();await preview(f);
  await writeFile(f.manifest,(await readFile(f.manifest,'utf8'))+'\n');
  const failed=await invoke(['init','--workspace',f.wrapper,'--apply','--preview',f.preview]);
  assert.equal(failed.code,2);assert.equal(JSON.parse(failed.err).error,'repositories.origin-drift');
  await assert.rejects(readdir(f.wrapper),e=>e.code==='ENOENT');
  const p=JSON.parse(await readFile(f.preview,'utf8'));p.choices.game.action='init';await writeFile(f.preview,JSON.stringify(p));
  assert.equal(JSON.parse((await invoke(['init','--workspace',f.wrapper,'--apply','--preview',f.preview])).err).error,'repositories.prepared-binding');
});

test('S7 repository CLI wrap preserves dirty project and does not switch origin',async()=>{
  const f=await fixture(),original=path.join(f.root,'original');await mkdir(original);
  await runGit(original,['init','--template=']);await writeFile(path.join(original,'untracked.txt'),'preserve');
  await writeFile(f.choices,JSON.stringify({game:{action:'move',from:original}}));
  await preview(f,'wrap');
  const result=await invoke(['wrap','--workspace',f.wrapper,'--apply','--preview',f.preview]);
  assert.equal(result.code,0,result.err);
  assert.equal(await readFile(path.join(f.wrapper,'project/untracked.txt'),'utf8'),'preserve');
  await assert.rejects(readdir(original),e=>e.code==='ENOENT');
});
