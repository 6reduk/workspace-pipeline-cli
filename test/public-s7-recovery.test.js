import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {runCli,parseCommand} from '../src/commands/dispatch.js';
import {applyRepositoryAncestors} from '../src/operations/repository-ancestors.js';
import {prepareRepositoryPreview} from '../src/workspace/repository-preview.js';
import {applyRepositoryOperations} from '../src/operations/repository-apply.js';

async function call(args){let out='',err='';const code=await runCli(args,{stdout:s=>out+=s,stderr:s=>err+=s});return {code,out,err,value:out?JSON.parse(out):null};}
const command=(action,workspace,...args)=>['repositories',action,'--workspace',workspace,...args];
async function saved(root,name,r){const file=path.join(root,name);await writeFile(file,r.out);return file;}

test('S7 public parent and abandonment parser rejects ambiguous selectors and unpaired approval',()=>{
  const root=path.resolve('synthetic'),file=path.join(root,'preview.json'),id='11111111-1111-1111-1111-111111111111';
  const bad=[['prepare-parent','--parent-preview',file],['prepare-parent','--attempt',id],['prepare-parent','--apply'],
    ['continue-parent'],['continue-parent','--preview',file],['continue-parent','--parent-preview',file,'--apply','--preview',file],
    ['abandon','--attempt',id],['abandon','--journal',id],['continue-abandon'],['continue-abandon','--attempt','../escape'],
    ['continue-abandon','--attempt',id,'--apply'],['continue-abandon','--attempt',id,'--preview',file]];
  for(const [action,...args] of bad)assert.throws(()=>parseCommand(command(action,root,...args)),JSON.stringify([action,...args]));
  assert.equal(parseCommand(command('continue-parent',root,'--parent-preview',file)).parentPreview,file);
  assert.equal(parseCommand(command('continue-abandon',root,'--attempt',id)).attempt,id);
});

test('S7 public parent preview is read-only; wrong workspace and stale foreign target preserve data',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wpc-public-parent-')),wrapper=path.join(root,'one','two','wrapper');
  const p=await call(command('prepare-parent',wrapper));assert.equal(p.code,0,p.err);assert.deepEqual(await readdir(root),[]);
  const file=await saved(root,'preview.json',p),other=path.join(root,'other','wrapper');
  assert.equal((await call(command('prepare-parent',other,'--apply','--preview',file))).code,2);
  await assert.rejects(readdir(path.join(root,'one')),e=>e.code==='ENOENT');
  await mkdir(path.join(root,'one'));await writeFile(path.join(root,'one','foreign.txt'),'preserve');
  assert.equal((await call(command('prepare-parent',wrapper,'--apply','--preview',file))).code,2);
  assert.equal(await readFile(path.join(root,'one','foreign.txt'),'utf8'),'preserve');
  await assert.rejects(readdir(path.join(root,'one','two')),e=>e.code==='ENOENT');
});

test('S7 public parent continuation binds original preview and refuses foreign staged content',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wpc-public-parent-')),wrapper=path.join(root,'one','two','wrapper');
  const p=await call(command('prepare-parent',wrapper)),file=await saved(root,'preview.json',p);
  await assert.rejects(applyRepositoryAncestors(p.value,{ioBoundary:async phase=>{if(phase==='ancestors-projection-retained')throw Error('synthetic stop');}}));
  const observation=await call(command('continue-parent',wrapper,'--parent-preview',file));assert.equal(observation.code,0,observation.err);
  const approval=await saved(root,'continue.json',observation);
  assert.equal((await call(command('continue-parent',path.join(root,'other'),'--apply','--preview',approval))).code,2);
  const foreign=path.join(p.value.history,'tree','two','foreign');await writeFile(foreign,'keep');
  assert.equal((await call(command('continue-parent',wrapper,'--apply','--preview',approval))).code,2);
  assert.equal(await readFile(foreign,'utf8'),'keep');await assert.rejects(readdir(path.join(root,'one')),e=>e.code==='ENOENT');
});

test('S7 public abandonment wrong workspace refuses; approved abandonment preserves partial foreign data',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wpc-public-abandon-')),wrapper=path.join(root,'wrapper'),other=path.join(root,'other');await mkdir(wrapper);await mkdir(other);
  const pipeline={schemaVersion:1,id:'fixture',version:'1.0.0',resources:'resources',inventory:'inventory.json',agentsDocument:{mode:'default'},
    providers:{codex:{skills:'skills',agents:null,mcp:null,entryInstructions:null,requires:[]}}};
  const workspace={schemaVersion:1,pipeline:{type:'git',transport:'local',path:'pipeline',ref:'HEAD',subdirectory:'.'},providers:['codex'],
    layout:{kind:'single-repo',repositories:{game:{path:'project',role:'code'}},documentation:{repository:'game',path:'docs'}}};
  const manifestPath=path.join(root,'workspace.json');await writeFile(manifestPath,JSON.stringify(workspace));
  const choices={game:{action:'directory'}},options={command:'init',manifestPath};
  const p=await prepareRepositoryPreview(pipeline,workspace,wrapper,choices,options);
  await assert.rejects(applyRepositoryOperations({pipeline,workspace,wrapper,choices,options,previewText:JSON.stringify(p),approval:{decision:'approve',previewDigest:p.digest},
    ioBoundary:async phase=>{if(phase==='after-effect')throw Error('synthetic stop');}}));
  const foreign=path.join(wrapper,'project/foreign.txt');await writeFile(foreign,'partial data');
  const r=await call(command('abandon',wrapper));assert.equal(r.code,0,r.err);const file=await saved(root,'abandon.json',r);
  const marker=await readFile(path.join(wrapper,'.pipeline/repository-operation.json'));
  assert.equal((await call(command('abandon',other,'--apply','--preview',file))).code,2);assert.deepEqual(await readdir(other),[]);
  assert.deepEqual(await readFile(path.join(wrapper,'.pipeline/repository-operation.json')),marker);
  const result=await call(command('abandon',wrapper,'--apply','--preview',file));assert.equal(result.code,0,result.err);
  assert.equal(result.value.completed,false);assert.equal(result.value.pipelineActivated,false);assert.equal(await readFile(foreign,'utf8'),'partial data');
  const continued=await call(command('continue-abandon',wrapper,'--attempt',r.value.attempt));assert.equal(continued.code,0,continued.err);
  const resume=await saved(root,'continue-abandon.json',continued);
  assert.equal((await call(command('continue-abandon',wrapper,'--attempt','11111111-1111-1111-1111-111111111111','--apply','--preview',resume))).code,2);
});
