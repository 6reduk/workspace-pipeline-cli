import {parse,fail} from '../contracts/parse.js';
import {requestShape} from './ownership.js';
import {contractDigest,validateState,portablePath} from '../contracts/semantic.js';
import {composeSwitchPreview} from './switch.js';
import {absoluteRoot} from '../workspace/paths.js';

const hash=value=>typeof value==='string' && /^sha256:[a-f0-9]{64}(?![\s\S])/.test(value);
const detach=value=>parse(JSON.stringify(value),'json');

// Structural binding only: never a substitute for locked replay/source checks.
export function validateSwitchRecord(prepared,approval,previous) {
  const copy=detach(prepared),decision=detach(approval),state=detach(previous);
  requestShape(copy,['kind','preview','removal','stateFileHash','preparation','sourceVerification','applySupported','requiresFreshApproval','runtime','digest'],[],'switch-record.prepared');
  requestShape(decision,['decision','preparedDigest'],[],'switch-record.approval');
  validateState(state);
  if(state.status!=='ready' || !state.active || state.pending!==null)fail('switch-record.previous');
  const {digest,...body}=copy;
  if(copy.kind!=='prepared-switch' || copy.sourceVerification!=='verified-at-preparation' || copy.applySupported!==false ||
      copy.requiresFreshApproval!==true || copy.runtime!=='not-run' || !hash(copy.stateFileHash) || contractDigest(body)!==digest)fail('switch-record.prepared');
  if(decision.decision!=='approve' || decision.preparedDigest!==digest)fail('switch-record.approval');
  requestShape(copy.preparation,['objects','snapshot'],[],'switch-record.preparation');
  absoluteRoot(copy.preparation.objects);absoluteRoot(copy.preparation.snapshot);
  const r=copy.removal;
  requestShape(r,['kind','preview','stateFileHash','providers','backups','applySupported','requiresFreshApproval','automaticActions','runtime','digest'],['bundles'],'switch-record.removal');
  const {digest:rd,...rb}=r;
  if(r.kind!=='prepared-removal' || r.applySupported!==true || r.requiresFreshApproval!==true || r.automaticActions!==false ||
      r.runtime!=='not-run' || r.stateFileHash!==copy.stateFileHash || contractDigest(rb)!==rd ||
      !Array.isArray(r.providers) || contractDigest(r.providers)!==contractDigest([...state.active.providers].sort()))fail('switch-record.removal');
  if(!Array.isArray(r.backups))fail('switch-record.backups');
  const expected=new Set(state.active.owned.map(o=>o.backup).filter(v=>v!==null)),seen=new Set();
  for(const b of r.backups) {
    requestShape(b,['path','hash'],[],'switch-record.backups');portablePath(b.path);
    if(!expected.has(b.path) || seen.has(b.path) || !hash(b.hash))fail('switch-record.backups');
    seen.add(b.path);
  }
  if(seen.size!==expected.size)fail('switch-record.backups');
  if(!Array.isArray(copy.preview?.phases) || copy.preview.phases.length!==2)fail('switch-record.phases');
  const fresh=composeSwitchPreview({previous:state,removal:r.preview,replacement:copy.preview.phases[1].preview});
  if(contractDigest(fresh)!==contractDigest(copy.preview))fail('switch-record.phases');
  return {prepared:copy,approval:decision,previous:state};
}

export function createSwitchRecoveryRecord({prepared,approval,previous,journal}) {
  const bound=validateSwitchRecord(prepared,approval,previous);
  if(typeof journal!=='string' || !/^\.pipeline\/journals\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/.test(journal))fail('switch-record.journal');
  // Both sources are required for recovery; the new snapshot must be durably
  // installed and verified before a future executor writes provider targets.
  const body={schemaVersion:1,kind:'switch-recovery',...bound,journal,
    snapshots:{old:bound.previous.active.snapshot,new:bound.prepared.preview.phases[1].preview.plan.source},
    activationSupported:false,runtime:'not-run'};
  return detach({...body,digest:contractDigest(body)});
}

export function validateSwitchRecoveryRecord(record) {
  const copy=detach(record);
  requestShape(copy,['schemaVersion','kind','prepared','approval','previous','journal','snapshots','activationSupported','runtime','digest'],[],'switch-record.recovery');
  const fresh=createSwitchRecoveryRecord(copy);
  if(contractDigest(copy)!==contractDigest(fresh))fail('switch-record.recovery');
  return fresh;
}
