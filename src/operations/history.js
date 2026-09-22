import {opendir} from 'node:fs/promises';
import {absoluteRoot,resolveChild,inspectDirectory} from '../workspace/paths.js';
import {readRecord} from './state.js';
import {readJournal} from './journal.js';
import {ContractError,fail} from '../contracts/parse.js';
import {contractDigest} from '../contracts/semantic.js';
import {inspectRecovery} from './apply.js';
import {readSwitchRecovery} from './switch-recovery-store.js';
import {readSwitchContinuationRecovery} from './switch-continuation-recovery.js';
import {inspectMigrationPending} from './migration-pending.js';

const idPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const maxEntries=1000;
async function list(workspace,relative) {
  const directory=resolveChild(workspace,relative),names=[];
  if (!(await inspectDirectory(directory)).exists) return names;
  for await (const entry of await opendir(directory)) {
    if (names.length>=maxEntries) fail('history.limit');
    // Inspect exact children rather than following directory entry links.
    if (!idPattern.test(entry.name)) fail('history.entry-name');
    await inspectDirectory(resolveChild(workspace,relative+'/'+entry.name));
    names.push(entry.name);
  }
  return names.sort();
}

// Read-only metadata inventory. A terminal journal is NOT proof of activation,
// approval, backup validity or current target bytes. All entries remain protected
// from cleanup until a separate dependency-aware retention scanner certifies them.
export async function inspectHistory(workspace) {
  workspace=absoluteRoot(workspace);
  const entries=[],diagnostics=[],continuations=[],switchContinuations=[];
  const records=new Map(),predecessors=new Map();
  const result={workspace,entries,diagnostics,complete:false,automaticActions:false};
  const issue=(e,subject)=>diagnostics.push({code:e instanceof ContractError?e.code:'history.io',subject});
  let journals,transactions;
  try {
    if (!(await inspectDirectory(workspace)).exists) fail('history.workspace-missing');
    const migration=await inspectMigrationPending(workspace);
    if(migration.blocked){diagnostics.push(...migration.blockers);return result;}
    journals=await list(workspace,'.pipeline/journals');
    transactions=await list(workspace,'.pipeline/transactions');
  } catch(e) {issue(e,'inventory');return result;}
  const js=new Set(journals),ts=new Set(transactions);
  for (const id of [...new Set([...journals,...transactions])].sort()) {
    const item={id,journal:js.has(id)?'.pipeline/journals/'+id:null,
      recovery:ts.has(id)?'.pipeline/transactions/'+id+'/recovery.json':null,
      status:'unknown',protected:true};
    entries.push(item);
    if (!item.journal || !item.recovery) {
      item.status='orphan';diagnostics.push({code:'history.orphan',subject:id});continue;
    }
    try {
      const filename=resolveChild(workspace,item.recovery),record=await readRecord(filename);
      records.set(item.recovery,record.value);
      if(record.value?.kind==='switch-continuation-recovery') {
        const checked=await readSwitchContinuationRecovery(workspace,item.recovery),journal=checked.journal;
        const parent=checked.root;
        if(checked.fileHash!==record.digest)fail('history.observation-drift');
        records.set(item.recovery,{...record.value,previous:parent.record.previous});
        item.kind='switch-continuation';item.pendingDigest=checked.record.digest;
        item.status=journal.status==='completed'?'journal-completed':journal.status==='uncertain'?'uncertain':journal.status==='failed'?'failed':'open';
        item.recoveryHash=record.digest;item.journalHash=journal.lastFileHash;item.journalSequence=journal.sequence;
        item.desiredHash=contractDigest(parent.record.prepared.preview.phases[1].preview.plan.desired);
        switchContinuations.push(item);
        if(item.status!=='journal-completed')diagnostics.push({code:'history.unfinished',subject:id});
        continue;
      }
      if(record.value?.kind==='switch-recovery') {
        const checked=await readSwitchRecovery(workspace,item.recovery),journal=checked.journal;
        if(checked.fileHash!==record.digest)fail('history.observation-drift');
        item.kind='switch';item.pendingDigest=checked.record.digest;
        item.status=journal.status==='completed'?'journal-completed':journal.status==='uncertain'?'uncertain':journal.status==='failed'?'failed':'open';
        item.recoveryHash=record.digest;item.journalHash=journal.lastFileHash;item.journalSequence=journal.sequence;
        item.desiredHash=contractDigest(checked.record.prepared.preview.phases[1].preview.plan.desired);
        if(item.status!=='journal-completed')diagnostics.push({code:'history.unfinished',subject:id});
        continue;
      }
      const plan=record.value?.prepared?.preview?.plan,previous=record.value?.previous;
      const journal=await readJournal(workspace,item.journal,plan,previous);
      item.status=journal.receipt?.status==='completed'?'journal-completed':
        journal.phase==='interrupted'?'uncertain':journal.phase==='terminal'?'failed':'open';
      item.recoveryHash=record.digest;item.journalHash=journal.lastHash;item.journalSequence=journal.sequence;
      item.desiredHash=contractDigest(plan.desired);
      if(record.value?.prepared?.kind==='prepared-continuation')continuations.push(item);
      if (item.status!=='journal-completed') diagnostics.push({code:'history.unfinished',subject:id});
      if ((await readRecord(filename)).digest!==record.digest) fail('history.observation-drift');
    } catch(e) {item.status='unknown';issue(e,id);}
  }
  // Completed history is checked as historical evidence, not against today's
  // target bytes. Validate explicit predecessor bindings before using any anchor
  // to distinguish repeated equal deployments or removal cycles.
  const byPath=new Map(entries.map(e=>[e.recovery,e]));
  for(const item of entries) {
    try {
      if(item.status==='journal-completed' && !continuations.includes(item)) {
        if(['switch','switch-continuation'].includes(item.kind)) {
          const evidence=await (item.kind==='switch'?readSwitchRecovery:readSwitchContinuationRecovery)(workspace,item.recovery);
          if(evidence.fileHash!==item.recoveryHash || evidence.journal.lastFileHash!==item.journalHash ||
              evidence.journal.sequence!==item.journalSequence)fail('history.observation-drift');
        }else {
        const evidence=await inspectRecovery(workspace,item.recovery,{evidenceOnly:true});
        if(evidence.recoveryHash!==item.recoveryHash || evidence.journalHead.hash!==item.journalHash ||
            evidence.journalHead.sequence!==item.journalSequence)fail('history.observation-drift');
        }
      }
      const previous=records.get(item.recovery)?.previous,anchor=previous?.activation;
      if(anchor) {
        const parent=byPath.get(anchor.recovery);
        if(!parent || parent.status!=='journal-completed' || parent.recoveryHash!==anchor.recoveryHash ||
            parent.journalHash!==anchor.journalHead.hash || parent.journalSequence!==anchor.journalHead.sequence ||
            parent.desiredHash!==contractDigest(previous.active))fail('history.activation-binding');
        predecessors.set(item.recovery,anchor.recovery);
      }
    }catch(e){issue(e,item.id);}
  }
  // Linear graph walk; identical deployment hashes do not define graph edges.
  const done=new Set();
  for(const start of predecessors.keys()) {
    const visiting=new Set();let current=start;
    while(current && !done.has(current)) {
      if(visiting.has(current)){diagnostics.push({code:'history.activation-cycle',subject:start});break;}
      visiting.add(current);current=predecessors.get(current);
    }
    for(const name of visiting)done.add(name);
  }
  // Keep original status and hashes; only an independently validated completed
  // continuation can resolve its exact predecessor's unfinished diagnostic.
  // This proves readbacks, not activation or current target bytes.
  for(const item of continuations)if(item.status==='journal-completed') {
    try {
      const evidence=await inspectRecovery(workspace,item.recovery,{evidenceOnly:true});
      if(evidence.recoveryHash!==item.recoveryHash)fail('history.observation-drift');
      const ancestors=evidence.lineage.map(link=>({link,old:entries.find(e=>e.recovery===link.recovery)}));
      for(const {link,old} of ancestors)if(!old || old.recoveryHash!==link.recoveryHash || old.journalHash!==link.journalHead.hash ||
          !['open','uncertain','failed','journal-completed'].includes(old.status))fail('history.continuation-binding');
      for(const {old} of ancestors) {
      old.resolvedBy=[...(old.resolvedBy??[]),item.recovery].sort();
      old.resolution='continued';
      }
      item.resolves=evidence.resolves.recovery;
      item.resolvesChain=ancestors.map(({old})=>old.recovery);
    }catch(e){issue(e,item.id);}
  }
  for(const item of switchContinuations)if(item.status==='journal-completed') {
    try {
      const evidence=await readSwitchContinuationRecovery(workspace,item.recovery),p=evidence.record.preview;
      if(evidence.fileHash!==item.recoveryHash || evidence.journal.lastFileHash!==item.journalHash ||
          evidence.journal.sequence!==item.journalSequence)fail('history.continuation-binding');
      const ancestors=evidence.ancestors.map(link=>({link,old:byPath.get(link.relative)}));
      for(const {link,old} of ancestors)if(!old || !['switch','switch-continuation'].includes(old.kind) || !['uncertain','open','journal-completed'].includes(old.status) ||
          old.recoveryHash!==link.fileHash || old.journalHash!==link.journal.lastFileHash ||
          old.journalSequence!==link.journal.sequence)fail('history.continuation-binding');
      for(const {old} of ancestors) {
        old.resolvedBy=[...(old.resolvedBy??[]),item.recovery].sort();old.resolution='continued';
      }
      item.resolves=p.recoveryPath;item.resolvesChain=ancestors.map(({link})=>link.relative);
    }catch(e){issue(e,item.id);}
  }
  for(let i=diagnostics.length-1;i>=0;i--)if(diagnostics[i].code==='history.unfinished' &&
      entries.some(e=>e.id===diagnostics[i].subject && e.resolution==='continued'))diagnostics.splice(i,1);
  try {
    for(const item of entries)if(item.recoveryHash &&
        (await readRecord(resolveChild(workspace,item.recovery))).digest!==item.recoveryHash)fail('history.observation-drift');
    if (JSON.stringify(journals)!==JSON.stringify(await list(workspace,'.pipeline/journals')) ||
        JSON.stringify(transactions)!==JSON.stringify(await list(workspace,'.pipeline/transactions'))) fail('history.observation-drift');
    result.complete=true;
  } catch(e) {issue(e,'readback');}
  return result;
}
