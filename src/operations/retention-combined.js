import {planRetention} from './retention.js';
import {requestShape} from './ownership.js';
import {contractDigest} from '../contracts/semantic.js';
import {fail} from '../contracts/parse.js';

// Pure planning only: observations must come from verified filesystem scanners.
// Never grants permission to delete or treats an observed completed flag as proof.
export function planCombinedRetention(input) {
  requestShape(input,['journals','receipts','policy','now'],[],'retention-combined.input');
  const {journals,receipts,policy,now}=input;
  requestShape(policy,['journals','cleanupReceipts','maxDeletesPerRun'],[],'retention-combined.policy');
  requestShape(policy.journals,['maxAgeDays','maxJournals'],[],'retention-combined.policy');
  requestShape(policy.cleanupReceipts,['maxAgeDays','maxReceipts'],[],'retention-combined.policy');
  if(!Number.isSafeInteger(policy.maxDeletesPerRun) || policy.maxDeletesPerRun<0)fail('retention-combined.policy');
  const classes=[
    ['journal',journals,policy.journals.maxAgeDays,policy.journals.maxJournals],
    ['cleanup-receipt',receipts,policy.cleanupReceipts.maxAgeDays,policy.cleanupReceipts.maxReceipts]
  ].map(([type,items,maxAgeDays,maxJournals])=>({type,maxAgeDays,maxCount:maxJournals,
    plan:planRetention({journals:items,now,policy:{maxAgeDays,maxJournals,maxDeletesPerRun:Number.MAX_SAFE_INTEGER}})}));
  const order=(a,b)=>a.completedAt-b.completedAt || (a.type<b.type?-1:a.type>b.type?1:a.id<b.id?-1:a.id>b.id?1:0);
  const candidates=classes.flatMap(c=>c.plan.selected.map(item=>({...item,type:c.type}))).sort(order);
  const selected=candidates.slice(0,policy.maxDeletesPerRun),deferred=candidates.slice(policy.maxDeletesPerRun);
  const selectedKeys=new Set(selected.map(item=>item.type+':'+item.id));
  const perClass=classes.map(c=>{
    const chosen=selected.filter(item=>item.type===c.type);
    const remaining=c.plan.observed.filter(item=>!selectedKeys.has(c.type+':'+item.id));
    return {type:c.type,observedCount:c.plan.observed.length,observedBytes:c.plan.totals.observedBytes,
      selectedCount:chosen.length,selectedBytes:chosen.reduce((n,item)=>n+item.bytes,0),
      protectedCount:c.plan.protected.length,remainingCount:remaining.length,
      remainingOverCount:Math.max(0,remaining.length-c.maxCount),
      remainingOverAge:remaining.filter(item=>item.completedAt!==null && now-item.completedAt>c.maxAgeDays*86400000).length};
  });
  const observedBytes=perClass.reduce((n,c)=>n+c.observedBytes,0);
  if(!Number.isSafeInteger(observedBytes))fail('retention-combined.bytes');
  const body={kind:'combined-retention-preview',now,policy:structuredClone(policy),selected,deferred,
    protected:classes.flatMap(c=>c.plan.protected.map(item=>({...item,type:c.type}))),perClass,
    totals:{observedCount:perClass.reduce((n,c)=>n+c.observedCount,0),observedBytes,
      selectedCount:selected.length,selectedBytes:selected.reduce((n,item)=>n+item.bytes,0)},
    requiresFilesystemValidation:true,automaticActions:false};
  return {...body,digest:contractDigest(body)};
}
