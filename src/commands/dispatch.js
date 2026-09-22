import {inspectInstallation} from '../operations/doctor.js';
import {absoluteRoot} from '../workspace/paths.js';
import {ContractError,fail} from '../contracts/parse.js';
import {runRepositoryRecovery} from './repositories.js';
import {runRepositoryLockRecovery} from './repository-locks.js';
import {runBootstrapContinuation} from './bootstrap-recovery.js';
import {runRepositoryAbandon} from './repository-abandon.js';
import {runRepositoryAncestors} from './repository-ancestors.js';
import {scanRepositoryRetention} from '../operations/repository-retention.js';
import {applyRepositoryRetention} from '../operations/repository-retention-apply.js';
import {scanRetention} from '../operations/retention-scan.js';
import {scanCombinedRetention} from '../operations/retention-combined-scan.js';
import {scanCleanupReceipts} from '../operations/retention-receipts.js';
import {applyRetention} from '../operations/retention-apply.js';
import {acquireWorkspaceLock} from '../operations/lock.js';
import {readRecord} from '../operations/state.js';
import {readRetentionPolicy,previewRetentionPolicy,applyRetentionPolicy} from '../operations/retention-policy.js';
import {prepareLifecycle,applyLifecycle} from '../operations/lifecycle.js';
import {prepareMaintenance,applyMaintenance} from '../operations/maintenance.js';
import {prepareSwitchLifecycle,applySwitchLifecycle} from '../operations/switch-lifecycle.js';
import {prepareContinuationLifecycle,applyContinuationLifecycle} from '../operations/continuation-lifecycle.js';
import {assertNoRepositoryPending} from '../operations/repository-pending.js';
import {listRepositoryHistory} from '../operations/repository-history.js';
import {runRepositoryCommand} from './init.js';
import {parseMigrationCommand,runMigrationCommand} from './migration.js';
import {parseLaunch,runLaunch} from './launch.js';

