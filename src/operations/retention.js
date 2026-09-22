import { fail } from '../contracts/parse.js';
import { contractDigest } from '../contracts/semantic.js';
import { requestShape } from './ownership.js';

const dayMs = 86400000;
const statuses = new Set(['completed','active','pending','uncertain','unknown','orphan']);
const protections = new Set(['current-run','current-state','retained-reference','dependency','inspection-failed']);
const integer = n => Number.isSafeInteger(n) && n >= 0;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

// Pure selection over trusted, complete scanner observations. This function does
// not inspect files, prove completion/references, grant deletion or acquire locks.
// The later scanner/executor must independently establish those facts and recheck
// them. No defaults: all user-policy limits and the clock are explicit inputs.
export function planRetention(input) {
  requestShape(input,['journals','policy','now'],[],'retention.input');
  const {journals,policy,now}=input;
  requestShape(policy,['maxAgeDays','maxJournals','maxDeletesPerRun'],[],'retention.policy');
  if(!integer(now) || now>8640000000000000 || !Object.values(policy).every(integer) ||
      policy.maxAgeDays>Math.floor(Number.MAX_SAFE_INTEGER/dayMs))fail('retention.policy');
  if(!Array.isArray(journals))fail('retention.input');
  const ids=new Set();let totalBytes=0;
  const observed=journals.map(journal=>{
    requestShape(journal,['id','status','completedAt','bytes','protectionReasons'],[],'retention.journal');
    const {id,status,completedAt,bytes,protectionReasons}=journal;
    if(typeof id!=='string' || !uuid.test(id) || ids.has(id) || !statuses.has(status) ||
       !integer(bytes) || !Array.isArray(protectionReasons) ||
       protectionReasons.some(r=>!protections.has(r)) || new Set(protectionReasons).size!==protectionReasons.length ||
       (completedAt!==null && (!integer(completedAt) || completedAt>8640000000000000)) ||
       (status==='completed' && completedAt===null))fail('retention.journal');
    ids.add(id);totalBytes+=bytes;if(!integer(totalBytes))fail('retention.bytes');
    const reasons=[...protectionReasons];
    if(status!=='completed')reasons.push('status:'+status);
    if(completedAt!==null && completedAt>now)reasons.push('future-timestamp');
    return {id,status,completedAt,bytes,protectionReasons:reasons.sort()};
  }).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  const protectedJournals=observed.filter(j=>j.protectionReasons.length);
  const eligible=observed.filter(j=>!j.protectionReasons.length)
    .sort((a,b)=>a.completedAt-b.completedAt || (a.id<b.id?-1:a.id>b.id?1:0));
  const excess=Math.max(0,observed.length-policy.maxJournals);
  const candidates=eligible.map((j,index)=>({...j,reasons:[
    ...(now-j.completedAt>policy.maxAgeDays*dayMs?['age']:[]),...(index<excess?['count']:[])
  ]})).filter(j=>j.reasons.length);
  const selected=candidates.slice(0,policy.maxDeletesPerRun),deferred=candidates.slice(policy.maxDeletesPerRun);
  const selectedIds=new Set(selected.map(j=>j.id));
  const remaining=observed.filter(j=>!selectedIds.has(j.id));
  const aged=j=>j.completedAt!==null && now-j.completedAt>policy.maxAgeDays*dayMs;
  const body={kind:'retention-preview',now,policy:{...policy},observed,
    selected,deferred,protected:protectedJournals,
    totals:{observedCount:observed.length,observedBytes:totalBytes,
      selectedCount:selected.length,selectedBytes:selected.reduce((sum,j)=>sum+j.bytes,0),
      remainingCount:remaining.length,remainingOverCount:Math.max(0,remaining.length-policy.maxJournals),
      remainingOverAge:remaining.filter(aged).length},
    requiresFilesystemValidation:true,automaticActions:false};
  return {...body,digest:contractDigest(body)};
}
