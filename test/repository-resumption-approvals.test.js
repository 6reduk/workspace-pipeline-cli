import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {contractDigest} from '../src/contracts/semantic.js';
import {withRecoveryLease} from '../src/operations/recovery-lease.js';
import {readResumptionApprovals,persistResumptionApproval} from '../src/operations/repository-resumption-approvals.js';

async function fixture(){
  const wrapper=await mkdtemp(path.join(tmpdir(),'wpc-resumption-approval-')),directory=path.join(wrapper,'guard');
  await mkdir(directory);await writeFile(path.join(directory,'owner.json'),'{}');await writeFile(path.join(directory,'approval.json'),'{}');
  const digest='sha256:'+'a'.repeat(64);
  const binding={wrapper,lockDigest:digest,recoveryDigest:digest,ownerDigest:digest,approvalDigest:digest};
  const observe=continuationApprovals=>{
    const body={kind:'repository-lock-resumption-observation',...binding,status:'resumption-in-progress',
      resumptionOwnerLiveness:'local-pid-absent',executionAuthorized:false,canResume:false,canReleaseLock:false,continuationApprovals};
    return {...body,digest:contractDigest(body)};
  };
  return {wrapper,directory,binding,observe};
}

test('S7 repeated approval records preserve prior bytes and reject prefix damage',async()=>{
  const f=await fixture();
  await withRecoveryLease(f.wrapper,async lease=>{
    const first=f.observe([]),approval={decision:'approve',resumptionDigest:first.digest};
    await assert.rejects(persistResumptionApproval(f.directory,first,{decision:'approve',resumptionDigest:'wrong'},lease),
      e=>e.code==='repository-lock.continuation-binding');
    assert.deepEqual((await readdir(f.directory)).sort(),['approval.json','owner.json']);
    const one=await persistResumptionApproval(f.directory,first,approval,lease);
    const saved=await readFile(path.join(f.directory,one[0].name));
    const second=f.observe(one);
    const two=await persistResumptionApproval(f.directory,second,{decision:'approve',resumptionDigest:second.digest},lease);
    assert.equal(two.length,2);assert.deepEqual(await readResumptionApprovals(f.directory,f.binding),two);
    assert.deepEqual(await readFile(path.join(f.directory,one[0].name)),saved);
    const old=await readdir(f.directory);
    await assert.rejects(persistResumptionApproval(f.directory,first,approval,lease),e=>e.code==='repository-lock.continuation-drift');
    assert.deepEqual(await readdir(f.directory),old);
    await writeFile(path.join(f.directory,two[0].name),'{}');
    await assert.rejects(readResumptionApprovals(f.directory,f.binding),e=>e.code==='repository-lock.continuation-record');
  });
});

test('S7 repeated approval reader refuses foreign bindings and sequence gaps',async()=>{
  const f=await fixture();
  await withRecoveryLease(f.wrapper,async lease=>{
    const observation=f.observe([]);
    await persistResumptionApproval(f.directory,observation,{decision:'approve',resumptionDigest:observation.digest},lease);
    await assert.rejects(readResumptionApprovals(f.directory,{...f.binding,wrapper:f.wrapper+'-other'}),
      e=>e.code==='repository-lock.continuation-binding');
    await writeFile(path.join(f.directory,'continuation-000003.json'),'{}');
    await assert.rejects(readResumptionApprovals(f.directory,f.binding),e=>e.code==='repository-lock.continuation-entries');
  });
});