export const help=`Workspace Pipeline CLI — development preview
Usage: workspace-pipeline doctor --workspace <absolute-directory> [--recovery <relative-record>] [--json]
       workspace-pipeline launch grok --workspace <absolute-directory> --executable <absolute-native-executable> [--inspect] [--execute]
       workspace-pipeline <init|adopt|wrap> --workspace <absolute-directory> --choices <absolute-json-file> [--manifest <absolute-file>] [--network]
       workspace-pipeline <init|adopt|wrap> --workspace <absolute-directory> --apply --preview <absolute-json-file>
       workspace-pipeline <setup|update> --workspace <absolute-directory> [--manifest <absolute-file>] [--network]
       workspace-pipeline <setup|update> --workspace <absolute-directory> --apply --preview <absolute-json-file>
       workspace-pipeline <repair|remove> --workspace <absolute-directory> [--providers <comma-separated-ids>] [--bundles <comma-separated-ids>]
       workspace-pipeline <repair|remove> --workspace <absolute-directory> --apply --preview <absolute-json-file>
       workspace-pipeline switch --workspace <absolute-directory> --manifest <absolute-file> [--network]
       workspace-pipeline switch --workspace <absolute-directory> --apply --preview <absolute-json-file>
       workspace-pipeline continue --workspace <absolute-directory> --recovery <relative-record>
       workspace-pipeline continue --workspace <absolute-directory> --apply --preview <absolute-json-file>
       workspace-pipeline logs list --workspace <absolute-directory> [--json]
       workspace-pipeline logs clean --workspace <absolute-directory> --max-age-days <N> --keep-last <N> --max-delete <N>
       workspace-pipeline logs clean --workspace <absolute-directory> --apply --preview <absolute-json-file>
       workspace-pipeline logs policy show --workspace <absolute-directory>
       workspace-pipeline logs policy set --workspace <absolute-directory> --mode <automatic|disabled> --max-age-days <N> --keep-last <N> --max-delete <N>
       workspace-pipeline logs policy disable --workspace <absolute-directory>
       workspace-pipeline logs policy <set|disable> --workspace <absolute-directory> --apply --preview <absolute-json-file>
       workspace-pipeline --help

Migration commands (development preview):
       workspace-pipeline migration unity preview --workspace <absolute-directory> --manifest <absolute-file> [--network]
       workspace-pipeline migration unity inspect --workspace <absolute-directory> --recovery <relative-record> --phase <deactivation|installation|recovery|closeout|compensation>
       workspace-pipeline migration unity apply --workspace <absolute-directory> --preview <absolute-file>
Preview stages Git externally; inspect is read-only/offline. JSON can contain
private config bytes. Only explicit apply writes or clears a validated pending marker.
Apply requires the saved installer-bound envelope and accepts no source overrides.

Doctor is read-only and prints JSON. Exit 0 means observed configuration ready;
exit 1 means not ready/incomplete; exit 2 means invalid invocation or unavailable command.
Runtime, MCP/harness discovery and provider compatibility are NOT verified.
No source access, automatic repair or lock removal. Read-only/configuration commands never clean history.
Unfinished repository/bootstrap/recovery operations block ordinary mutations;
doctor reports their presence without clearing them or claiming recovery is complete.
Policy commands configure future startup retention; they never run cleanup.
For combined v2 cleanup/policy previews add BOTH --receipt-max-age-days <N> and
--keep-receipts <N>. --max-delete is then one shared journal + receipt cap.
Logs list/clean preview are read-only. Save clean preview JSON, inspect it, then
use --apply --preview to delete only that exact still-valid selection. Cleanup is
not recoverable; its receipt path and partial failures are reported. No defaults.

Built-in workspace adapters: Codex, Claude, Kimi and Grok (configuration delivery).
Grok Claude-import suppression requires the scoped launch command, not direct grok.
Kimi/Grok native session discovery remains separately verified; setup is not runtime certification.
No native plugin installation, global activation, trust grant or MCP invocation.
Preview may stage Git source outside the workspace; --network explicitly permits
remote acquisition. Save the complete prepared JSON privately and inspect it
before --apply --preview. It may contain configuration secrets. Apply cannot
select a new source/manifest or download a replacement for missing staged data.
No native plugins are installed. Source packages cannot supply executable adapters.
Repair/remove are offline installed-snapshot operations. --providers and --bundles are remove-only,
preview-only; omission previews full removal. No automatic history cleanup on these commands.
Switch requires an explicit incoming manifest in preview, preserves two separate
phases and activates only after both pass. Failure is not rolled back or retried.
Continue creates a new approved operation from pending evidence; it does not replay old journals.
Init/adopt (wrap alias) prepare repositories only, not provider configuration.
Choices explicitly select keep/directory/init/clone/move per repository. Preview
does not authorize effects; apply verifies its exact saved package and inputs offline.
Successful apply verifies results and retains pending markers in history.
Recovery eligibility is checked by native readers.
Repository recovery: repositories status --workspace <absolute-directory> is read-only.
repositories recover-locks --workspace <absolute-directory> --journal <journal-uuid>
previews exact stopped-owner lock retirement/continuation from retained inputs;
add --apply --preview <absolute-file> only after inspecting the saved preview.
This does not recover uncertain effects or incomplete bootstrap creation.
repositories recover-bootstrap --workspace <absolute-directory> --bootstrap-preview <original-file>
previews first recovery of a stopped, evidenced bootstrap attempt without source access;
apply with --apply --preview <fresh-recovery-file> (no original override on apply).
repositories continue-bootstrap --workspace <absolute-directory> [--initial <sha256:digest>]
previews interrupted recovery from a complete retained request; --initial selects
completed history explicitly. Apply requires --apply --preview <absolute-file>.
It does not infer missing requests, recreate wrappers or replay repository effects.
repositories retire-bootstrap --workspace <absolute-directory> previews archival
of an owner-only stopped local bootstrap attempt, only while the wrapper is absent.
Apply requires --apply --preview <absolute-file>; unknown/torn owners stay blocked.
repositories finalize --workspace <absolute-directory> produces a saved JSON preview;
repositories finalize --workspace <absolute-directory> --apply --preview <absolute-file>
finishes only verified completed effects (or an exact existing completion receipt).
Finalize does not replay repository operations or retire stale locks.
repositories prepare-parent --workspace <absolute-directory> previews bounded missing parents;
apply with --apply --preview <file>, then obtain a fresh init/adopt preview.
For nested parents this argument is a target sentinel, not the canonical wrapper.
Stop canonical workspace writers first; parent leases do not serialize their locks.
Use the actual wrapper path for the subsequent fresh init/adopt preview.
repositories continue-parent --workspace <absolute-directory> --parent-preview <file>
prepares a fresh continuation preview; apply it with --apply --preview <file>.
repositories abandon --workspace <absolute-directory> previews preserving observed
partial effects and abandoning the old request (NOT successful completion).
repositories continue-abandon --workspace <absolute-directory> --attempt <uuid>
previews interrupted abandonment; both require --apply --preview <file> to mutate.
logs clean --repositories --workspace <absolute-directory> --max-age-days <N>
--keep-last <N> --max-delete <N> previews unreferenced completed repository groups.
Apply with --repositories --apply --preview <file>; this is a separate cleanup
domain, never an implicit increase of the ordinary journal deletion budget.
Execution inputs are retained privately under .pipeline/repository-inputs;
--json is optional because JSON is the default.
This package is not ready to replace an existing installation.`;

