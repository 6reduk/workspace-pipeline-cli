import {readSwitchRecovery} from './switch-recovery-store.js';
import {readState,observeTargets} from './state.js';
import {absoluteRoot,resolveChild} from '../workspace/paths.js';
import {contractDigest} from '../contracts/semantic.js';
import {sha256} from '../source/inventory.js';
import {fail} from '../contracts/parse.js';

// Read-only pending inspection; observed desired bytes cannot turn an unfinished
// intent into a successful outcome. No continuation, repair or activation grant.
export async function inspectPendingSwitch(workspace,recoveryPath) {
  workspace=absoluteRoot(workspace);
  const before=await readState(resolveChild(workspace,'.pipeline/state.json'));
  const evidence=await readSwitchRecovery(workspace,recoveryPath),{record,journal}=evidence;
  const pending={...record.previous,status:'needs-reconciliation',pending:record.digest,runtime:'not-run'};
  if(contractDigest(before.value)!==contractDigest(pending))fail('switch-inspect.activation-binding');
  const preview=record.prepared.preview,expected=new Map(preview.observations.map(o=>[o.path,o.hash]));
  const stoppedOutcome=journal.pending===null && ['failed','uncertain'].includes(journal.status);
  for(let phase=0;phase<preview.phases.length;phase++) {
    const targets=preview.phases[phase].preview.plan.targets;
    const count=phase<journal.verifiedPhases?targets.length:phase===journal.verifiedPhases?journal.nextIndex-(stoppedOutcome?1:0):0;
    for(let i=0;i<count;i++)expected.set(targets[i].path,targets[i].desiredHash);
  }
  let uncertain=null;
  if(journal.status==='uncertain') {
    const phase=preview.phases[journal.verifiedPhases];
    const target=phase.preview.plan.targets[journal.pending?journal.nextIndex:journal.nextIndex-1];
    uncertain={phase:phase.name,operationId:target.id,path:target.path,beforeHash:target.beforeHash,desiredHash:target.desiredHash};
  }
  const observed=await observeTargets(workspace,[...expected.keys()]);
  const hashes=items=>items.map(o=>({path:o.path,hash:o.bytes===null?null:sha256(o.bytes)}));
  const targets=hashes(observed).map(o=>({...o,expectedHash:expected.get(o.path),
    disposition:uncertain?.path===o.path?
      o.hash===uncertain.beforeHash?'uncertain-before':o.hash===uncertain.desiredHash?'uncertain-desired':'conflict':
      o.hash===expected.get(o.path)?'intact':'conflict'}));
  // Repeat dependency and current-file checks; this is still not an atomic OS
  // snapshot and is not a reusable capability for subsequent writes.
  const after=await readSwitchRecovery(workspace,recoveryPath);
  if(after.fileHash!==evidence.fileHash || contractDigest(after.journal)!==contractDigest(journal) ||
      (await readState(resolveChild(workspace,'.pipeline/state.json'))).digest!==before.digest ||
      contractDigest(hashes(await observeTargets(workspace,[...expected.keys()])))!==contractDigest(hashes(observed)))fail('switch-inspect.drift');
  return {status:'needs-reconciliation',recoveryPath,recoveryHash:evidence.fileHash,pending:record.digest,
    phase:journal.phase,journalStatus:journal.status,journalCompleted:journal.status==='completed',
    targets,conflicts:targets.filter(t=>t.disposition==='conflict').map(t=>t.path),uncertain,
    executionAllowed:false,runtime:'not-run'};
}
