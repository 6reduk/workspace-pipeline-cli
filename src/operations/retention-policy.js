import {readRecord} from './state.js';
import {writeCheckedFile} from './apply.js';
import {assertLockHeld} from './lock.js';
import {requestShape} from './ownership.js';
import {planRetention} from './retention.js';
import {planCombinedRetention} from './retention-combined.js';
import {absoluteRoot,resolveChild} from '../workspace/paths.js';
import {contractDigest} from '../contracts/semantic.js';
import {parse,fail} from '../contracts/parse.js';

export const retentionPolicyPath='.pipeline/retention.json';
export function validateRetentionPolicy(value,workspace) {
  requestShape(value,['schemaVersion','kind','workspace','mode','journals'],['cleanupReceipts','maxDeletesPerRun'],'retention-policy.shape');
  if(![1,2].includes(value.schemaVersion) || value.kind!=='workspace-retention-policy' ||
      value.workspace!==absoluteRoot(workspace) || !['automatic','disabled'].includes(value.mode))fail('retention-policy.binding');
  if(value.schemaVersion===1) {
    if(Object.hasOwn(value,'cleanupReceipts')||Object.hasOwn(value,'maxDeletesPerRun'))fail('retention-policy.shape');
    planRetention({journals:[],policy:value.journals,now:0});
  }else planCombinedRetention({journals:[],receipts:[],policy:retentionLimits(value),now:0});
  return structuredClone(value);
}
export function retentionLimits(policy) {
  return policy.schemaVersion===1?policy.journals:{journals:policy.journals,
    cleanupReceipts:policy.cleanupReceipts,maxDeletesPerRun:policy.maxDeletesPerRun};
}
export async function readRetentionPolicy(workspace) {
  workspace=absoluteRoot(workspace);const path=resolveChild(workspace,retentionPolicyPath);
  let record;
  try{record=await readRecord(path);}catch(e){if(e.code!=='record.missing')throw e;}
  const policy=record?validateRetentionPolicy(record.value,workspace):null;
  return {workspace,path,hash:record?.digest??null,mode:policy?.mode??'disabled',policy};
}
export async function previewRetentionPolicy(workspace,request) {
  requestShape(request,['action'],['mode','journals','cleanupReceipts','maxDeletesPerRun'],'retention-policy.request');
  if(!['set','disable'].includes(request.action))fail('retention-policy.request');
  const before=await readRetentionPolicy(workspace);let result;
  if(request.action==='disable') {
    if(Object.keys(request).length!==1)fail('retention-policy.request');
    result=before.policy?{...before.policy,mode:'disabled'}:null;
  }else {
    const v2=Object.hasOwn(request,'cleanupReceipts');
    if(!v2&&Object.hasOwn(request,'maxDeletesPerRun'))fail('retention-policy.request');
    result=validateRetentionPolicy({schemaVersion:v2?2:1,kind:'workspace-retention-policy',
      workspace:before.workspace,mode:request.mode,journals:request.journals,
      ...v2?{cleanupReceipts:request.cleanupReceipts,maxDeletesPerRun:request.maxDeletesPerRun}:{}},before.workspace);
  }
  const body={kind:'retention-policy-preview',workspace:before.workspace,action:request.action,
    beforeHash:before.hash,result,
    warning:result?.schemaVersion===2?'Automatic mode authorizes future eligible journal and cleanup-receipt deletion under one shared cap; no cleanup is performed by this policy update.':
      'Automatic mode authorizes future eligible journal deletion within these limits; no cleanup is performed by this policy update.'};
  return {...body,digest:contractDigest(body)};
}
export async function applyRetentionPolicy(lock,preview,approval) {
  await assertLockHeld(lock);
  const p=parse(JSON.stringify(preview),'json');
  requestShape(p,['kind','workspace','action','beforeHash','result','warning','digest'],[],'retention-policy.preview');
  requestShape(approval,['decision','previewDigest'],[],'retention-policy.approval');
  if(p.workspace!==lock.workspace || approval.decision!=='approve' || approval.previewDigest!==p.digest)fail('retention-policy.approval');
  const request=p.action==='disable'?{action:'disable'}:{action:p.action,mode:p.result?.mode,journals:p.result?.journals,
    ...p.result?.schemaVersion===2?{cleanupReceipts:p.result.cleanupReceipts,maxDeletesPerRun:p.result.maxDeletesPerRun}:{}};
  const fresh=await previewRetentionPolicy(lock.workspace,request);
  if(contractDigest(p)!==contractDigest(fresh))fail('retention-policy.drift');
  if(p.result!==null)await writeCheckedFile(lock,retentionPolicyPath,p.beforeHash,Buffer.from(JSON.stringify(p.result)+'\n'));
  return {status:'completed',...await readRetentionPolicy(lock.workspace),cleanupPerformed:false};
}