// Parse strictly before any filesystem observation. Never echo unknown arguments
// (which can contain credentials). Output transport is trusted CLI code.
export function parseCommand(args) {
  if(!Array.isArray(args) || args.some(a=>typeof a!=='string')) fail('cli.arguments');
  if(args.length===0 || (args.length===1 && ['--help','-h'].includes(args[0])))return {command:'help'};
  if(args[0]==='launch')return parseLaunch(args);
  if(['setup','update','repair','remove','switch','continue'].includes(args[0]))return parseLifecycle(args);
  if(args[0]==='migration')return parseMigrationCommand(args);
  if(['init','adopt','wrap'].includes(args[0]))return parseRepositories(args);
  if(args[0]==='repositories')return parseRepositoryRecovery(args);
  if(args[0]==='logs')return parseLogs(args);
  if(args[0]!=='doctor')fail('cli.command-unavailable');
  const result={command:'doctor'},seen=new Set();
  for(let i=1;i<args.length;i++) {
    const flag=args[i];
    if(!['--workspace','--recovery','--json'].includes(flag) || seen.has(flag))fail('cli.arguments');
    seen.add(flag);
    if(flag==='--json')continue;
    if(i+1>=args.length || args[i+1].startsWith('--'))fail('cli.arguments');
    const value=args[++i];
    if(flag==='--workspace')result.workspace=absoluteRoot(value);
    else result.recoveryPath=value;
  }
  if(!Object.hasOwn(result,'workspace'))fail('cli.workspace-required');
  if(result.recoveryPath!==undefined && !/^\.pipeline\/transactions\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/recovery\.json$/.test(result.recoveryPath))fail('recovery.path');
  return result;
}

function parseRepositoryRecovery(args) {
  if(!['status','finalize','recover-locks','recover-bootstrap','continue-bootstrap','retire-bootstrap','abandon','continue-abandon','prepare-parent','continue-parent'].includes(args[1]))fail('cli.arguments');
  const result={command:'repositories',action:args[1]},seen=new Set();
  for(let i=2;i<args.length;i++) {
    const flag=args[i];
    if(!['--workspace','--apply','--preview','--json','--journal','--initial','--attempt','--parent-preview','--bootstrap-preview'].includes(flag) || seen.has(flag))fail('cli.arguments');
    seen.add(flag);
    if(flag==='--json')continue;
    if(flag==='--apply'){result.apply=true;continue;}
    const value=args[++i];if(value===undefined || value.startsWith('--'))fail('cli.arguments');
    if(flag==='--bootstrap-preview'){
      if(result.action!=='recover-bootstrap')fail('cli.arguments');result.bootstrapPreview=absoluteRoot(value);continue;
    }
    if(flag==='--parent-preview'){
      if(result.action!=='continue-parent')fail('cli.arguments');result.parentPreview=absoluteRoot(value);continue;
    }
    if(flag==='--attempt'){
      if(result.action!=='continue-abandon' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value))fail('cli.arguments');
      result.attempt=value;continue;
    }
    if(flag==='--initial') {
      if(result.action!=='continue-bootstrap' || !/^sha256:[a-f0-9]{64}$/.test(value))fail('cli.arguments');
      result.initialDigest=value;continue;
    }
    if(flag==='--journal') {
      if(result.action!=='recover-locks' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value))fail('cli.arguments');
      result.journalId=value;continue;
    }
    result[flag==='--workspace'?'workspace':'previewFile']=absoluteRoot(value);
  }
  if(!result.workspace)fail('cli.workspace-required');
  if(result.action==='continue-abandon' && !result.attempt)fail('cli.arguments');
  if(result.action==='continue-parent' && (result.apply?Boolean(result.parentPreview):!result.parentPreview))fail('cli.arguments');
  if(result.action==='recover-bootstrap' && (result.apply?Boolean(result.bootstrapPreview):!result.bootstrapPreview))fail('cli.arguments');
  if(result.action==='recover-locks' && !result.journalId)fail('repositories.journal-required');
  if(result.action==='status' && (result.apply || result.previewFile))fail('cli.arguments');
  if(Boolean(result.apply)!==Boolean(result.previewFile))fail('cli.arguments');
  return result;
}

