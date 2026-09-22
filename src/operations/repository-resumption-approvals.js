import path from 'node:path';
import {opendir,open} from 'node:fs/promises';
import {fail,MAX_INPUT_BYTES} from '../contracts/parse.js';
import {contractDigest} from '../contracts/semantic.js';
import {inspectDirectory} from '../workspace/paths.js';
import {readRecord} from './state.js';
import {sha256} from '../source/inventory.js';
import {assertRecoveryLeaseHeld} from './recovery-lease.js';

const exact=(value,keys)=>value && typeof value==='object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const name=index=>'continuation-'+String(index+1).padStart(6,'0')+'.json';
const MAX_APPROVALS=128,MAX_BYTES=32*1024*1024;

function validate(value,binding,bindings) {
  if(!exact(value,['schemaVersion','kind','approval','observation']) || value.schemaVersion!==1 ||
    value.kind!=='repository-lock-continuation-authorization' ||
    !exact(value.approval,['decision','resumptionDigest']) || value.approval.decision!=='approve' ||
    !value.observation || typeof value.observation!=='object')fail('repository-lock.continuation-record');
  const {digest,...body}=value.observation;
  if(digest!==value.approval.resumptionDigest || contractDigest(body)!==digest ||
    body.kind!=='repository-lock-resumption-observation' ||
    !['resumption-in-progress','gate-archived-resumption-pending'].includes(body.status) ||
    body.executionAuthorized!==false || body.canResume!==false || body.canReleaseLock!==false ||
    body.resumptionOwnerLiveness!=='local-pid-absent' ||
    ['wrapper','lockDigest','recoveryDigest','ownerDigest','approvalDigest'].some(k=>body[k]!==binding[k]) ||
    contractDigest(body.continuationApprovals??[])!==contractDigest(bindings))
    fail('repository-lock.continuation-binding');
}

// Historical approvals are evidence, never permission to execute again. Each new
// record binds the complete fresh observation and the immutable preceding prefix.
export async function readResumptionApprovals(directory,binding) {
  await inspectDirectory(directory);
  const names=[];
  for await(const entry of await opendir(directory)) {
    if(names.length>=MAX_APPROVALS+2)fail('repository-lock.continuation-limit');
    names.push(entry.name);
  }
  const records=names.filter(n=>!['owner.json','approval.json'].includes(n)).sort();
  if(records.some((n,i)=>n!==name(i)))fail('repository-lock.continuation-entries');
  const bindings=[];let bytes=0;
  for(const filename of records) {
    const record=await readRecord(path.join(directory,filename)),value=record.value;
    bytes+=Buffer.byteLength(JSON.stringify(value));
    if(bytes>MAX_BYTES)fail('repository-lock.continuation-limit');
    validate(value,binding,bindings);
    bindings.push({name:filename,digest:record.digest});
  }
  return bindings;
}

export async function persistResumptionApproval(directory,observation,approval,lease) {
  assertRecoveryLeaseHeld(lease);
  const before=await readResumptionApprovals(directory,observation);
  if(contractDigest(before)!==contractDigest(observation.continuationApprovals??[]))
    fail('repository-lock.continuation-drift');
  if(before.length>=MAX_APPROVALS)fail('repository-lock.continuation-limit');
  const value={schemaVersion:1,kind:'repository-lock-continuation-authorization',approval,observation};
  validate(value,observation,before);
  const bytes=Buffer.from(JSON.stringify(value)+'\n');
  if(bytes.length>MAX_INPUT_BYTES)fail('repository-lock.continuation-size');
  let total=bytes.length;
  for(const prior of before) {
    const record=await readRecord(path.join(directory,prior.name));
    if(record.digest!==prior.digest)fail('repository-lock.continuation-drift');
    total+=Buffer.byteLength(JSON.stringify(record.value));
  }
  if(total>MAX_BYTES)fail('repository-lock.continuation-limit');
  const filename=name(before.length);assertRecoveryLeaseHeld(lease);
  const handle=await open(path.join(directory,filename),'wx',0o600);
  try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
  const expected=[...before,{name:filename,digest:sha256(bytes)}];
  if(contractDigest(await readResumptionApprovals(directory,observation))!==contractDigest(expected))
    fail('repository-lock.continuation-readback');
  assertRecoveryLeaseHeld(lease);return expected;
}
