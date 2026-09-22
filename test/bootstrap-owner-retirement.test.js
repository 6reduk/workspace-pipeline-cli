import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,mkdir,readFile,readdir,writeFile,rename} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {acquireBootstrapLock,bootstrapLockDirectory} from '../src/operations/bootstrap-lock.js';
import {prepareBootstrapOwnerRetirement,applyBootstrapOwnerRetirement,verifyBootstrapOwnerRetirement} from '../src/operations/bootstrap-owner-retirement.js';
import {runCli} from '../src/commands/dispatch.js';
import {listRepositoryHistory} from '../src/operations/repository-history.js';

async function fixture(dead=true) {
  const parent=await mkdtemp(path.join(tmpdir(),'wpc-owner-retire-')),wrapper=path.join(parent,'wrapper');
  if(dead){
    const url=new URL('../src/operations/bootstrap-lock.js',import.meta.url).href;
    await promisify(execFile)(process.execPath,['--input-type=module','-e',
      `import {acquireBootstrapLock} from ${JSON.stringify(url)}; await acquireBootstrapLock(process.argv[1]);process.exit(0);`,wrapper],
      {windowsHide:true,timeout:30000});
  }
  return {parent,wrapper};
}
test('S7 owner-only retirement uses CLI exact approval and preserves original bytes',async()=>{
  const f=await fixture(),before=await readFile(path.join(bootstrapLockDirectory(f.wrapper),'owner.json'));
  const command=['repositories','retire-bootstrap','--workspace',f.wrapper];
  let out='',err='';assert.equal(await runCli(command,{stdout:s=>{out+=s;},stderr:s=>{err+=s;}}),0,err);
  const preview=JSON.parse(out),file=path.join(f.parent,'preview.json');await writeFile(file,out);
  out='';err='';assert.equal(await runCli([...command,'--apply','--preview',file],{stdout:s=>{out+=s;},stderr:s=>{err+=s;}}),0,err);
  assert.equal(JSON.parse(out).repositoryEffectsPerformed,false);
  assert.deepEqual(await readFile(path.join(preview.history,'lock/owner.json')),before);
  await assert.rejects(readdir(f.wrapper),e=>e.code==='ENOENT');
  const listed=await listRepositoryHistory(f.wrapper);
  assert.ok(listed.entries.some(e=>e.path===preview.history && !e.deletionEligible));
  const next=await acquireBootstrapLock(f.wrapper);await next.release();
  assert.equal((await verifyBootstrapOwnerRetirement(f.wrapper,preview.history)).status,'bootstrap-owner-attempt-archived');
  await assert.rejects(applyBootstrapOwnerRetirement(f.wrapper,preview));
});
test('S7 owner-only retirement refuses live, unknown, incomplete and nonempty states',async()=>{
  const live=await fixture(false),lock=await acquireBootstrapLock(live.wrapper);
  const blocked=await prepareBootstrapOwnerRetirement(live.wrapper);assert.equal(blocked.status,'blocked');
  await assert.rejects(applyBootstrapOwnerRetirement(live.wrapper,blocked));await lock.release();
  for(const mode of ['empty','torn','foreign','intent','wrapper']) {
    const f=await fixture(mode!=='empty'),dir=bootstrapLockDirectory(f.wrapper);
    if(mode==='empty')await mkdir(dir);
    if(mode==='torn')await writeFile(path.join(dir,'owner.json'),'{');
    if(mode==='foreign')await writeFile(path.join(dir,'foreign.txt'),'preserve');
    if(mode==='intent')await writeFile(path.join(dir,'intent.json'),'{}');
    if(mode==='wrapper')await mkdir(f.wrapper);
    const before=await readdir(f.parent);
    await assert.rejects(prepareBootstrapOwnerRetirement(f.wrapper));
    assert.deepEqual(await readdir(f.parent),before);
  }
  const f=await fixture(),file=path.join(bootstrapLockDirectory(f.wrapper),'owner.json');
  const owner=JSON.parse(await readFile(file,'utf8'));owner.host='another-host';await writeFile(file,JSON.stringify(owner));
  assert.equal((await prepareBootstrapOwnerRetirement(f.wrapper)).status,'blocked');
});
for(const phase of ['bootstrap-retirement-history-created','bootstrap-retirement-request-retained','bootstrap-retirement-lock-archived']) {
test('S7 owner-only retirement preserves interrupted history at '+phase,async()=>{
  const f=await fixture(),preview=await prepareBootstrapOwnerRetirement(f.wrapper);
  const url=new URL('../src/operations/bootstrap-owner-retirement.js',import.meta.url).href;
  const code=`import {applyBootstrapOwnerRetirement} from ${JSON.stringify(url)};
    const p=JSON.parse(process.argv[1]);await applyBootstrapOwnerRetirement(p.wrapper,p,{ioBoundary:async phase=>{
      if(phase===${JSON.stringify(phase)})process.exit(0);
    }});process.exit(9);`;
  await promisify(execFile)(process.execPath,['--input-type=module','-e',code,JSON.stringify(preview)],{windowsHide:true,timeout:30000});
  const files=await readdir(preview.history);
  if(phase==='bootstrap-retirement-lock-archived') {
    assert.equal((await verifyBootstrapOwnerRetirement(f.wrapper,preview.history)).status,'bootstrap-owner-attempt-archived');
  } else {
    await assert.rejects(acquireBootstrapLock(f.wrapper),e=>e.code==='bootstrap-lock.busy');
    await assert.rejects(applyBootstrapOwnerRetirement(f.wrapper,preview),e=>e.code==='bootstrap-retire.destination-exists');
    const fresh=await prepareBootstrapOwnerRetirement(f.wrapper);assert.notEqual(fresh.history,preview.history);
    await applyBootstrapOwnerRetirement(f.wrapper,fresh);
  }
  assert.deepEqual(await readdir(preview.history),files);
  const lock=await acquireBootstrapLock(f.wrapper);await lock.release();
});
}
test('S7 owner-only retirement refuses drift before rename and does not overwrite data',async()=>{
  const f=await fixture(),preview=await prepareBootstrapOwnerRetirement(f.wrapper);
  await assert.rejects(applyBootstrapOwnerRetirement(f.wrapper,preview,{ioBoundary:async phase=>{
    if(phase==='bootstrap-retirement-request-retained')await mkdir(f.wrapper);
  }}),e=>e.code==='bootstrap-retire.wrapper-exists');
  assert.deepEqual(await readdir(f.wrapper),[]);
  assert.ok(await readFile(path.join(bootstrapLockDirectory(f.wrapper),'owner.json')));
  assert.deepEqual(await readdir(preview.history),['request.json']);
});

test('S7 owner-only retirement checks history identity before request publication',async()=>{
  const f=await fixture(),preview=await prepareBootstrapOwnerRetirement(f.wrapper);
  await assert.rejects(applyBootstrapOwnerRetirement(f.wrapper,preview,{ioBoundary:async phase=>{
    if(phase==='bootstrap-retirement-history-created'){
      await rename(preview.history,preview.history+'-preserved');await mkdir(preview.history);
    }
  }}),e=>e.code==='bootstrap-retire.history-drift');
  assert.deepEqual(await readdir(preview.history),[]);
  assert.ok(await readFile(path.join(bootstrapLockDirectory(f.wrapper),'owner.json')));
});
