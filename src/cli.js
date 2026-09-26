#!/usr/bin/env node
import {providerRegistry} from './providers/registry.js';
import {outputWriter} from './commands/output.js';
import {createClaudeCompatibility} from './compat/claude.js';
import {runInteractiveUpdate} from './commands/interactive-update.js';
import {tryDesiredLifecycle} from './commands/desired-lifecycle.js';
import {createInterface} from 'node:readline/promises';
const write=stream=>text=>new Promise((resolve,reject)=>stream.write(text,error=>error?reject(error):resolve()));
// Prevent an unhandled pipe error; write callbacks report delivery failures.
process.stdout.on('error',()=>{});process.stderr.on('error',()=>{});
const args=process.argv.slice(2),json=args.includes('--json');
const options={stdout:outputWriter(write(process.stdout),json),stderr:outputWriter(write(process.stderr),json),registry:providerRegistry,compatibility:createClaudeCompatibility()};
try{
  const interaction={
    isTTY:Boolean(process.stdin.isTTY&&process.stderr.isTTY),display:write(process.stderr),
    confirm:async()=>{
      const rl=createInterface({input:process.stdin,output:process.stderr});
      try{return /^(y|yes|д|да)$/i.test((await rl.question('Apply these changes? [y/N] ')).trim());}
      catch{return false;}finally{rl.close();}
    }
  };
  const desired=await tryDesiredLifecycle(args,options,interaction);
  process.exitCode=desired??await runInteractiveUpdate(args,options,interaction);
}catch{
  await options.stderr(JSON.stringify({error:'cli.interactive-io',next:'Inspect doctor before retry; no automatic retry or reset.'})+'\n');process.exitCode=2;
}
