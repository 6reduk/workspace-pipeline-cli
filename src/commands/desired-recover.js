import {ContractError,fail} from '../contracts/parse.js';
import {desiredArguments} from './desired-setup.js';
import {inspectDesiredLock,recoverDesiredLock} from '../desired-state/lock-recovery.js';
import {safeTerminalText as safe} from './output.js';

export async function runDesiredRecovery(args,options,{isTTY=false,confirm,display,hostOptions={}}={}) {
  try {
    if(args.filter(a=>a==='--global').length>1)fail('cli.arguments');
    const {seen,values}=desiredArguments(args.filter(a=>a!=='--global'));
    if(!values.has('--workspace')||[...seen].some(f=>!['--workspace','--yes','--preview','--json'].includes(f)))fail('cli.arguments');
    const dry=seen.has('--preview'),yes=seen.has('--yes');
    if(dry&&yes)fail('cli.arguments');
    if(!dry&&!yes&&(!isTTY||!confirm))fail('cli.confirmation-required');
    const workspace=values.get('--workspace'),settings={userHome:hostOptions.userHome,global:args.includes('--global')};
    const observed=await inspectDesiredLock(workspace,settings);
    if(dry){await options.stdout(JSON.stringify({...observed,applied:false})+'\n');return observed.status==='owner-unconfirmed'?1:0;}
    const text=['Workspace Pipeline — recover-lock',`Workspace: ${safe(observed.workspace)}`,
      `Lock: ${safe(observed.path)}`,`Owner status: ${safe(observed.lock?.liveness??'absent')}`,
      'Only stale lock metadata will be deleted; no process is killed and no installation is resumed.',
      ...(settings.global?['GLOBAL lock: user-wide Grok config lock; configuration remains unchanged.']:[])].join('\n')+'\n';
    if(display)await display(text);else await options.stderr(text);
    if(observed.status==='owner-unconfirmed')fail('desired.recovery-owner-unconfirmed');
    if(!yes&&await confirm()!==true){await options.stdout(JSON.stringify({status:'cancelled',applied:false})+'\n');return 0;}
    await options.stdout(JSON.stringify(await recoverDesiredLock(workspace,observed,settings))+'\n');return 0;
  }catch(error){await options.stderr(JSON.stringify({error:error instanceof ContractError?error.code:'cli.desired-recovery-io',
    ...(error.recovery?{recovery:error.recovery}:{}),
    next:'Inspect lock paths and pending state; do not delete unknown locks or operation records.'})+'\n');return 2;}
}
