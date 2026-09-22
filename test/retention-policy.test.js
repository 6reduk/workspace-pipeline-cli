import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,mkdir,writeFile,readFile,readdir,symlink} from 'node:fs/promises';
import {readRetentionPolicy,previewRetentionPolicy,applyRetentionPolicy,validateRetentionPolicy} from '../src/operations/retention-policy.js';
import {acquireWorkspaceLock} from '../src/operations/lock.js';
import {scanRetention} from '../src/operations/retention-scan.js';
import {applyRetention} from '../src/operations/retention-apply.js';
import {runCli,parseCommand} from '../src/commands/dispatch.js';

const limits={maxAgeDays:30,maxJournals:20,maxDeletesPerRun:5};
test('policy validates exact structure, mode, version and bounded explicit limits',()=>{
  const workspace=path.resolve('fixture'),good={schemaVersion:1,kind:'workspace-retention-policy',workspace,mode:'automatic',journals:limits};
  for(const bad of [{...good,extra:true},{...good,mode:'auto'},{...good,schemaVersion:2},
    {...good,journals:{maxAgeDays:1}}, {...good,journals:{...limits,maxDeletesPerRun:-1}},
    {...good,journals:{...limits,maxJournals:1.5}}])assert.throws(()=>validateRetentionPolicy(bad,workspace));
  const copy=validateRetentionPolicy(good,workspace);copy.journals.maxJournals=0;
  assert.equal(good.journals.maxJournals,20);
});
const fixture=()=>mkdtemp(path.join(tmpdir(),'wpc-policy-'));
const invoke=async args=>{
  let out='',err='';const code=await runCli(args,{stdout:s=>{out+=s;},stderr:s=>{err+=s;}});
  return {code,out,err};
};
async function set(workspace,mode='automatic') {
  const p=await previewRetentionPolicy(workspace,{action:'set',mode,journals:limits});
  const lock=await acquireWorkspaceLock(workspace);
  try{return await applyRetentionPolicy(lock,p,{decision:'approve',previewDigest:p.digest});}
  finally{await lock.release();}
}
test('policy absent/show/disable previews are read-only without numeric defaults',async()=>{
  const root=await fixture();assert.equal((await readRetentionPolicy(root)).policy,null);
  assert.equal((await previewRetentionPolicy(root,{action:'disable'})).result,null);
  const result=await invoke(['logs','policy','show','--workspace',root]);
  assert.equal(result.code,0);assert.equal(JSON.parse(result.out).mode,'disabled');
  assert.deepEqual(await readdir(root),[]);
});
test('policy set and disable CLI require exact preview; B remains untouched',async()=>{
  const root=await fixture(),a=path.join(root,'a'),b=path.join(root,'b');await mkdir(a);await mkdir(b);
  const preview=await invoke(['logs','policy','set','--workspace',a,'--mode','automatic','--max-age-days','30','--keep-last','20','--max-delete','5']);
  assert.equal(preview.code,0);assert.deepEqual(await readdir(a),[]);
  const file=path.join(root,'preview.json');await writeFile(file,preview.out);
  assert.equal((await invoke(['logs','policy','set','--workspace',a,'--apply','--preview',file])).code,0);
  assert.equal((await readRetentionPolicy(a)).mode,'automatic');assert.deepEqual(await readdir(b),[]);
  const disabled=await invoke(['logs','policy','disable','--workspace',a]);await writeFile(file,disabled.out);
  assert.equal((await invoke(['logs','policy','disable','--workspace',a,'--apply','--preview',file])).code,0);
  assert.equal((await readRetentionPolicy(a)).mode,'disabled');
  assert.deepEqual((await readRetentionPolicy(a)).policy.journals,limits);
  assert.deepEqual((await readdir(path.join(a,'.pipeline'))).sort(),['retention.json']);
});
test('policy rejects wrong workspace, malformed/duplicate file and redirected path',async()=>{
  const a=await fixture(),b=await fixture();await set(a);await mkdir(path.join(b,'.pipeline'));
  const bytes=await readFile(path.join(a,'.pipeline/retention.json'));
  await writeFile(path.join(b,'.pipeline/retention.json'),bytes);
  await assert.rejects(()=>readRetentionPolicy(b),e=>e.code==='retention-policy.binding');
  await writeFile(path.join(b,'.pipeline/retention.json'),'{"mode":"automatic","mode":"disabled"}');
  await assert.rejects(()=>readRetentionPolicy(b));
  const c=await fixture();await symlink(path.join(a,'.pipeline'),path.join(c,'.pipeline'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(()=>readRetentionPolicy(c));
  assert.deepEqual(await readFile(path.join(a,'.pipeline/retention.json')),bytes);
});
test('policy stale preview and busy lock cannot overwrite policy',async()=>{
  const root=await fixture(),p=await previewRetentionPolicy(root,{action:'set',mode:'automatic',journals:limits});
  await set(root,'disabled');const before=await readFile(path.join(root,'.pipeline/retention.json'));
  const lock=await acquireWorkspaceLock(root);
  try{
    await assert.rejects(()=>acquireWorkspaceLock(root));
    await assert.rejects(()=>applyRetentionPolicy(lock,p,{decision:'approve',previewDigest:p.digest}),e=>e.code==='retention-policy.drift');
  }finally{await lock.release();}
  assert.deepEqual(await readFile(path.join(root,'.pipeline/retention.json')),before);
});
test('policy command parser rejects incomplete, mixed and foreign options',()=>{
  const root=path.resolve('fixture');
  for(const tail of [[],['--mode','automatic'],['--apply'],['--mode','automatic','--apply','--preview',root],['--max-age-days','-1'],['--unknown','secret']])
    assert.throws(()=>parseCommand(['logs','policy','set','--workspace',root,...tail]));
  assert.throws(()=>parseCommand(['logs','policy','show','--workspace',root,'--apply','--preview',root]));
});
test('automatic v1 no-work cleanup creates no receipt but still validates policy authority',async()=>{
  const root=await fixture();const policy=await set(root);
  const preview=await scanRetention(root,{policy:limits,now:Date.now()});
  const lock=await acquireWorkspaceLock(root);
  try{
    const result=await applyRetention(lock,preview,{decision:'workspace-policy',policyHash:policy.hash});
    assert.equal(result.status,'completed');
    assert.equal(result.receiptPath,null);assert.equal(result.receiptCreated,false);
    await writeFile(policy.path,JSON.stringify({...policy.policy,mode:'disabled'}));
    await assert.rejects(()=>applyRetention(lock,preview,{decision:'workspace-policy',policyHash:policy.hash}),
      e=>e.code==='retention-apply.policy-drift');
  }finally{await lock.release();}
});
