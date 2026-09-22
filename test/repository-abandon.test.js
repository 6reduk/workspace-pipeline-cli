import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rename} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {prepareRepositoryPreview} from '../src/workspace/repository-preview.js';
import {applyRepositoryOperations} from '../src/operations/repository-apply.js';
import {prepareRepositoryAbandon,applyRepositoryAbandon,inspectRepositoryAbandon} from '../src/operations/repository-abandon.js';
import {acquireWorkspaceLock} from '../src/operations/lock.js';
import {runCli} from '../src/commands/dispatch.js';
import {bootstrapLockDirectory} from '../src/operations/bootstrap-lock.js';

async function fixture(dead=false,completed=false){
  const base=await mkdtemp(path.join(tmpdir(),'wpc-abandon-')),wrapper=path.join(base,'wrapper');await mkdir(wrapper);
  const pipeline={schemaVersion:1,id:'example',version:'1.0.0',resources:'resources',inventory:'inventory.json',
    providers:{codex:{skills:'skills',agents:null,mcp:null,entryInstructions:null,requires:[]}},agentsDocument:{mode:'default'}};
  const workspace={schemaVersion:1,pipeline:{type:'git',transport:'local',path:'pipeline',ref:'HEAD',subdirectory:'.'},providers:['codex'],
    layout:{kind:'single-repo',repositories:{game:{path:'project',role:'code'}},documentation:{repository:'game',path:'docs'}}};
  const manifestPath=path.join(base,'workspace.json');await writeFile(manifestPath,JSON.stringify(workspace));
  const choices={game:{action:'directory'}},options={command:'init',manifestPath};
  const preview=await prepareRepositoryPreview(pipeline,workspace,wrapper,choices,options);
  const args={pipeline,workspace,wrapper,choices,options,previewText:JSON.stringify(preview),approval:{decision:'approve',previewDigest:preview.digest}};
  if(completed)await applyRepositoryOperations(args);
  else if(dead){
    const url=new URL('../src/operations/repository-apply.js',import.meta.url).href;
    await promisify(execFile)(process.execPath,['--input-type=module','-e',`import {applyRepositoryOperations} from ${JSON.stringify(url)};
      await applyRepositoryOperations({...JSON.parse(process.argv[1]),ioBoundary:async phase=>{if(phase==='after-effect')process.exit(0)}});process.exit(9);`,JSON.stringify(args)]);
  }else await assert.rejects(applyRepositoryOperations({...args,ioBoundary:async phase=>{if(phase==='after-effect')throw Error('injected');}}));
  if(!completed)await writeFile(path.join(wrapper,'project','user.txt'),'partial result remains user data');return {base,wrapper};
}

