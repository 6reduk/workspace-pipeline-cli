import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,mkdir,writeFile,readFile,readdir,utimes} from 'node:fs/promises';
import {scanCombinedRetention} from '../src/operations/retention-combined-scan.js';
import {applyRetention} from '../src/operations/retention-apply.js';
import {scanCleanupReceipts} from '../src/operations/retention-receipts.js';
import {acquireWorkspaceLock} from '../src/operations/lock.js';
import {previewRetentionPolicy,applyRetentionPolicy,readRetentionPolicy,retentionLimits} from '../src/operations/retention-policy.js';
import {runCli} from '../src/commands/dispatch.js';
const policy={journals:{maxAgeDays:30,maxJournals:20},cleanupReceipts:{maxAgeDays:0,maxReceipts:0},maxDeletesPerRun:1};
const ids=['11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222'];
async function fixture(count=2) {
  const root=await mkdtemp(path.join(tmpdir(),'wpc-combined-'));await mkdir(path.join(root,'.pipeline/cleanup'),{recursive:true});
  for(let i=0;i<count;i++) {
    const record={schemaVersion:1,kind:'retention-result',runId:ids[i],workspace:root,previewDigest:'sha256:'+'a'.repeat(64),
      policy:{maxAgeDays:30,maxJournals:20,maxDeletesPerRun:1},status:'completed',recoverable:false,
      groups:[],removedFiles:[],removedDirectories:[],completedGroups:[],currentFile:null,error:null,reclaimedBytes:0};
    const file=path.join(root,'.pipeline/cleanup',ids[i]+'.json');await writeFile(file,JSON.stringify(record));await utimes(file,1000+i,1000+i);
  }
  return root;
}
for(const mode of ['success','drift','interrupted','policy-drift'])test('combined executor '+mode+' preserves diagnostics and shares cap',async()=>{
  const root=await fixture(),p=await scanCombinedRetention(root,{policy,now:Date.now()});
  assert.equal(p.complete,true);assert.equal(p.retention.selected.length,1);
  assert.equal(p.retention.selected[0].id,ids[0]);
  const lock=await acquireWorkspaceLock(root);let result;
  try {
    let approval={decision:'approve',previewDigest:p.digest},configured;
    if(mode==='policy-drift') {
      const preview=await previewRetentionPolicy(root,{action:'set',mode:'automatic',...policy});
      configured=await applyRetentionPolicy(lock,preview,{decision:'approve',previewDigest:preview.digest});
      approval={decision:'workspace-policy',policyHash:configured.hash};
    }
    result=await applyRetention(lock,p,approval,{boundary:async stage=>{
      if(mode==='policy-drift'&&stage==='before-file')await writeFile(configured.path,JSON.stringify({...configured.policy,mode:'disabled'}));
      if(mode==='drift'&&stage==='before-file') {
        const file=path.join(root,'.pipeline/cleanup',ids[0]+'.json');await writeFile(file,(await readFile(file,'utf8'))+' ');
      }
      if(mode==='interrupted'&&stage==='file-removed')throw Error('synthetic crash');
    }});
  }finally{await lock.release();}
  assert.equal(result.receiptCreated,true);const receipt=JSON.parse(await readFile(result.receiptPath,'utf8'));
  assert.equal(receipt.schemaVersion,2);assert.equal(receipt.groups[0].type,'cleanup-receipt');
  assert.ok((await readdir(path.join(root,'.pipeline/cleanup'))).includes(ids[1]+'.json'));
  if(mode==='success') {
    assert.equal(result.status,'completed');assert.equal(result.removedGroups,1);assert.equal(result.removedFiles,1);
    const scan=await scanCleanupReceipts(root);assert.equal(scan.complete,true);
    assert.equal(scan.records.find(r=>r.id===result.runId).status,'completed');
  }else {
    assert.equal(result.status,'failed');assert.equal(result.removedGroups,0);
    assert.equal(result.removedFiles,mode==='interrupted'?1:0);
    if(mode==='policy-drift')assert.equal(result.error,'retention-apply.policy-drift');
    if(mode==='interrupted')assert.ok(receipt.currentFile);
  }
});
test('combined no-work creates no new receipt and reports zero work',async()=>{
  const root=await fixture(0),p=await scanCombinedRetention(root,{policy,now:Date.now()});
  const lock=await acquireWorkspaceLock(root);let result;
  try{result=await applyRetention(lock,p,{decision:'approve',previewDigest:p.digest});}finally{await lock.release();}
  assert.equal(result.status,'completed');assert.equal(result.receiptCreated,false);assert.equal(result.receiptPath,null);
  assert.deepEqual(await readdir(path.join(root,'.pipeline/cleanup')),[]);
});
test('v2 policy opt-in/disable/downgrade are explicit and automatic execution checks policy',async()=>{
  const root=await fixture(),preview=await previewRetentionPolicy(root,{action:'set',mode:'automatic',...policy});
  const lock=await acquireWorkspaceLock(root);
  try {
    const configured=await applyRetentionPolicy(lock,preview,{decision:'approve',previewDigest:preview.digest});
    assert.equal(configured.policy.schemaVersion,2);
    const p=await scanCombinedRetention(root,{policy:retentionLimits(configured.policy),now:Date.now()});
    const result=await applyRetention(lock,p,{decision:'workspace-policy',policyHash:configured.hash});assert.equal(result.status,'completed');
    const disable=await previewRetentionPolicy(root,{action:'disable'});
    await applyRetentionPolicy(lock,disable,{decision:'approve',previewDigest:disable.digest});
    assert.equal((await readRetentionPolicy(root)).policy.schemaVersion,2);
    await assert.rejects(()=>applyRetention(lock,p,{decision:'workspace-policy',policyHash:configured.hash}),e=>e.code==='retention-apply.policy-drift');
    const downgrade=await previewRetentionPolicy(root,{action:'set',mode:'disabled',journals:{...policy.journals,maxDeletesPerRun:1}});
    await applyRetentionPolicy(lock,downgrade,{decision:'approve',previewDigest:downgrade.digest});
    assert.equal((await readRetentionPolicy(root)).policy.schemaVersion,1);
  }finally{await lock.release();}
});
test('combined CLI preview/apply uses explicit receipt flags without changing policy',async()=>{
  const root=await fixture(),invoke=async args=>{let out='',err='';const code=await runCli(args,{stdout:s=>{out+=s;},stderr:s=>{err+=s;}});return {code,out,err};};
  const args=['logs','clean','--workspace',root,'--max-age-days','30','--keep-last','20','--max-delete','1','--receipt-max-age-days','0','--keep-receipts','0'];
  const preview=await invoke(args);assert.equal(preview.code,0,preview.err);
  const file=path.join(root,'preview.json');await writeFile(file,preview.out);
  const applied=await invoke(['logs','clean','--workspace',root,'--apply','--preview',file]);
  assert.equal(applied.code,0,applied.err);assert.equal(JSON.parse(applied.out).removedGroups,1);
  assert.equal((await readRetentionPolicy(root)).policy,null);
  const setup=await invoke(['logs','policy','set','--mode','automatic',...args.slice(2)]);
  assert.equal(setup.code,0,setup.err);assert.equal(JSON.parse(setup.out).result.schemaVersion,2);
  assert.equal((await invoke(args.slice(0,-2))).code,2);
});
