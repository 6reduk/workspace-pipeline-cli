#!/usr/bin/env node
import {runCli} from './commands/dispatch.js';
import {providerRegistry} from './providers/registry.js';
import {outputWriter} from './commands/output.js';
import {createClaudeCompatibility} from './compat/claude.js';
const write=stream=>text=>new Promise((resolve,reject)=>stream.write(text,error=>error?reject(error):resolve()));
// Prevent an unhandled pipe error; write callbacks report delivery failures.
process.stdout.on('error',()=>{});process.stderr.on('error',()=>{});
const args=process.argv.slice(2),json=args.includes('--json');
process.exitCode=await runCli(args,{stdout:outputWriter(write(process.stdout),json),stderr:outputWriter(write(process.stderr),json),registry:providerRegistry,compatibility:createClaudeCompatibility()});
