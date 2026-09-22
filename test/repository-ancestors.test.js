import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,mkdir,readdir,readFile,writeFile,rename,lstat,symlink} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {prepareRepositoryAncestors,applyRepositoryAncestors,inspectRepositoryAncestors,finishRepositoryAncestors} from '../src/operations/repository-ancestors.js';
import {acquireRecoveryLease} from '../src/operations/recovery-lease.js';

async function fixture(){const root=await mkdtemp(path.join(tmpdir(),'wpc-ancestors-'));return {root,wrapper:path.join(root,'first','second','wrapper')};}
test('S7 ancestors create exactly approved parents, not wrapper, and preserve projection identities',async()=>{
  const f=await fixture(),p=await prepareRepositoryAncestors(f.wrapper),before=await readdir(f.root);
  assert.deepEqual(before,[]);assert.deepEqual(p.targets,[path.join(f.root,'first'),path.join(f.root,'first','second')]);
  const result=await applyRepositoryAncestors(p);assert.equal(result.requiresRepositoryPreview,true);
  assert.equal((await inspectRepositoryAncestors(p)).status,'completed');assert.deepEqual(await readdir(path.dirname(f.wrapper)),[]);
  const projection=JSON.parse(await readFile(path.join(p.history,'projection.json'),'utf8'));
  for(const d of projection.directories){const s=await lstat(d.target,{bigint:true});assert.equal(String(s.ino),d.identity.ino);}
  await assert.rejects(applyRepositoryAncestors(p),e=>e.code==='ancestors.destination-exists');
});
test('S7 ancestors refuse present parents, links, malformed preview, depth and path excess',async()=>{
  const f=await fixture();await assert.rejects(prepareRepositoryAncestors(path.join(f.root,'wrapper')),e=>e.code==='ancestors.parent-present');
  await assert.rejects(prepareRepositoryAncestors(path.join(f.root,...Array(33).fill('a'),'w')),e=>e.code==='ancestors.depth');
  await assert.rejects(prepareRepositoryAncestors(path.join(f.root,'a'.repeat(1100),'w')));
  const p=await prepareRepositoryAncestors(f.wrapper);await assert.rejects(applyRepositoryAncestors({...p,extra:true}),e=>e.code==='ancestors.preview');
  await assert.rejects(applyRepositoryAncestors({...p,attemptId:'-'.repeat(36)}),e=>e.code==='ancestors.preview');
  await assert.rejects(applyRepositoryAncestors({...p,targets:[p.history],wrapper:path.join(p.history,'w')}),e=>e.code==='ancestors.preview');
  const actual=path.join(f.root,'actual');await mkdir(actual);await symlink(actual,path.join(f.root,'first'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(prepareRepositoryAncestors(f.wrapper),e=>e.code==='layout.link');
  await assert.rejects(applyRepositoryAncestors(p));
});
test('S7 ancestors use one lease for competing first missing ancestor and reject destination drift',async()=>{
  const f=await fixture(),p=await prepareRepositoryAncestors(f.wrapper),lease=await acquireRecoveryLease(p.targets[0]);
  await assert.rejects(applyRepositoryAncestors(p),e=>e.code.startsWith('recovery-lease.busy'));await lease.release();
  await assert.rejects(applyRepositoryAncestors(p,{ioBoundary:async phase=>{if(phase==='ancestors-projection-retained')await mkdir(p.targets[0]);}}),e=>e.code==='ancestors.destination-exists');
  assert.deepEqual(await readdir(p.targets[0]),[]);assert.ok(await readFile(path.join(p.history,'projection.json')));
});
for(const phase of ['ancestors-history-created','ancestors-request-retained','ancestors-staged-directory','ancestors-projection-retained','ancestors-published','ancestors-receipt-persisted']){
test('S7 ancestors retain crash state at '+phase,async()=>{
  const f=await fixture(),p=await prepareRepositoryAncestors(f.wrapper),url=new URL('../src/operations/repository-ancestors.js',import.meta.url).href;
  const code=`import {applyRepositoryAncestors} from ${JSON.stringify(url)};await applyRepositoryAncestors(JSON.parse(process.argv[1]),{ioBoundary:async phase=>{if(phase===${JSON.stringify(phase)})process.exit(0);}});process.exit(8);`;
  await promisify(execFile)(process.execPath,['--input-type=module','-e',code,JSON.stringify(p)],{windowsHide:true,timeout:30000});
  const history=await readdir(p.history);
  if(['ancestors-projection-retained','ancestors-published','ancestors-receipt-persisted'].includes(phase)){
    const observation=await inspectRepositoryAncestors(p);
    await assert.rejects(finishRepositoryAncestors(p,'sha256:'+'0'.repeat(64)),e=>e.code==='ancestors.approval-drift');
    await finishRepositoryAncestors(p,observation.digest);assert.equal((await inspectRepositoryAncestors(p)).status,'completed');
  }else{
    await assert.rejects(inspectRepositoryAncestors(p));await assert.rejects(readdir(p.targets[0]),e=>e.code==='ENOENT');
    const fresh=await prepareRepositoryAncestors(f.wrapper);await applyRepositoryAncestors(fresh);assert.deepEqual(await readdir(p.history),history);
  }
  await assert.rejects(readdir(f.wrapper),e=>e.code==='ENOENT');
});}
test('S7 ancestors refuse foreign staging entries and preserve them without cleanup',async()=>{
  const f=await fixture(),p=await prepareRepositoryAncestors(f.wrapper);
  await assert.rejects(applyRepositoryAncestors(p,{ioBoundary:async phase=>{
    if(phase==='ancestors-projection-retained')await writeFile(path.join(p.history,'tree','second','foreign'),'keep');
  }}),e=>e.code==='ancestors.foreign-entry');
  assert.equal(await readFile(path.join(p.history,'tree','second','foreign'),'utf8'),'keep');
  await assert.rejects(readdir(p.targets[0]),e=>e.code==='ENOENT');
});
test('S7 ancestors reject replaced history and preserve original incomplete attempt',async()=>{
  const f=await fixture(),p=await prepareRepositoryAncestors(f.wrapper),old=p.history+'-old';
  await assert.rejects(applyRepositoryAncestors(p,{ioBoundary:async phase=>{
    if(phase==='ancestors-history-created'){await rename(p.history,old);await mkdir(p.history);}
  }}),e=>e.code==='ancestors.history-drift');
  assert.deepEqual(await readdir(old),[]);assert.deepEqual(await readdir(p.history),[]);
});
test('S7 ancestors stage the maximum approved depth and reject additions during continuation',async()=>{
  const f=await fixture(),deep=path.join(f.root,...Array(32).fill('a'),'w'),p=await prepareRepositoryAncestors(deep);
  assert.equal(p.targets.length,32);await applyRepositoryAncestors(p);
  assert.equal((await inspectRepositoryAncestors(p)).status,'completed');
  const q=await prepareRepositoryAncestors(path.join(f.root,'other','last','w'));
  await assert.rejects(applyRepositoryAncestors(q,{ioBoundary:async phase=>{if(phase==='ancestors-projection-retained')throw Error('interrupt');}}));
  const observation=await inspectRepositoryAncestors(q);
  await writeFile(path.join(q.history,'tree','last','foreign'),'keep');
  await assert.rejects(finishRepositoryAncestors(q,observation.digest),e=>e.code==='ancestors.foreign-entry');
  await assert.rejects(readdir(q.targets[0]),e=>e.code==='ENOENT');
});
test('S7 parent continuation retains fresh approvals across repeated deaths and does not append on completed readback',async()=>{
  const f=await fixture(),p=await prepareRepositoryAncestors(f.wrapper),url=new URL('../src/operations/repository-ancestors.js',import.meta.url).href;
  await assert.rejects(applyRepositoryAncestors(p,{ioBoundary:async phase=>{if(phase==='ancestors-projection-retained')throw Error('interrupt');}}));
  const originals=[];
  for(let i=1;i<=2;i++){
    const observed=await inspectRepositoryAncestors(p);
    const code=`import {finishRepositoryAncestors} from ${JSON.stringify(url)};await finishRepositoryAncestors(JSON.parse(process.argv[1]),process.argv[2],{ioBoundary:async phase=>{if(phase==='ancestors-continuation-authorized')process.exit(0);}});process.exit(9);`;
    await promisify(execFile)(process.execPath,['--input-type=module','-e',code,JSON.stringify(p),observed.digest],{windowsHide:true,timeout:30000});
    const name=path.join(p.history,'authorization-'+String(i).padStart(4,'0')+'.json');
    const bytes=await readFile(name);originals.push({name,bytes});
    const saved=JSON.parse(bytes.toString('utf8'));assert.equal(saved.observation.digest,observed.digest);assert.equal(saved.sequence,i);
    const next=await inspectRepositoryAncestors(p);assert.equal(next.continuationApprovals.length,i);
    await assert.rejects(finishRepositoryAncestors(p,observed.digest),e=>e.code==='ancestors.approval-drift');
  }
  await finishRepositoryAncestors(p,(await inspectRepositoryAncestors(p)).digest);
  const done=await inspectRepositoryAncestors(p);assert.equal(done.continuationApprovals.length,3);
  await finishRepositoryAncestors(p,done.digest);assert.equal((await inspectRepositoryAncestors(p)).digest,done.digest);
  for(const saved of originals)assert.deepEqual(await readFile(saved.name),saved.bytes);
});
test('S7 parent continuation fails closed on torn approval and retains staged directories',async()=>{
  const f=await fixture(),p=await prepareRepositoryAncestors(f.wrapper);
  await assert.rejects(applyRepositoryAncestors(p,{ioBoundary:async phase=>{if(phase==='ancestors-projection-retained')throw Error('interrupt');}}));
  await writeFile(path.join(p.history,'authorization-0001.json'),'{');
  await assert.rejects(inspectRepositoryAncestors(p),e=>e.code==='parse.syntax');
  await assert.rejects(readdir(p.targets[0]),e=>e.code==='ENOENT');
  assert.ok((await readdir(p.history)).includes('tree'));
});
test('S7 parent continuation bounds approval inventory before reading excess entries',async()=>{
  const f=await fixture(),p=await prepareRepositoryAncestors(f.wrapper);
  await assert.rejects(applyRepositoryAncestors(p,{ioBoundary:async phase=>{if(phase==='ancestors-projection-retained')throw Error('interrupt');}}));
  for(let i=1;i<=65;i++)await writeFile(path.join(p.history,'authorization-'+String(i).padStart(4,'0')+'.json'),'{}');
  await assert.rejects(inspectRepositoryAncestors(p),e=>e.code==='ancestors.approval-limit');
  await assert.rejects(readdir(p.targets[0]),e=>e.code==='ENOENT');
});
