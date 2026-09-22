import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,mkdir,writeFile,readFile,readdir,symlink} from 'node:fs/promises';
import {completedCleanupReceipt,scanCleanupReceipts} from '../src/operations/retention-receipts.js';
import {scanRetention} from '../src/operations/retention-scan.js';
import {applyRetention} from '../src/operations/retention-apply.js';
import {acquireWorkspaceLock} from '../src/operations/lock.js';
const id='11111111-1111-1111-1111-111111111111',other='22222222-2222-2222-2222-222222222222';
const hash='sha256:'+'a'.repeat(64),limits={maxAgeDays:30,maxJournals:20,maxDeletesPerRun:5};
const receipt=workspace=>({schemaVersion:1,kind:'retention-result',runId:id,workspace,previewDigest:hash,policy:limits,
  status:'completed',recoverable:false,groups:[],removedFiles:[],removedDirectories:[],completedGroups:[],currentFile:null,error:null,reclaimedBytes:0});
async function fixture(){const root=await mkdtemp(path.join(tmpdir(),'wpc-receipts-'));await mkdir(path.join(root,'.pipeline/cleanup'),{recursive:true});return root;}
async function save(root,value,name=id){await writeFile(path.join(root,'.pipeline/cleanup',name+'.json'),JSON.stringify(value));}
test('receipt completion requires consistent exact deletion inventory, not status alone',()=>{
  const workspace=path.resolve('fixture'),r=receipt(workspace),paths=['.pipeline/journals/'+other,'.pipeline/transactions/'+other];
  const files=[{path:paths[0]+'/000001.json',hash,bytes:4,mtimeMs:1},{path:paths[1]+'/recovery.json',hash,bytes:6,mtimeMs:1}];
  Object.assign(r,{groups:[{id:other,paths,files}],removedFiles:files.map(f=>f.path),removedDirectories:paths,completedGroups:[other],reclaimedBytes:10});
  assert.equal(completedCleanupReceipt(r,workspace,id),true);
  for(const mutate of [x=>x.reclaimedBytes++,x=>x.removedFiles.pop(),x=>x.groups.push(x.groups[0]),x=>x.error='io',x=>x.currentFile='x',
    x=>x.groups[0].files[0].path=paths[0]+'/nested/000001.json',x=>x.extra=true,x=>x.authorization={decision:'approve',previewDigest:'sha256:'+'b'.repeat(64)}]) {
    const copy=structuredClone(r);mutate(copy);assert.throws(()=>completedCleanupReceipt(copy,workspace,id));
  }
});
test('receipt scan is read-only and protects current and incomplete known receipts',async()=>{
  const root=await fixture();await save(root,receipt(root));
  await save(root,{...receipt(root),runId:other,status:'failed',error:'io'},other);
  const filename=path.join(root,'.pipeline/cleanup',id+'.json'),before=await readFile(filename);
  const result=await scanCleanupReceipts(root,{currentRuns:[id]});
  assert.equal(result.complete,true);assert.equal(result.records.length,2);
  assert.deepEqual(result.records[0].protectionReasons,['current-run']);assert.equal(result.records[1].status,'uncertain');
  assert.deepEqual(await readFile(filename),before);assert.equal(result.automaticActions,false);
  assert.deepEqual((await readdir(path.join(root,'.pipeline/cleanup'))).sort(),[id+'.json',other+'.json']);
});
test('receipt scan protects all on unknown schema or inconsistent completion',async()=>{
  for(const mutation of [r=>r.schemaVersion=99,r=>r.workspace=path.resolve('elsewhere'),r=>r.reclaimedBytes=1]) {
    const root=await fixture(),r=receipt(root);mutation(r);await save(root,r);
    await save(root,{...receipt(root),runId:other},other);
    const scan=await scanCleanupReceipts(root);assert.equal(scan.complete,false);
    assert.ok(scan.records.every(r=>r.protectionReasons.includes('inspection-failed')));
  }
});
test('receipt scan does not follow links or accept foreign directory entries',async()=>{
  const root=await fixture(),outside=await fixture();await save(outside,receipt(outside));
  await symlink(path.join(outside,'.pipeline/cleanup'),path.join(root,'.pipeline/cleanup/foreign'),process.platform==='win32'?'junction':'dir');
  const scan=await scanCleanupReceipts(root);assert.equal(scan.complete,false);assert.equal(scan.records.length,0);
  assert.equal((await readdir(path.join(outside,'.pipeline/cleanup'))).length,1);
});
test('receipt scan reports invalid operational reference inventory, never assumes independence',async()=>{
  const root=await fixture();await save(root,receipt(root));await writeFile(path.join(root,'.pipeline/state.json'),'{}');
  const scan=await scanCleanupReceipts(root);assert.equal(scan.complete,false);
  assert.ok(scan.records[0].protectionReasons.includes('inspection-failed'));
});
test('missing receipt directory is an empty read-only inventory',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wpc-empty-receipts-'));
  const scan=await scanCleanupReceipts(root);assert.equal(scan.complete,true);assert.deepEqual(scan.records,[]);
  assert.deepEqual(await readdir(root),[]);
});
test('v1 no-work executor does not accumulate receipts across repeated runs',async()=>{
  const root=await fixture();
  const preview=await scanRetention(root,{policy:limits,now:Date.now()});
  const lock=await acquireWorkspaceLock(root);let result;
  try{for(let i=0;i<3;i++)result=await applyRetention(lock,preview,{decision:'approve',previewDigest:preview.digest});}
  finally{await lock.release();}
  assert.equal(result.status,'completed');
  const scan=await scanCleanupReceipts(root);
  assert.equal(scan.complete,true);assert.equal(scan.records.length,0);
  assert.equal(result.receiptCreated,false);assert.equal(result.receiptPath,null);
});

test('receipt scan accepts 1000 entries and rejects 1001 without mutation',async()=>{
  const root=await fixture(),names=[];
  for(let i=0;i<1000;i++) {
    const name='00000000-0000-0000-0000-'+String(i).padStart(12,'0');names.push(name+'.json');
    await save(root,{...receipt(root),runId:name},name);
  }
  assert.equal((await scanCleanupReceipts(root)).records.length,1000);
  await save(root,receipt(root));names.push(id+'.json');
  await assert.rejects(()=>scanCleanupReceipts(root),e=>e.code==='retention-receipts.limit');
  assert.deepEqual((await readdir(path.join(root,'.pipeline/cleanup'))).sort(),names.sort());
});