function parseRepositories(args) {
  const result={command:args[0]==='wrap'?'adopt':args[0]},seen=new Set();
  for(let i=1;i<args.length;i++) {
    const flag=args[i];
    if(!['--workspace','--manifest','--choices','--apply','--preview','--network','--json'].includes(flag) || seen.has(flag))fail('cli.arguments');
    seen.add(flag);
    if(flag==='--json')continue;
    if(flag==='--apply'){result.apply=true;continue;}
    if(flag==='--network'){result.network=true;continue;}
    const value=args[++i];if(value===undefined || value.startsWith('--'))fail('cli.arguments');
    result[{'--workspace':'workspace','--manifest':'manifestPath','--choices':'choicesFile','--preview':'previewFile'}[flag]]=absoluteRoot(value);
  }
  if(!result.workspace)fail('cli.workspace-required');
  if(result.apply?(!result.previewFile || result.choicesFile || result.manifestPath || result.network):(!result.choicesFile || result.previewFile))fail('cli.arguments');
  return result;
}

function parseLifecycle(args) {
  const result={command:args[0]},seen=new Set(),maintenance=['repair','remove'].includes(args[0]);
  for(let i=1;i<args.length;i++) {
    const flag=args[i];
    const allowed=['--workspace','--apply','--preview','--json',...(result.command==='continue'?['--recovery']:maintenance?result.command==='remove'?['--providers','--bundles']:[]:['--manifest','--network'])];
    if(!allowed.includes(flag) || seen.has(flag))fail('cli.arguments');
    seen.add(flag);
    if(flag==='--json')continue;
    if(flag==='--apply'){result.apply=true;continue;}
    if(flag==='--network'){result.network=true;continue;}
    const value=args[++i];if(value===undefined || value.startsWith('--'))fail('cli.arguments');
    if(flag==='--recovery') {
      if(!/^\.pipeline\/transactions\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/recovery\.json$(?![\s\S])/.test(value))fail('recovery.path');
      result.recoveryPath=value;continue;
    }
    if(flag==='--bundles') {
      const ids=value.split(',');
      if(ids.some(id=>!/^[a-z][a-z0-9-]{0,62}$/.test(id)) || new Set(ids).size!==ids.length)fail('cli.arguments');
      result.bundles=ids.sort();continue;
    }
    if(flag==='--providers') {
      const providers=value.split(',');
      if(providers.some(p=>!['codex','claude','kimi','grok'].includes(p)) || new Set(providers).size!==providers.length)fail('cli.arguments');
      result.providers=providers.sort();continue;
    }
    result[{'--workspace':'workspace','--manifest':'manifestPath','--preview':'previewFile'}[flag]]=absoluteRoot(value);
  }
  if(!result.workspace)fail('cli.workspace-required');
    if(result.apply?(!result.previewFile || result.manifestPath || result.network || result.providers || result.bundles):result.previewFile)fail('cli.arguments');
  if(result.command==='switch' && !result.apply && !result.manifestPath)fail('switch.manifest-required');
  if(result.command==='continue' && (result.apply?result.recoveryPath:!result.recoveryPath))fail('continuation.recovery-required');
  return result;
}

async function runLifecycle(command,registry,stdout,stderr) {
  // A trusted embedding/CLI assembly can supply functions; argv and package
  // data cannot. Until real adapters ship, the default command fails before IO.
  if(registry===null || registry===undefined)fail('cli.providers-unavailable');
  await assertNoRepositoryPending(command.workspace);
  const maintenance=['repair','remove'].includes(command.command);
  const prepare=command.command==='continue'?prepareContinuationLifecycle:command.command==='switch'?prepareSwitchLifecycle:maintenance?prepareMaintenance:prepareLifecycle;
  const apply=command.command==='continue'?applyContinuationLifecycle:command.command==='switch'?applySwitchLifecycle:maintenance?applyMaintenance:applyLifecycle;
  if(!command.apply) {
    const input={command:command.command,wrapper:command.workspace};
    if(command.manifestPath)input.manifestPath=command.manifestPath;
    if(command.network)input.network=true;
    if(command.providers)input.providers=command.providers;
    if(command.bundles)input.bundles=command.bundles;
    if(command.recoveryPath)input.recoveryPath=command.recoveryPath;
    await stdout(JSON.stringify(await prepare(input,registry))+'\n');return 0;
  }
  const prepared=(await readRecord(command.previewFile)).value;
  const result=await apply({command:command.command,wrapper:command.workspace,prepared,
    approval:{decision:'approve',preparedDigest:prepared.digest}},registry,
    {report:async event=>stderr(JSON.stringify(event)+'\n')});
  await stdout(JSON.stringify(result)+'\n');
  return (result.status==='ready' || (['remove','continue'].includes(command.command) && result.status==='not-installed')) && result.lockRelease==='released' && !result.outputError?0:1;
}

