#!/usr/bin/env node
import {runCli} from './commands/dispatch.js';
import {providerRegistry} from './providers/registry.js';
const write=stream=>text=>new Promise((resolve,reject)=>stream.write(text,error=>error?reject(error):resolve()));
// Prevent an unhandled pipe error; write callbacks report delivery failures.
process.stdout.on('error',()=>{});process.stderr.on('error',()=>{});
process.exitCode=await runCli(process.argv.slice(2),{stdout:write(process.stdout),stderr:write(process.stderr),registry:providerRegistry});
