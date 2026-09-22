import path from 'node:path';
import {tmpdir} from 'node:os';
import {fail} from '../contracts/parse.js';
import {contractDigest} from '../contracts/semantic.js';
import {requestShape} from '../operations/ownership.js';
import {resolveOrigin,verifyPreparedSnapshot,readRecord} from '../operations/state.js';
import {acquire} from '../source/git.js';
import {absoluteRoot} from '../workspace/paths.js';
import {assertNoRepositoryPending} from '../operations/repository-pending.js';
import {prepareRepositoryPreview} from '../workspace/repository-preview.js';
import {applyRepositoryWorkspace} from '../operations/repository-workspace.js';
import {inspectRepositoryReconciliation,finalizeRepositoryOperations} from '../operations/repository-reconcile.js';

function verb(command){if(!['init','adopt'].includes(command))fail('repositories.command');}
function outside(root,candidate) {
  const relative=path.relative(root.toLowerCase(),candidate.toLowerCase());
  if(relative==='' || (!path.isAbsolute(relative) && relative!=='..' && !relative.startsWith('..'+path.sep)))
    fail('repositories.preparation-location');
}

// Repository orchestration only. Provider installation is a separate setup plan;
// no provider functions, package scripts, hooks or native plugins are loaded.
export async function prepareRepositoryCommand({command,wrapper,manifestPath,choices,network=false,tempRoot=tmpdir()}) {
  verb(command);wrapper=absoluteRoot(wrapper);tempRoot=absoluteRoot(tempRoot);
  outside(wrapper,tempRoot);await assertNoRepositoryPending(wrapper);
  const origin=await resolveOrigin({wrapper,manifestPath});
  for(const choice of Object.values(choices??{}))if(choice?.action==='move')outside(absoluteRoot(choice.from),tempRoot);
  const acquired=await acquire(origin.manifest.pipeline,{manifestBase:origin.origin.base,tempRoot,network});
  const verified=await verifyPreparedSnapshot(acquired);
  const options={command,manifestPath:origin.origin.path,tempRoot,network};
  const preview=await prepareRepositoryPreview(verified.manifest,origin.manifest,wrapper,choices,options);
  const again=await resolveOrigin({wrapper,manifestPath:origin.origin.path});
  if(contractDigest(again)!==contractDigest(origin))fail('repositories.origin-drift');
  const body={schemaVersion:1,kind:'prepared-repository-command',command,wrapper,origin,acquired,
    choices:structuredClone(choices),options,preview,finalization:'verify-and-retain-history',pipelineActivated:false};
  return {...body,digest:contractDigest(body)};
}

export async function applyRepositoryCommand({command,wrapper,prepared,approval},{report=async()=>{}}={}) {
  verb(command);wrapper=absoluteRoot(wrapper);
  requestShape(prepared,['schemaVersion','kind','command','wrapper','origin','acquired','choices','options','preview','finalization','pipelineActivated','digest'],[],'repositories.prepared');
  const {digest,...body}=prepared;
  if(approval?.decision!=='approve' || approval.preparedDigest!==digest || contractDigest(body)!==digest ||
    prepared.schemaVersion!==1 || prepared.kind!=='prepared-repository-command' || prepared.command!==command ||
    prepared.wrapper!==wrapper || prepared.finalization!=='verify-and-retain-history' || prepared.pipelineActivated!==false)
    fail('repositories.prepared-binding');
  requestShape(prepared.options,['command','manifestPath','tempRoot','network'],[],'repositories.options');
  if(prepared.options.command!==command || prepared.options.manifestPath!==prepared.origin?.origin?.path)
    fail('repositories.prepared-binding');
  outside(wrapper,absoluteRoot(prepared.options.tempRoot));await assertNoRepositoryPending(wrapper);
  const origin=await resolveOrigin({wrapper,manifestPath:prepared.options.manifestPath});
  if(contractDigest(origin)!==contractDigest(prepared.origin) ||
    contractDigest(prepared.acquired.source)!==contractDigest(origin.manifest.pipeline) ||
    prepared.acquired.resolvedSource!==origin.origin.resolvedSource)fail('repositories.origin-drift');
  outside(wrapper,absoluteRoot(prepared.acquired.snapshotPath));
  const verified=await verifyPreparedSnapshot(prepared.acquired);
  const input={pipeline:verified.manifest,workspace:origin.manifest,wrapper,choices:prepared.choices,
    options:prepared.options,previewText:JSON.stringify(prepared.preview),
    approval:{decision:'approve',previewDigest:prepared.preview.digest},onLocation:report};
  const applied=await applyRepositoryWorkspace(input);
  const executionPreview=applied.executionPreview??prepared.preview;
  const previewText=JSON.stringify(executionPreview);
  const checked=await inspectRepositoryReconciliation(wrapper,previewText,executionPreview.digest);
  if(!checked.canFinalize)fail('repositories.finalization-unresolved');
  // Finalization was explicitly part of the approved command; this does not
  // authorize different effects or a provider installation.
  const finalized=await finalizeRepositoryOperations({wrapper,previewText,previewDigest:executionPreview.digest,
    approval:{decision:'approve',reconciliationDigest:checked.digest}});
  return {status:'repositories-prepared',command,wrapper,journal:applied.journal,executionPreview,
    finalization:finalized,pipelineActivated:false,next:'Prepare a separate setup preview for provider configuration.'};
}

export async function runRepositoryCommand(command,stdout,stderr) {
  if(!command.apply) {
    const choices=(await readRecord(command.choicesFile)).value;
    const prepared=await prepareRepositoryCommand({command:command.command,wrapper:command.workspace,
      manifestPath:command.manifestPath,choices,network:command.network??false});
    await stdout(JSON.stringify(prepared)+'\n');return prepared.preview.status==='blocked'?1:0;
  }
  const prepared=(await readRecord(command.previewFile)).value;
  const result=await applyRepositoryCommand({command:command.command,wrapper:command.workspace,prepared,
    approval:{decision:'approve',preparedDigest:prepared.digest}},{report:async event=>stderr(JSON.stringify({kind:'repository-location',...event})+'\n')});
  await stdout(JSON.stringify(result)+'\n');return 0;
}
