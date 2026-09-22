import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir,hostname} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readdir,readFile,lstat} from 'node:fs/promises';
import {bootstrapLockDirectory} from '../src/operations/bootstrap-lock.js';
import {runCli} from '../src/commands/dispatch.js';

async function snapshot(root){
  const result=[];
  async function visit(dir,prefix=''){
    for(const name of (await readdir(dir)).sort()){
      const file=path.join(dir,name),relative=prefix+name,s=await lstat(file,{bigint:true});
      result.push({path:relative,dev:String(s.dev),ino:String(s.ino),type:s.isDirectory()?'directory':'file',
        ...(s.isFile()?{digest:createHash('sha256').update(await readFile(file)).digest('hex')}:{})});
      if(s.isDirectory())await visit(file,relative+'/');
    }
  }
  await visit(root);return result;
}
async function call(args){let out='',err='';const code=await runCli(args,{stdout:s=>{out+=s;},stderr:s=>{err+=s;}});return {code,out,err};}
for(const kind of ['empty-owner','torn-owner','live-owner','foreign-host','owner-only-gate','torn-gate-request']){
test('S7 manual classification preserves '+kind+' and never grants recovery',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wpc-manual-')),wrapper=path.join(root,'wrapper');
  const base=bootstrapLockDirectory(wrapper),gate=kind.includes('gate'),directory=gate?base+'.recovery':base;
  await mkdir(directory);
  if(kind!=='empty-owner')await writeFile(path.join(directory,'owner.json'),kind==='torn-owner'?'{':JSON.stringify({
    schemaVersion:1,workspace:wrapper,wrapper,token:randomUUID(),pid:process.pid,
    host:kind==='foreign-host'?'different-host':hostname(),createdAt:new Date().toISOString()}));
  // Native owner-only schemas reject extra fields; use the exact valid owner to
  // test that liveness alone blocks rather than relying on schema rejection.
  if(kind==='live-owner' || kind==='foreign-host')await writeFile(path.join(directory,'owner.json'),JSON.stringify({
    schemaVersion:1,workspace:wrapper,token:randomUUID(),pid:process.pid,
    host:kind==='foreign-host'?'different-host':hostname(),createdAt:new Date().toISOString()}));
  if(kind==='torn-gate-request')await writeFile(path.join(directory,'request.json'),'{');
  const before=await snapshot(root);
  const status=await call(['repositories','status','--workspace',wrapper]);assert.notEqual(status.code,0);
  assert.ok(JSON.parse(status.out).blockers.length>0);
  const checked=await call(['repositories',gate?'continue-bootstrap':'retire-bootstrap','--workspace',wrapper]);
  assert.notEqual(checked.code,0);
  if(checked.out){const value=JSON.parse(checked.out);assert.equal(value.status,'blocked');assert.equal(value.executionAuthorized,false);}
  assert.deepEqual(await snapshot(root),before);
});}
test('S7 manual classification refuses torn operation inputs without rewriting pending metadata',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wpc-manual-')),wrapper=path.join(root,'wrapper');
  await mkdir(path.join(wrapper,'.pipeline'),{recursive:true});
  await writeFile(path.join(wrapper,'.pipeline','repository-operation.json'),'{');
  const before=await snapshot(root),result=await call(['repositories','status','--workspace',wrapper]);
  assert.notEqual(result.code,0);assert.deepEqual(await snapshot(root),before);
});