function parseLogs(args) {
  if(args[1]==='policy')return parsePolicy(args);
  if(!['list','clean'].includes(args[1]))fail('cli.arguments');
  const result={command:'logs',action:args[1]},seen=new Set();
  const numbers={'--max-age-days':'maxAgeDays','--keep-last':'maxJournals','--max-delete':'maxDeletesPerRun'};
  const receiptNumbers={'--receipt-max-age-days':'maxAgeDays','--keep-receipts':'maxReceipts'};
  for(let i=2;i<args.length;i++) {
    const flag=args[i];
    if(!['--workspace','--json','--apply','--preview','--repositories',...Object.keys(numbers),...Object.keys(receiptNumbers)].includes(flag) || seen.has(flag))fail('cli.arguments');
    seen.add(flag);
    if(flag==='--json')continue;
    if(flag==='--repositories'){result.repositories=true;continue;}
    if(flag==='--apply'){result.apply=true;continue;}
    const value=args[++i];if(value===undefined || value.startsWith('--'))fail('cli.arguments');
    if(flag==='--workspace')result.workspace=absoluteRoot(value);
    else if(flag==='--preview')result.previewFile=absoluteRoot(value);
    else {
      if(!/^(0|[1-9][0-9]*)(?![\s\S])/.test(value) || !Number.isSafeInteger(Number(value)))fail('cli.arguments');
      if(Object.hasOwn(receiptNumbers,flag))(result.receiptPolicy??={})[receiptNumbers[flag]]=Number(value);
      else (result.policy??={})[numbers[flag]]=Number(value);
    }
  }
  if(!result.workspace)fail('cli.workspace-required');
  if(result.receiptPolicy && Object.keys(result.receiptPolicy).length!==2)fail('cli.arguments');
  if(result.repositories && (result.action!=='clean' || result.receiptPolicy))fail('cli.arguments');
  if(result.action==='list' && (result.apply || result.previewFile || result.policy || result.receiptPolicy))fail('cli.arguments');
  if(result.action==='clean') {
    if(result.apply) {if(!result.previewFile || result.policy || result.receiptPolicy)fail('cli.arguments');}
    else if(result.previewFile || !result.policy || Object.keys(result.policy).length!==3)fail('cli.arguments');
  }
  return result;
}
function combinedPolicy(command) {
  const {maxDeletesPerRun,...journals}=command.policy;
  return {journals,cleanupReceipts:command.receiptPolicy,maxDeletesPerRun};
}

function parsePolicy(args) {
  const action=args[2];if(!['show','set','disable'].includes(action))fail('cli.arguments');
  const rest=args.slice(3),filtered=[];let mode;
  for(let i=0;i<rest.length;i++) {
    if(rest[i]==='--mode') {
      if(mode!==undefined || !['automatic','disabled'].includes(rest[i+1]))fail('cli.arguments');
      mode=rest[++i];
    }else filtered.push(rest[i]);
  }
  // Reuse strict numeric, duplicate, path and apply/preview parsing.
  const parsed=parseLogs(['logs',action==='set'?'clean':filtered.includes('--apply')?'clean':'list',...filtered]);
  if(parsed.repositories)fail('cli.arguments');
  if(action==='set' && (parsed.apply?mode!==undefined:mode===undefined))fail('cli.arguments');
  if(action!=='set' && (mode!==undefined || parsed.policy))fail('cli.arguments');
  if(action==='show' && parsed.apply)fail('cli.arguments');
  return {...parsed,command:'policy',action,mode};
}

