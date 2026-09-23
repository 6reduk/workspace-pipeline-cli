import {fail} from '../contracts/parse.js';
import {absoluteRoot} from '../workspace/paths.js';
import {contractDigest} from '../contracts/semantic.js';
import {readRecord} from '../operations/state.js';
export function parseCompat(args){
  if(args[1]!=='claude')fail('cli.arguments');
  const result={command:'compat',recover:args[2]==='recover-lock'},seen=new Set();
  for(let i=result.recover?3:2;i<args.length;i++){
    const flag=args[i];if(!['--json','--apply','--preview'].includes(flag)||seen.has(flag))fail('cli.arguments');seen.add(flag);
    if(flag==='--json')continue;if(flag==='--apply'){result.apply=true;continue;}
    const value=args[++i];if(!value||value.startsWith('--'))fail('cli.arguments');result.previewFile=absoluteRoot(value);
  }
  if(Boolean(result.apply)!==Boolean(result.previewFile))fail('cli.arguments');return result;
}
export async function runCompat(command,service,stdout){
  if(!service)fail('grok-compat.unavailable');
  if(!command.apply){const body={kind:'grok-compat-command',action:command.recover?'recover-lock':'enable',plan:await (command.recover?service.recovery():service.inspect())};
    await stdout(JSON.stringify({...body,digest:contractDigest(body)})+'\n');return body.plan.status==='blocked'?1:0;}
  const record=(await readRecord(command.previewFile)).value,{digest,...body}=record;
  if(Object.keys(record).sort().join(',')!=='action,digest,kind,plan'||record.kind!=='grok-compat-command'||record.action!==(command.recover?'recover-lock':'enable')||digest!==contractDigest(body))fail('grok-compat.envelope');
  const result=await (command.recover?service.recover(record.plan):service.apply(record.plan));await stdout(JSON.stringify(result)+'\n');return 0;
}
