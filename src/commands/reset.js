import {absoluteRoot,resolveChild} from '../workspace/paths.js';
import {ContractError,fail} from '../contracts/parse.js';
import {readRecord} from '../operations/state.js';
import {resetOptions,prepareReset,validateResetRecord} from '../operations/reset.js';
import {applyReset} from '../operations/apply.js';
import {acquireWorkspaceLock} from '../operations/lock.js';
import {inspectHistory} from '../operations/history.js';
import {assertNoRepositoryPending} from '../operations/repository-pending.js';

export function parseReset(args){
  const result={command:'reset'},seen=new Set();
  for(let i=1;i<args.length;i++){
    const flag=args[i];
    if(!['--workspace','--to','--all','--providers','--bundles','--apply','--preview','--json'].includes(flag) || seen.has(flag))fail('cli.arguments');
    seen.add(flag);
    if(flag==='--json')continue;
    if(flag==='--apply'){result.apply=true;continue;}
    if(flag==='--all'){(result.options??={}).all=true;continue;}
    const value=args[++i];if(!value || value.startsWith('--'))fail('cli.arguments');
    if(flag==='--workspace')result.workspace=absoluteRoot(value);
    else if(flag==='--preview')result.previewFile=absoluteRoot(value);
    else if(flag==='--to')(result.options??={}).to=value;
    else{
      const ids=value.split(',');
      if(ids.some(id=>!/^[a-z][a-z0-9-]{0,62}$/.test(id)) || new Set(ids).size!==ids.length)fail('cli.arguments');
      (result.options??={})[flag==='--providers'?'providers':'bundles']=ids.sort();
    }
  }
  if(!result.workspace)fail('cli.workspace-required');
  if(result.apply){if(!result.previewFile || result.options)fail('cli.arguments');}
  else {if(result.previewFile)fail('cli.arguments');result.options=resetOptions(result.options??{});}
  return result;
}
async function history(workspace){
  await assertNoRepositoryPending(workspace);
  const h=await inspectHistory(workspace);if(!h.complete || h.diagnostics.length)fail('reset.history');
}
export async function runReset(command,registry,stdout,stderr){
  if(!command.apply){
    await history(command.workspace);
    await stdout(JSON.stringify(await prepareReset(command.workspace,registry,command.options))+'\n');return 0;
  }
  const raw=(await readRecord(command.previewFile)).value;
  const approval={decision:'approve',preparedDigest:raw.digest};
  const prepared=validateResetRecord(raw,approval);
  if(prepared.preview.plan.workspace!==command.workspace)fail('reset.workspace');
  const result={command:'reset',mode:prepared.reset.selection.to,workspace:command.workspace,status:'failed',
    backupDirectory:resolveChild(command.workspace,prepared.reset.backup.directory),
    journal:null,recovery:null,runtime:'not-run',lockRelease:'not-acquired'};
  let lock;
  try{
    lock=await acquireWorkspaceLock(command.workspace);result.lockRelease='pending';await history(command.workspace);
    await stderr(JSON.stringify({kind:'reset-backup-location',path:result.backupDirectory,status:'not-yet-verified'})+'\n');
    const applied=await applyReset(lock,prepared,approval,registry,{onJournal:async location=>{
      result.journal=location.directory;
      result.recovery=resolveChild(command.workspace,location.relative.replace('/journals/','/transactions/')+'/recovery.json');
      await stderr(JSON.stringify({kind:'journal-location',path:result.journal,recovery:result.recovery,backupDirectory:result.backupDirectory})+'\n');
    }});
    result.status=applied.status;
  }catch(error){result.error=error instanceof ContractError?error.code:'reset.io';}
  finally{if(lock)try{await lock.release();result.lockRelease='released';}catch{result.lockRelease='failed';}}
  await stdout(JSON.stringify(result)+'\n');
  return ['ready','not-installed'].includes(result.status) && result.lockRelease==='released'?0:1;
}