async function runPolicy(command,stdout) {
  if(command.action==='show') {
    await stdout(JSON.stringify(await readRetentionPolicy(command.workspace))+'\n');return 0;
  }
  if(!command.apply) {
    const request=command.action==='disable'?{action:'disable'}:{action:'set',mode:command.mode,
      ...command.receiptPolicy?combinedPolicy(command):{journals:command.policy}};
    await stdout(JSON.stringify(await previewRetentionPolicy(command.workspace,request))+'\n');return 0;
  }
  const preview=(await readRecord(command.previewFile)).value;
  if(preview.action!==command.action || preview.workspace!==command.workspace)fail('retention-policy.approval');
  const lock=await acquireWorkspaceLock(command.workspace);
  try {
    const result=await applyRetentionPolicy(lock,preview,{decision:'approve',previewDigest:preview.digest});
    await stdout(JSON.stringify(result)+'\n');return 0;
  }finally{await lock.release();}
}

async function runLogs(command,stdout,stderr) {
  if(command.action==='list') {
    // No retention policy chosen: disable selection and omit policy/plan fields.
    const scan=await scanRetention(command.workspace,{now:Date.now(),policy:{maxAgeDays:Math.floor(Number.MAX_SAFE_INTEGER/86400000),maxJournals:Number.MAX_SAFE_INTEGER,maxDeletesPerRun:0}});
    const receipts=await scanCleanupReceipts(command.workspace),repositories=await listRepositoryHistory(command.workspace);
    const complete=scan.complete&&receipts.complete&&repositories.complete;
    await stdout(JSON.stringify({workspace:scan.workspace,groups:scan.groups,receipts:receipts.records,
      repositories,diagnostics:[...scan.diagnostics,...receipts.diagnostics,...repositories.diagnostics],complete,selectionDisabled:true})+'\n');
    return complete?0:1;
  }
  if(!command.apply) {
    const preview=await (command.repositories?scanRepositoryRetention:command.receiptPolicy?scanCombinedRetention:scanRetention)(command.workspace,
      {now:Date.now(),policy:command.receiptPolicy?combinedPolicy(command):command.policy});
    await stdout(JSON.stringify(preview)+'\n');return preview.complete?0:1;
  }
  const preview=(await readRecord(command.previewFile)).value;
  if(preview.workspace!==command.workspace)fail('retention-apply.approval');
  if(Boolean(command.repositories)!==(preview.kind==='repository-retention-preview'))fail('retention-apply.approval');
  const lock=await acquireWorkspaceLock(command.workspace);
  try {
    const result=await (command.repositories?applyRepositoryRetention:applyRetention)(lock,preview,{decision:'approve',previewDigest:preview.digest},
      {report:async event=>stderr(JSON.stringify(event)+'\n')});
    await stdout(JSON.stringify(result)+'\n');return result.status==='completed'?0:1;
  }finally{await lock.release();}
}

export async function runCli(args,{stdout,stderr,registry=null}) {
  if(typeof stdout!=='function' || typeof stderr!=='function')fail('cli.transport');
  try {
    const command=parseCommand(args);
    if(command.command==='help') {await stdout(help+'\n');return 0;}
    if(command.command==='launch')return await runLaunch(command,stdout,stderr);
    if(command.command==='migration')return await runMigrationCommand(command,stdout,stderr);
    if(command.command==='logs')return await runLogs(command,stdout,stderr);
    if(command.command==='policy')return await runPolicy(command,stdout);
    if(['init','adopt'].includes(command.command))return await runRepositoryCommand(command,stdout,stderr);
    if(command.command==='repositories')return await (['prepare-parent','continue-parent'].includes(command.action)?runRepositoryAncestors:
      ['abandon','continue-abandon'].includes(command.action)?runRepositoryAbandon:
      command.action==='recover-locks'?runRepositoryLockRecovery:
      ['recover-bootstrap','continue-bootstrap','retire-bootstrap'].includes(command.action)?runBootstrapContinuation:runRepositoryRecovery)(command,stdout);
    if(['setup','update','repair','remove','switch','continue'].includes(command.command))return await runLifecycle(command,registry,stdout,stderr);
    const options=command.recoveryPath===undefined?{}:{recoveryPath:command.recoveryPath};
    const result=await inspectInstallation(command.workspace,options);
    await stdout(JSON.stringify(result)+'\n');
    return result.ready?0:1;
  } catch(error) {
    try {await stderr(JSON.stringify({error:error instanceof ContractError?error.code:'cli.io'})+'\n');}catch{}
    return 2;
  }
}