test('S7 abandonment refuses a finalizable completion without writing history',async()=>{
  const f=await fixture(false,true),before=await readdir(f.base);
  const marker=await readFile(path.join(f.wrapper,'.pipeline/repository-operation.json'));
  await assert.rejects(prepareRepositoryAbandon(f.wrapper),e=>e.code==='repository-abandon.finalizable');
  assert.deepEqual(await readdir(f.base),before);
  assert.deepEqual(await readFile(path.join(f.wrapper,'.pipeline/repository-operation.json')),marker);
});
test('S7 explicit abandonment preserves uncertain data and journal, never asserts completion',async()=>{
  const f=await fixture(),p=await prepareRepositoryAbandon(f.wrapper);
  const journalBefore=await readFile(path.join(f.wrapper,'.pipeline/repository-operation.json'));
  const result=await applyRepositoryAbandon(f.wrapper,p);
  assert.equal(result.completed,false);assert.equal(result.pipelineActivated,false);
  assert.deepEqual(await readFile(path.join(result.archive,'0')),journalBefore);
  assert.equal(await readFile(path.join(f.wrapper,'project/user.txt'),'utf8'),'partial result remains user data');
  const done=await inspectRepositoryAbandon(f.wrapper,p.attempt);assert.equal(done.gateActive,false);
  const lock=await acquireWorkspaceLock(f.wrapper);await lock.release();
});
test('S7 abandonment rejects stale observed trees before archive creation',async()=>{
  const f=await fixture(),p=await prepareRepositoryAbandon(f.wrapper),before=await readdir(f.base);
  await writeFile(path.join(f.wrapper,'project/user.txt'),'changed');
  await assert.rejects(applyRepositoryAbandon(f.wrapper,p),e=>e.code==='repository-abandon.stale');
  assert.deepEqual(await readdir(f.base),before);
});
test('S7 abandonment refuses incomplete owner schema without modifying pending records',async()=>{
  const f=await fixture(true),filename=path.join(bootstrapLockDirectory(f.wrapper),'owner.json');
  const owner=JSON.parse(await readFile(filename,'utf8'));delete owner.token;await writeFile(filename,JSON.stringify(owner));
  const marker=await readFile(path.join(f.wrapper,'.pipeline/repository-operation.json'));
  await assert.rejects(prepareRepositoryAbandon(f.wrapper),e=>e.code==='repository-abandon.owner-binding');
  assert.deepEqual(await readFile(path.join(f.wrapper,'.pipeline/repository-operation.json')),marker);
});
test('S7 abandonment preserves pending marker on guard tamper and refuses live continuation',async()=>{
  const f=await fixture(),p=await prepareRepositoryAbandon(f.wrapper);
  await assert.rejects(applyRepositoryAbandon(f.wrapper,p,{ioBoundary:async phase=>{
    if(phase==='abandon-guard-created')throw Error('pause');
  }}),/pause/);
  const o=await inspectRepositoryAbandon(f.wrapper,p.attempt);
  await assert.rejects(applyRepositoryAbandon(f.wrapper,o,{continuation:true}),e=>e.code==='repository-abandon.owner-live');
  const marker=await readFile(path.join(f.wrapper,'.pipeline/repository-operation.json'));
  assert.ok(marker.length>0);assert.equal(o.locations[0],'source');
});
test('S7 abandonment stops on data drift after marker move and preserves all remaining locks',async()=>{
  const f=await fixture(true),p=await prepareRepositoryAbandon(f.wrapper);
  await assert.rejects(applyRepositoryAbandon(f.wrapper,p,{ioBoundary:async phase=>{
    if(phase==='abandon-moved-0')await writeFile(path.join(f.wrapper,'project/user.txt'),'concurrent user edit');
  }}),e=>e.code==='repository-abandon.subject-drift');
  assert.ok((await readdir(path.join(f.wrapper,'.pipeline/lock'))).includes('owner.json'));
  assert.equal(await readFile(path.join(f.wrapper,'project/user.txt'),'utf8'),'concurrent user edit');
});
for(const phase of ['abandon-guard-created','abandon-moved-0','abandon-moved-1','abandon-moved-2','abandon-receipt']){
  test('S7 abandonment resumes after actual process exit at '+phase,async()=>{
    const f=await fixture(true),p=await prepareRepositoryAbandon(f.wrapper);
    const url=new URL('../src/operations/repository-abandon.js',import.meta.url).href;
    await promisify(execFile)(process.execPath,['--input-type=module','-e',`import {applyRepositoryAbandon} from ${JSON.stringify(url)};
      const p=JSON.parse(process.argv[1]);await applyRepositoryAbandon(p.wrapper,p,{ioBoundary:async phase=>{if(phase===${JSON.stringify(phase)})process.exit(0)}});process.exit(9);`,JSON.stringify(p)]);
    const o=await inspectRepositoryAbandon(f.wrapper,p.attempt);
    const result=await applyRepositoryAbandon(f.wrapper,o,{continuation:true});assert.equal(result.completed,false);
    assert.equal((await inspectRepositoryAbandon(f.wrapper,p.attempt)).gateActive,false);
    assert.equal((await readdir(result.archive)).filter(n=>n.startsWith('authorization-')).length,1);
    assert.equal(await readFile(path.join(f.wrapper,'project/user.txt'),'utf8'),'partial result remains user data');
  });
}
test('S7 public abandon uses exact preview and rejects continuation selector override',async()=>{
  const f=await fixture();let out='',err='';const io={stdout:s=>{out+=s;},stderr:s=>{err+=s;}};
  assert.equal(await runCli(['repositories','abandon','--workspace',f.wrapper],io),0,err);
  const p=JSON.parse(out),file=path.join(f.base,'approval.json');await writeFile(file,out);out='';
  assert.equal(await runCli(['repositories','abandon','--workspace',f.wrapper,'--apply','--preview',file],io),0,err);
  assert.equal(JSON.parse(out).completed,false);
  out='';assert.equal(await runCli(['repositories','continue-abandon','--workspace',f.wrapper,'--attempt',p.attempt],io),0,err);
});

test('S7 abandonment continuation binds ordered authorization history after repeated process deaths',async()=>{
  const f=await fixture(true),p=await prepareRepositoryAbandon(f.wrapper);
  const url=new URL('../src/operations/repository-abandon.js',import.meta.url).href;
  async function crash(value,continuation,phase){
    await assert.rejects(promisify(execFile)(process.execPath,['--input-type=module','-e',
      `import {applyRepositoryAbandon} from ${JSON.stringify(url)};
       const p=JSON.parse(process.argv[1]);await applyRepositoryAbandon(p.wrapper,p,{continuation:${continuation},ioBoundary:async phase=>{if(phase===${JSON.stringify(phase)})process.exit(77)}});process.exit(9);`,JSON.stringify(value)],{windowsHide:true}),e=>e.code===77);
  }
  await crash(p,false,'abandon-guard-created');
  await crash(await inspectRepositoryAbandon(f.wrapper,p.attempt),true,'abandon-continuation-approved');
  await crash(await inspectRepositoryAbandon(f.wrapper,p.attempt),true,'abandon-continuation-approved');
  const archive=path.join(f.base,'.wpc-repository-resolution-'+p.attempt);
  const first=path.join(archive,'authorization-0001.json'),second=path.join(archive,'authorization-0002.json');
  const bytes=await readFile(first),later=JSON.parse(await readFile(second,'utf8'));
  assert.equal(later.sequence,2);assert.equal(later.previousApprovals.length,1);
  await writeFile(first,Buffer.concat([bytes,Buffer.from(' ')]));
  await assert.rejects(inspectRepositoryAbandon(f.wrapper,p.attempt),e=>e.code==='repository-abandon.approval');
  await writeFile(first,bytes);await rename(second,path.join(archive,'authorization-0003.json'));
  await assert.rejects(inspectRepositoryAbandon(f.wrapper,p.attempt),e=>e.code==='repository-abandon.approval-sequence');
  await rename(path.join(archive,'authorization-0003.json'),second);
  const result=await applyRepositoryAbandon(f.wrapper,await inspectRepositoryAbandon(f.wrapper,p.attempt),{continuation:true});
  assert.equal(result.completed,false);
  assert.equal((await readdir(archive)).filter(n=>n.startsWith('authorization-')).length,3);
});
