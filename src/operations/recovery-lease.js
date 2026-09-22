import {createServer} from 'node:net';
import {realpath} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {absoluteRoot,inspectDirectory} from '../workspace/paths.js';
import {fail} from '../contracts/parse.js';

// Local-host exclusion only. The kernel releases ownership on process death;
// durable recovery records describe progress, never ownership of this lease.
// No TCP listener, data protocol, filesystem socket or persistent recovery lock.
// Unsupported platforms fail closed rather than falling back to a stale lockfile.
const held=new WeakMap();
async function endpoint(wrapper) {
  wrapper=absoluteRoot(wrapper);
  const parent=path.dirname(wrapper);
  if(!(await inspectDirectory(parent)).exists)fail('recovery-lease.parent-missing');
  // Existing linked/reparse wrapper roots are unsupported, just like parents.
  // Do not give an alias a second ownership endpoint.
  await inspectDirectory(wrapper);
  let canonical=path.join(await realpath(parent),path.basename(wrapper));
  if(process.platform==='win32')canonical=canonical.toLowerCase();
  const key=createHash('sha256').update(canonical).digest('hex');
  if(process.platform==='win32')return '\\\\.\\pipe\\wpc-recovery-'+key;
  if(process.platform==='linux')return '\0wpc-recovery-'+key;
  fail('recovery-lease.platform-unsupported');
}

export async function acquireRecoveryLease(wrapper) {
  const name=await endpoint(wrapper);
  const server=createServer(socket=>socket.destroy());
  let failure=false,released=false;
  server.on('error',()=>{failure=true;});
  await new Promise((resolve,reject)=>{
    const error=e=>{server.removeListener('listening',ready);reject(e);};
    const ready=()=>{server.removeListener('error',error);resolve();};
    server.once('error',error);server.once('listening',ready);
    server.listen({path:name,exclusive:true});
  }).catch(e=>fail(e.code==='EADDRINUSE'?'recovery-lease.busy':
    e.code==='EACCES'?'recovery-lease.busy-or-access-denied':'recovery-lease.io'));
  const check=()=>{if(released || failure || !server.listening)fail('recovery-lease.not-held');};
  const lease=Object.freeze({async release(){
    if(released)fail('recovery-lease.not-held');
    released=true;
    // Cleanup must run even when an asynchronous listener error invalidated check().
    await new Promise((resolve,reject)=>server.close(e=>
      e && e.code!=='ERR_SERVER_NOT_RUNNING'?reject(e):resolve()))
      .catch(()=>fail('recovery-lease.release-failed-status-required'));
    if(failure)fail('recovery-lease.lost-status-required');
  }});
  held.set(lease,check);return lease;
}
export function assertRecoveryLeaseHeld(lease) {
  const check=lease && held.get(lease);
  if(!check)fail('recovery-lease.capability');check();
}
export async function withRecoveryLease(wrapper,run) {
  const lease=await acquireRecoveryLease(wrapper);
  let result,runError,failed=false;
  try{result=await run(lease);}catch(e){failed=true;runError=e;}
  try{await lease.release();}catch(e){
    if(failed)fail('recovery-lease.run-and-release-failed-status-required');
    throw e;
  }
  if(failed)throw runError;
  return result;
}
