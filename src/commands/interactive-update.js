import {mkdtemp,writeFile,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runCli,parseCommand} from './dispatch.js';
import {safeTerminalText as safe} from './output.js';

export function updateSummary(saved){
  const p=saved.kind==='prepared-with-claude-compatibility'?saved.workspace:saved;
  const plan=p.preview.plan;
  const lines=['Workspace Pipeline — update',`Workspace: ${safe(plan.workspace)}`,
    `Pipeline: ${safe(plan.desired.pipelineId)} @ ${safe(plan.desired.version)}`,
    `Providers: ${plan.desired.providers.map(safe).join(', ')}`,`Changes: ${plan.targets.length}`];
  for(const t of plan.targets)lines.push(`  ${safe(t.action)}  ${safe(t.path)}`);
  const c=saved.compatibility;
  if(c){lines.push(`Grok global compatibility: ${safe(c.status)}`);
    if(c.path)lines.push(`  Config: ${safe(c.path)}`);
    for(const k of c.changes??[])lines.push(`  compat.claude.${safe(k)} = true`);
    for(const b of c.blockers??[])lines.push(`  BLOCKED: ${safe(b)}`);
    if(c.warning)lines.push(safe(c.warning));
  }
  lines.push('No automatic reset. Apply rechecks files and approval before writing.');
  return lines.join('\n')+'\n';
}

// Human-facing entry only. runCli remains the deterministic preview/apply API.
export async function runInteractiveUpdate(args,options,{isTTY=false,confirm,display,execute=runCli}={}){
  if(args[0]!=='update'||args.includes('--apply'))return execute(args,options);
  const yes=args.includes('--yes'),dry=args.includes('--preview');
  const clean=args.filter(x=>x!=='--yes'&&x!=='--preview');
  if(args.filter(x=>x==='--yes').length>1||args.filter(x=>x==='--preview').length>1||(yes&&dry)){
    await options.stdout(JSON.stringify({error:'cli.arguments'})+'\n');return 2;
  }
  // --json alone retains the existing machine preview contract; it never authorizes writes.
  if(dry||(args.includes('--json')&&!yes))return execute(clean,options);
  try{parseCommand(clean);}catch{return execute(clean,options);}
  if(!yes&&(!isTTY||!confirm)){
    await options.stdout(JSON.stringify({error:'cli.confirmation-required',next:'Use an interactive terminal, --yes to apply, or --preview --json for a saved plan.'})+'\n');return 2;
  }
  let raw='';
  const code=await execute(clean,{...options,stdout:async text=>{raw+=text;}});
  if(code!==0){if(raw)await options.stdout(raw);return code;}
  const saved=JSON.parse(raw);
  await display(updateSummary(saved));
  if(saved.compatibility?.status==='blocked'){
    await options.stdout(JSON.stringify({status:'blocked',error:'grok-compat.blocked'})+'\n');return 1;
  }
  if(!yes&&await confirm()!==true){await options.stdout(JSON.stringify({status:'cancelled',applied:false})+'\n');return 0;}
  // Feed the exact approved bytes through the same public saved-preview verifier.
  const dir=await mkdtemp(path.join(tmpdir(),'wpc-approved-update-'));
  const file=path.join(dir,'preview.json');
  try{
    await writeFile(file,raw,{flag:'wx',mode:0o600});
    const command=parseCommand(clean);
    return await execute(['update','--workspace',command.workspace,'--apply','--preview',file],options);
  }finally{
    // Only our one named temporary file, never a recursive workspace cleanup.
    await unlink(file).catch(()=>{});await rmdir(dir).catch(()=>{});
  }
}
