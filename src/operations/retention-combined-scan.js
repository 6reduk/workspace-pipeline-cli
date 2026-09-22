import {scanRetention} from './retention-scan.js';
import {scanCleanupReceipts} from './retention-receipts.js';
import {planCombinedRetention} from './retention-combined.js';
import {contractDigest} from '../contracts/semantic.js';
import {fail} from '../contracts/parse.js';

export async function scanCombinedRetention(workspace,{policy,now,currentRuns=[]}) {
  planCombinedRetention({journals:[],receipts:[],policy,now});
  const journals=await scanRetention(workspace,{policy:{...policy.journals,maxDeletesPerRun:policy.maxDeletesPerRun},now,currentRuns});
  const receipts=await scanCleanupReceipts(workspace,{currentRuns});
  for(const binding of receipts.bindings) {
    const expected=binding.path==='.pipeline/state.json'?journals.stateFileHash:
      journals.groups.flatMap(g=>g.files).find(f=>f.path===binding.path)?.hash;
    if(expected!==binding.hash)fail('retention-combined.drift');
  }
  const complete=journals.complete&&receipts.complete;
  const groups=[...journals.groups.map(g=>({...g,type:'journal'})),...receipts.records.map(r=>({
    id:r.id,type:'cleanup-receipt',status:r.status==='completed'?'journal-completed':r.status,
    paths:[],files:r.hash?[{path:r.path,hash:r.hash,bytes:r.bytes,mtimeMs:r.mtimeMs}]:[],
    protectionReasons:[...r.protectionReasons],bytes:r.bytes,completedAt:r.completedAt
  }))].map(g=>({...g,protectionReasons:[...new Set([...g.protectionReasons,...complete?[]:['inspection-failed']])].sort()}));
  const observations=type=>groups.filter(g=>g.type===type).map(g=>({id:g.id,
    status:g.status==='journal-completed'?'completed':g.status==='uncertain'?'uncertain':'unknown',
    completedAt:g.completedAt,bytes:g.bytes,protectionReasons:g.protectionReasons}));
  const retention=planCombinedRetention({journals:observations('journal'),receipts:observations('cleanup-receipt'),policy,now});
  const body={kind:'combined-retention-filesystem-preview',workspace:journals.workspace,
    stateFileHash:journals.stateFileHash,currentRuns:[...currentRuns],groups,retention,
    diagnostics:[...journals.diagnostics,...receipts.diagnostics],complete,applySupported:false,automaticActions:false};
  return {...body,digest:contractDigest(body)};
}
