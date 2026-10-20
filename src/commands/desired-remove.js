import {ContractError,fail} from '../contracts/parse.js';
import {absoluteRoot} from '../workspace/paths.js';
import {observeTargets} from '../operations/state.js';
import {readDesiredRecords,installedPath,pendingPath} from '../desired-state/records.js';
import {prepareDesiredRemoval} from '../desired-state/removal.js';
import {inspectDesiredFiles} from '../desired-state/inventory.js';
import {prepareLocalSettings} from '../desired-state/local-settings.js';
import {applyDesiredFiles} from '../desired-state/apply-files.js';
import {desiredArguments} from './desired-setup.js';
import {safeTerminalText as safe} from './output.js';
import {preflightOpenSpec,assertOpenSpecRemoval,openSpecContext,describeOpenSpecStore} from '../integrations/openspec.js';

export async function tryDesiredRemove(args,options,{isTTY=false,confirm,display,hostOptions={}}={}) {
  if(args[0]!=='remove')return null;
  const at=args.indexOf('--workspace');if(at<0||!args[at+1])return null;
  try {
    const workspace=absoluteRoot(args[at+1]);
    const markers=await observeTargets(workspace,[installedPath,pendingPath]);
    if(markers.every(m=>m.bytes===null))return null;
    const {seen}=desiredArguments(args);
    if([...seen].some(f=>!['--workspace','--preview','--yes','--json','--backup'].includes(f)))fail('cli.arguments');
    const dry=seen.has('--preview'),yes=seen.has('--yes');
    if(dry&&yes)fail('cli.arguments');
    if(!dry&&!yes&&(!isTTY||!confirm))fail('cli.confirmation-required');
    const records=await readDesiredRecords(workspace),prepared=await prepareDesiredRemoval(workspace,records);
    const context=openSpecContext(records);
    if(records.installed?.value.openspec||records.pending?.value.openspec)await assertOpenSpecRemoval(workspace,context);
    if(prepared.alreadyRemoved){await options.stdout(JSON.stringify({workspace,status:'removed',applied:false,globalSettings:'preserved'})+'\n');return 0;}
    const files=await inspectDesiredFiles(workspace,prepared.desired);
    const openspec=await preflightOpenSpec(workspace,null,undefined,context);
    const openspecStore=await describeOpenSpecStore(workspace,null,context);
    const local=await prepareLocalSettings(workspace,prepared.settings);
    const summary={command:'remove',workspace,status:'preview',applied:false,files,
      openspec:openspec&&openspec.status!=='removed'?{scopes:openspec.scopes,preservePlanning:true}:null,openspecStore,
      localSettings:local.map(s=>({path:s.path,changed:s.changed})),backup:seen.has('--backup'),globalSettings:'preserved',
      preserved:['workspace.json','project repositories','.pipeline journals and backups']};
    if(dry){await options.stdout(JSON.stringify(summary)+'\n');return files.ready?0:1;}
    const lines=['Workspace Pipeline — remove',`Workspace: ${safe(workspace)}`,`Backup: ${summary.backup?'enabled':'OFF'}`,
      'Remove all recorded adapter files, including custom files inside owned directories.',
      'Preserve repositories, workspace.json, journals/backups and shared global settings.'];
    if(openspec&&openspec.status!=='removed'){
      lines.push('Remove local OpenSpec runtime and recorded skill directories; preserve specs, changes and project config.');
      for(const scope of openspec.scopes)lines.push(`  OpenSpec remove: ${safe(scope)}`);
    }
    if(openspecStore){
      lines.push(`OpenSpec store ${safe(openspecStore.id)}: remove local registry, preserve docs identity and all planning artifacts.`);
      for(const item of openspecStore.bindings)lines.push(`  store pointer: ${safe(item.path)} — ${safe(item.action)} (${safe(item.ownership)})`);
      if(openspecStore.bindings.some(item=>item.ownership==='borrowed'))lines.push('Borrowed pointers remain; another installation must register their store before use.');
    }
    for(const item of files.extra)lines.push(`  remove: ${safe(item.path)}`);
    for(const item of files.blocked)lines.push(`  blocked: ${safe(item.path)}`);
    for(const item of summary.localSettings)lines.push(`  settings: ${safe(item.path)} (${item.changed?'remove owned fields':'unchanged'})`);
    if(display)await display(lines.join('\n')+'\n');else await options.stderr(lines.join('\n')+'\n');
    if(!files.ready)fail('desired.unsafe-target');
    if(!yes&&await confirm()!==true){await options.stdout(JSON.stringify({status:'cancelled',applied:false})+'\n');return 0;}
    const result=await applyDesiredFiles({workspace,protectedPaths:prepared.protectedPaths,backup:summary.backup},
      {...hostOptions,removeExisting:true,removalExpected:{installed:records.installed?.hash??null,pending:records.pending?.hash??null}});
    await options.stdout(JSON.stringify({...result,workspace,preserved:summary.preserved})+'\n');return 0;
  }catch(error){
    await options.stderr(JSON.stringify({error:error instanceof ContractError?error.code:'cli.desired-remove-io',
      ...(error instanceof ContractError&&error.subject?{subject:error.subject}:{}),
      ...(error instanceof ContractError&&error.repository?{repository:error.repository}:{}),
      ...(error instanceof ContractError&&error.hint?{hint:error.hint}:{}),
      ...(error.desiredState?{application:error.desiredState}:{})})+'\n');return 2;
  }
}
