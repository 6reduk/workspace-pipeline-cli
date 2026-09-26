import path from 'node:path';
import {homedir} from 'node:os';
import {ContractError,fail,parse} from '../contracts/parse.js';
import {absoluteRoot} from '../workspace/paths.js';
import {observeTargets} from '../operations/state.js';
import {utf8} from '../source/inventory.js';
import {prepareDesiredWorkspace} from '../desired-state/source.js';
import {materializeDesiredFiles,inspectDesiredFiles} from '../desired-state/inventory.js';
import {compileDesiredManifest} from '../contracts/desired-state.js';
import {readDesiredRecords} from '../desired-state/records.js';
import {includeRetiredTargets} from '../desired-state/retirement.js';
import {prepareLocalSettings} from '../desired-state/local-settings.js';
import {compileDesiredSettings} from '../desired-state/settings.js';
import {applyDesiredFiles} from '../desired-state/apply-files.js';
import {safeTerminalText as safe} from './output.js';
import {desiredArguments,initialDescriptor} from './desired-setup.js';
import {tryDesiredRemove} from './desired-remove.js';
import {prepareDesiredReset} from '../desired-state/reset.js';
import {runDesiredRecovery} from './desired-recover.js';

// V2 entrypoint; null preserves the old CLI path for old descriptors. No new
// source-supplied executable hooks, model changes or external preview required.
export async function tryDesiredLifecycle(args,options,{isTTY=false,confirm,display,hostOptions={}}={}) {
  if(args[0]==='recover-lock')return runDesiredRecovery(args,options,{isTTY,confirm,display,hostOptions});
  if(args[0]==='remove')return tryDesiredRemove(args,options,{isTTY,confirm,display,hostOptions});
  if(!['setup','update','reset'].includes(args[0]) || args.includes('--apply'))return null;
  const at=args.indexOf('--workspace');if(at<0 || !args[at+1])return null;
  try {
    const workspace=absoluteRoot(args[at+1]);
    const [entry]=await observeTargets(workspace,['workspace.json']);
    const creating=args[0]==='setup'&&args.includes('--source');
    if(!creating&&entry.bytes===null)return null;
    let descriptor=entry.bytes===null?null:parse(utf8(entry.bytes),'json');
    if(!creating&&descriptor.schemaVersion!==2)return null;
    const parsed=desiredArguments(args),{seen}=parsed;
    if(creating) {
      if(entry.bytes!==null)fail('desired.setup-already-configured');
      descriptor=initialDescriptor(workspace,parsed,{cwd:hostOptions.cwd});
    } else if(['--source','--adapters','--ref','--subdirectory','--repository','--documentation'].some(f=>seen.has(f)))fail('cli.arguments');
    const dry=seen.has('--preview'),yes=seen.has('--yes');
    if(dry&&yes)fail('cli.arguments');
    if(!dry && !yes && (!isTTY||!confirm))fail('cli.confirmation-required');
    const records=await readDesiredRecords(workspace,{allowLegacyMigration:true});
    if(records.pending?.value.intent==='remove')fail('desired.finish-remove-before-update');
    // Selecting a remote Git source and requesting setup/update authorizes the
    // source fetch, not changes to the workspace before confirmation.
    const prepare=args[0]==='reset'?prepareDesiredReset:prepareDesiredWorkspace;
    const prepared=await prepare(workspace,JSON.stringify(descriptor),{
      tempRoot:hostOptions.tempRoot,network:descriptor.pipeline?.transport==='remote'});
    const compiled=compileDesiredManifest(prepared.input.manifest,{selected:prepared.input.selected,protectedPaths:prepared.input.protectedPaths});
    const delivered=materializeDesiredFiles(compiled,prepared.input.source);
    const previousRoots=Object.values(records.installed?.value.binding?.layout.repositories??{}).map(r=>r.path);
    const protectedPaths=[...new Set([...prepared.input.protectedPaths,...previousRoots,...(records.legacy?.protectedPaths??[])])];
    compileDesiredManifest(prepared.input.manifest,{selected:prepared.input.selected,protectedPaths});
    const retired=includeRetiredTargets(records.installed?.value??records.legacy?.ownership,compiled,delivered,protectedPaths);
    const files=await inspectDesiredFiles(workspace,retired.desired);
    const local=await prepareLocalSettings(workspace,retired.settings.filter(s=>s.target!=='grok.user'));
    const globalOps=retired.settings.filter(s=>s.target==='grok.user');let global=null;
    if(globalOps.length) {
      const home=absoluteRoot(hostOptions.userHome??homedir());
      const [observed]=await observeTargets(home,['.grok/config.toml']);
      const result=compileDesiredSettings('grok.user',observed.bytes,globalOps);
      global={path:path.join(home,'.grok/config.toml'),changed:result.changed};
    }
    const summary={command:args[0],workspace,pipeline:compiled.pipeline,providers:compiled.providers,
      files,localSettings:local.map(s=>({path:s.path,changed:s.changed})),globalSettings:global,
      backup:seen.has('--backup'),legacyMigration:Boolean(records.legacy),...(prepared.reset?{reset:prepared.reset}:{}),descriptor:{path:'workspace.json',action:creating?'create':'preserve',layout:descriptor.layout},provenance:prepared.provenance,preparation:prepared.preparation};
    if(dry){await options.stdout(JSON.stringify({...summary,status:'preview',applied:false})+'\n');return files.ready?0:1;}
    const lines=[`Workspace Pipeline — ${args[0]}`,`Workspace: ${safe(workspace)}`,
      `Pipeline: ${safe(compiled.pipeline.id)} @ ${safe(compiled.pipeline.version)}`,
      `Backup: ${summary.backup?'enabled':'OFF'}`,
      'The entire declared adapter scope will be replaced; custom files in it will be removed.'];
    lines.push(`workspace.json: ${creating?'create':'preserve'}`);
    if(prepared.reset)lines.push(`Reset: ${prepared.reset.mode}, Git revision ${safe(prepared.reset.commit)} (not latest).`);
    for(const [id,repo] of Object.entries(descriptor.layout.repositories))lines.push(`Repository ${safe(id)}: ${safe(repo.path)} (not moved or cloned)`);
    lines.push(`Documentation: ${safe(descriptor.layout.documentation.repository)} / ${safe(descriptor.layout.documentation.path)}`);
    for(const category of ['extra','modified','missing','blocked'])for(const item of files[category])lines.push(`  ${category}: ${safe(item.path)}`);
    for(const item of summary.localSettings)lines.push(`  settings: ${safe(item.path)} (${item.changed?'change':'unchanged'})`);
    if(global)lines.push(`GLOBAL settings: ${safe(global.path)} (${global.changed?'change':'unchanged'}); affects other workspaces.`);
    if(records.legacy)lines.push('Migrate legacy installation state; preserve its record in .pipeline/history and leave existing journals unchanged.');
    if(display)await display(lines.join('\n')+'\n');else await options.stderr(lines.join('\n')+'\n');
    if(!files.ready)fail('desired.unsafe-target');
    if(!yes && await confirm()!==true){await options.stdout(JSON.stringify({status:'cancelled',applied:false})+'\n');return 0;}
    // Apply the already acquired immutable source; do not fetch again after consent.
    const result=await applyDesiredFiles({...prepared.input,backup:summary.backup},{...hostOptions,createDescriptor:creating,migrateLegacy:Boolean(records.legacy),expectedRecords:prepared.expectedRecords});
    await options.stdout(JSON.stringify({...result,...(prepared.reset?{reset:prepared.reset}:{}),provenance:prepared.provenance,preparation:prepared.preparation})+'\n');return 0;
  }catch(error){
    await options.stderr(JSON.stringify({error:error instanceof ContractError?error.code:'cli.desired-io',
      ...(error.code==='desired.setup-already-configured'?{hint:'workspace.json already exists. Run doctor, then update using the saved declaration; do not repeat setup --source. If an installation was interrupted and the source ref moved, use reset. Finish pending removal with remove first.'}:{}),
      ...(error.code==='desired.finish-remove-before-update'?{hint:'Finish the pending removal with remove before setup, update or reset.'}:{}),
      ...(error.desiredState?{application:error.desiredState}:{})})+'\n');return 2;
  }
}
