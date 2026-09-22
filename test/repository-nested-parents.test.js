import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {runCli} from '../src/commands/dispatch.js';
import {prepareRepositoryPreview} from '../src/workspace/repository-preview.js';
import {applyRepositoryWorkspace} from '../src/operations/repository-workspace.js';
import {inspectRepositoryReconciliation} from '../src/operations/repository-reconcile.js';

async function call(args){let out='',err='';const code=await runCli(args,{stdout:s=>out+=s,stderr:s=>err+=s});assert.equal(code,0,err);return JSON.parse(out);}
for(const existing of [false,true])test(`nested repository layout uses explicit parent preparation (${existing?'quiescent existing':'absent'} wrapper)`,async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wpc-nested-parents-')),wrapper=path.join(root,'wrapper');
  if(existing){await mkdir(wrapper);await writeFile(path.join(wrapper,'foreign.txt'),'preserve');}
  const pipeline={schemaVersion:1,id:'fixture',version:'1.0.0',resources:'resources',inventory:'inventory.json',agentsDocument:{mode:'default'},
    providers:{codex:{skills:'skills',agents:null,mcp:null,entryInstructions:null,requires:[]}}};
  const workspace={schemaVersion:1,pipeline:{type:'git',transport:'local',path:'pipeline',ref:'HEAD',subdirectory:'.'},providers:['codex'],
    layout:{kind:'multi-repo',repositories:{api:{path:'repos/api',role:'code'},documentation:{path:'repos/documentation',role:'documentation'}},
      documentation:{repository:'documentation',path:'docs'}}};
  const manifestPath=path.join(root,'workspace.json');await writeFile(manifestPath,JSON.stringify(workspace));
  const choices={api:{action:'directory'},documentation:{action:'directory'}},options={command:'init',manifestPath};
  const original=await prepareRepositoryPreview(pipeline,workspace,wrapper,choices,options);
  assert.equal(original.status,'blocked');assert.ok(original.blockers.some(b=>b.code==='repositories.target-parent-missing'));
  const sentinel=path.join(wrapper,'repos/api');
  const parents=await call(['repositories','prepare-parent','--workspace',sentinel]);
  assert.deepEqual(parents.targets,existing?[path.join(wrapper,'repos')]:[wrapper,path.join(wrapper,'repos')]);
  await assert.rejects(readdir(path.join(wrapper,'repos')),e=>e.code==='ENOENT');
  const file=path.join(root,'parents.json');await writeFile(file,JSON.stringify(parents));
  const prepared=await call(['repositories','prepare-parent','--workspace',sentinel,'--apply','--preview',file]);
  assert.equal(prepared.requiresRepositoryPreview,true);assert.equal(prepared.repositoryEffectsPerformed,false);
  assert.deepEqual(await readdir(path.join(wrapper,'repos')),[]);
  const projection=JSON.parse(await readFile(path.join(parents.history,'projection.json'),'utf8'));
  assert.deepEqual(projection.directories.map(d=>d.target),parents.targets);
  assert.equal(JSON.parse(await readFile(path.join(parents.history,'receipt.json'),'utf8')).status,'parent-directories-created');
  await assert.rejects(applyRepositoryWorkspace({pipeline,workspace,wrapper,choices,options,previewText:JSON.stringify(original),approval:{decision:'approve',previewDigest:original.digest}}));
  const fresh=await prepareRepositoryPreview(pipeline,workspace,wrapper,choices,options);
  assert.deepEqual(fresh.blockers,[]);assert.equal(fresh.wrapperObservation.action,'keep');
  const applied=await applyRepositoryWorkspace({pipeline,workspace,wrapper,choices,options,previewText:JSON.stringify(fresh),approval:{decision:'approve',previewDigest:fresh.digest}});
  assert.deepEqual(applied.result.operations.map(o=>o.status),['completed','completed']);
  assert.deepEqual(await readdir(path.join(wrapper,'repos/api')),[]);assert.deepEqual(await readdir(path.join(wrapper,'repos/documentation')),[]);
  const checked=await inspectRepositoryReconciliation(wrapper,JSON.stringify(fresh),fresh.digest);assert.equal(checked.canFinalize,true);
  if(existing)assert.equal(await readFile(path.join(wrapper,'foreign.txt'),'utf8'),'preserve');
});
