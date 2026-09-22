import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,writeFile,readFile,readdir,mkdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {contractDigest} from '../src/contracts/semantic.js';
import {prepareRepositoryPreview} from '../src/workspace/repository-preview.js';
import {prepareBootstrapRecovery,applyBootstrapRecovery,runBootstrapContinuation} from '../src/commands/bootstrap-recovery.js';
import {bootstrapLockDirectory} from '../src/operations/bootstrap-lock.js';
import {createRepositoryWrapper} from '../src/operations/repository-bootstrap.js';

async function fixture(phase){
  const root=await mkdtemp(path.join(tmpdir(),'wpc-bootstrap-command-')),wrapper=path.join(root,'wrapper');
  const pipeline={schemaVersion:1,id:'example',version:'1.0.0',resources:'resources',inventory:'inventory.json',
    providers:{codex:{skills:'skills',agents:null,mcp:null,entryInstructions:null,requires:[]}},agentsDocument:{mode:'default'}};
  const workspace={schemaVersion:1,pipeline:{type:'git',transport:'local',path:'unavailable-source',ref:'HEAD',subdirectory:'.'},providers:['codex'],
    layout:{kind:'single-repo',repositories:{game:{path:'project',role:'code'}},documentation:{repository:'game',path:'docs'}}};
  const manifestPath=path.join(root,'workspace.json');await writeFile(manifestPath,JSON.stringify(workspace));
  const choices={game:{action:'directory'}},options={command:'init',manifestPath};
  const preview=await prepareRepositoryPreview(pipeline,workspace,wrapper,choices,options);
  const f={pipeline,workspace,wrapper,choices,options,previewText:JSON.stringify(preview),approval:{decision:'approve',previewDigest:preview.digest}};
  if(phase){
    const url=new URL('../src/operations/repository-bootstrap.js',import.meta.url).href;
    await promisify(execFile)(process.execPath,['--input-type=module','-e',`import {createRepositoryWrapper} from ${JSON.stringify(url)};
      await createRepositoryWrapper({...JSON.parse(process.argv[1]),ioBoundary:async phase=>{if(phase===${JSON.stringify(phase)})process.exit(0);}});process.exit(9);`,JSON.stringify(f)],{windowsHide:true,timeout:30000});
  }
  return {...f,root,preview};
}
function envelope(f){
  const body={schemaVersion:1,kind:'prepared-repository-command',command:'init',wrapper:f.wrapper,
    origin:{origin:{path:f.options.manifestPath}},acquired:{snapshotPath:path.join(f.root,'unavailable-snapshot')},choices:f.choices,
    options:{...f.options,tempRoot:f.root,network:false},preview:f.preview,finalization:'verify-and-retain-history',pipelineActivated:false};
  return {...body,digest:contractDigest(body)};
}
for(const [phase,outer,status] of [['wrapper-intent-persisted',false,'bootstrap-attempt-archived'],['wrapper-receipt-persisted',true,'bootstrap-recovered']]){
test('S7 first bootstrap public handler recovers stopped '+phase+' without source lookup',async()=>{
  const f=await fixture(phase),original=path.join(f.root,'original.json');await writeFile(original,JSON.stringify(outer?envelope(f):f.preview));
  let out='';assert.equal(await runBootstrapContinuation({action:'recover-bootstrap',workspace:f.wrapper,bootstrapPreview:original},s=>{out+=s;}),0);
  const p=JSON.parse(out);assert.equal(p.status,'review-only');assert.equal(p.ownerStopped,true);
  const approved=path.join(f.root,'fresh.json');await writeFile(approved,out);out='';
  assert.equal(await runBootstrapContinuation({action:'recover-bootstrap',workspace:f.wrapper,apply:true,previewFile:approved},s=>{out+=s;}),0);
  assert.equal(JSON.parse(out).status,status);assert.equal(JSON.parse(out).pipelineActivated,false);
  if(phase==='wrapper-intent-persisted')await assert.rejects(readdir(f.wrapper),e=>e.code==='ENOENT');
  else assert.deepEqual(await readdir(f.wrapper),['.pipeline']);
});}
test('S7 first bootstrap recovery refuses original hash/workspace corruption and stale observations',async()=>{
  const f=await fixture('wrapper-intent-persisted'),before=await readdir(f.root),outer=envelope(f);
  await assert.rejects(prepareBootstrapRecovery(path.join(f.root,'other'),outer),e=>e.code==='bootstrap-recover.original-binding');
  await assert.rejects(prepareBootstrapRecovery(f.wrapper,{...outer,digest:'sha256:'+'0'.repeat(64)}),e=>e.code==='bootstrap-recover.original-binding');
  const bad={...outer,preview:{...outer.preview,wrapper:path.join(f.root,'other')}};delete bad.digest;bad.digest=contractDigest(bad);
  await assert.rejects(prepareBootstrapRecovery(f.wrapper,bad),e=>e.code==='bootstrap-recover.original-binding');
  assert.deepEqual(await readdir(f.root),before);
  const p=await prepareBootstrapRecovery(f.wrapper,outer);await mkdir(f.wrapper);
  const dirs=await readdir(f.root);
  await assert.rejects(applyBootstrapRecovery(f.wrapper,p),e=>e.code==='bootstrap-recover.preview-stale');
  assert.deepEqual(await readdir(f.root),dirs);assert.deepEqual(await readdir(f.wrapper),[]);
});
test('S7 first bootstrap recovery blocks live owner and malformed or unavailable input without writes',async()=>{
  const f=await fixture();
  await assert.rejects(createRepositoryWrapper({...f,ioBoundary:async phase=>{if(phase==='wrapper-intent-persisted')throw Error('stop');}}));
  const ownerFile=path.join(bootstrapLockDirectory(f.wrapper),'owner.json'),bytes=await readFile(ownerFile);
  const p=await prepareBootstrapRecovery(f.wrapper,f.preview);assert.equal(p.status,'blocked');assert.equal(p.ownerStopped,false);
  await assert.rejects(applyBootstrapRecovery(f.wrapper,p),e=>e.code==='bootstrap-recover.preview-approval');
  const malformed=path.join(f.root,'malformed.json');await writeFile(malformed,'{');const before=await readdir(f.root);
  for(const input of [malformed,path.join(f.root,'missing.json')])await assert.rejects(runBootstrapContinuation({action:'recover-bootstrap',workspace:f.wrapper,bootstrapPreview:input},()=>{}));
  assert.deepEqual(await readdir(f.root),before);assert.deepEqual(await readFile(ownerFile),bytes);
  await writeFile(ownerFile,'null');
  assert.equal((await prepareBootstrapRecovery(f.wrapper,f.preview)).status,'blocked');
  assert.equal(await readFile(ownerFile,'utf8'),'null');
});
