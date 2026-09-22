import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,mkdir,writeFile,readFile,readdir,symlink} from 'node:fs/promises';
import {prepareRepositoryPreview} from '../src/workspace/repository-preview.js';
import {applyRepositoryOperations} from '../src/operations/repository-apply.js';
import {inspectRepositoryReconciliation,finalizeRepositoryOperations} from '../src/operations/repository-reconcile.js';
import {scanRepositoryRetention} from '../src/operations/repository-retention.js';
import {applyRepositoryRetention} from '../src/operations/repository-retention-apply.js';
import {acquireWorkspaceLock} from '../src/operations/lock.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {bootstrapLockDirectory} from '../src/operations/bootstrap-lock.js';
import {runCli,parseCommand} from '../src/commands/dispatch.js';
const policy={maxAgeDays:0,maxJournals:0,maxDeletesPerRun:1};
async function fixture() {
  const base=await mkdtemp(path.join(tmpdir(),'wpc-repo-retention-')),wrapper=path.join(base,'wrapper');await mkdir(wrapper);
  const pipeline={schemaVersion:1,id:'example',version:'1.0.0',resources:'resources',inventory:'inventory.json',
    providers:{codex:{skills:'skills',agents:null,mcp:null,entryInstructions:null,requires:[]}},agentsDocument:{mode:'default'}};
  const workspace={schemaVersion:1,pipeline:{type:'git',transport:'local',path:'pipeline',ref:'HEAD',subdirectory:'.'},providers:['codex'],
    layout:{kind:'single-repo',repositories:{game:{path:'project',role:'code'}},documentation:{repository:'game',path:'docs'}}};
  const manifestPath=path.join(base,'workspace.json');await writeFile(manifestPath,JSON.stringify(workspace));
  const choices={game:{action:'directory'}},options={command:'adopt',manifestPath};
  const preview=await prepareRepositoryPreview(pipeline,workspace,wrapper,choices,options),previewText=JSON.stringify(preview);
  const applied=await applyRepositoryOperations({pipeline,workspace,wrapper,choices,options,previewText,approval:{decision:'approve',previewDigest:preview.digest}});
  const observed=await inspectRepositoryReconciliation(wrapper,previewText,preview.digest);
  await finalizeRepositoryOperations({wrapper,previewText,previewDigest:preview.digest,approval:{decision:'approve',reconciliationDigest:observed.digest}});
  return {base,wrapper,id:path.basename(applied.journal)};
}
const scan=wrapper=>scanRepositoryRetention(wrapper,{policy,now:Date.now()+1000});
async function apply(f,p,options) {const lock=await acquireWorkspaceLock(f.wrapper);try{return await applyRepositoryRetention(lock,p,{decision:'approve',previewDigest:p.digest},options);}finally{await lock.release();}}

test('repository retention removes exact completed group, without inspecting later game changes',async()=>{
  const f=await fixture();await writeFile(path.join(f.wrapper,'project/game.txt'),'later user work');
  const p=await scan(f.wrapper);assert.equal(p.complete,true,JSON.stringify(p.diagnostics));assert.equal(p.retention.selected.length,1);
  const result=await apply(f,p);assert.equal(result.status,'completed',JSON.stringify(result));assert.equal(result.removedGroups,1);
  assert.equal(await readFile(path.join(f.wrapper,'project/game.txt'),'utf8'),'later user work');
  assert.equal(JSON.parse(await readFile(result.receiptPath,'utf8')).status,'completed');
  assert.deepEqual(await readdir(path.join(f.wrapper,'.pipeline/repository-journals')),[]);
});
test('repository retention protects references in metadata, escaped JSON and sibling resolution history',async()=>{
  for(const type of ['metadata','escaped','resolution','ancestor','bootstrap','lock-recovery']) {
    const f=await fixture();let target=path.join(f.wrapper,'.pipeline/retained.json'),value={subject:f.id};
    if(type==='resolution'){target=path.join(f.base,'.wpc-repository-resolution-11111111-1111-1111-1111-111111111111/request.json');await mkdir(path.dirname(target));value={wrapper:f.wrapper,before:{journal:f.id}};}
    if(type==='ancestor'){target=path.join(f.base,'.wpc-ancestors-11111111-1111-1111-1111-111111111111/request.json');await mkdir(path.dirname(target));value={wrapper:f.wrapper,subject:f.id};}
    if(type==='bootstrap'){target=path.join(f.base,'.wpc-bootstrap-recovery-'+'a'.repeat(64),'request.json');await mkdir(path.dirname(target));await writeFile(path.join(path.dirname(target),'owner.json'),JSON.stringify({wrapper:f.wrapper}));}
    if(type==='lock-recovery'){target=path.join(f.wrapper,'.pipeline/repository-lock-recoveries','a'.repeat(64),'request.json');await mkdir(path.dirname(target),{recursive:true});}
    await writeFile(target,type==='escaped'?JSON.stringify(value).replace(f.id[0],'\\u'+f.id.charCodeAt(0).toString(16).padStart(4,'0')):JSON.stringify(value));
    const p=await scan(f.wrapper);assert.equal(p.retention.selected.length,0);assert.ok(p.groups[0].protectionReasons.includes('retained-reference'));
    assert.ok(p.retention.totals.remainingOverCount>0);
  }
});
test('repository retention protects corrupt, incomplete and foreign groups and never follows links',async()=>{
  for(const kind of ['corrupt','foreign','link']) {
    const f=await fixture();let target=path.join(f.wrapper,'.pipeline/repository-inputs',f.id+'.json');
    if(kind==='corrupt')await writeFile(target,'{');
    if(kind==='foreign')await writeFile(path.join(f.wrapper,'.pipeline/repository-evidence',f.id,'extra.json'),'{}');
    if(kind==='link'){const outside=path.join(f.base,'outside');await mkdir(outside);await symlink(outside,path.join(f.wrapper,'.pipeline/foreign'),process.platform==='win32'?'junction':'dir');}
    const p=await scan(f.wrapper);assert.equal(p.complete,false);assert.equal(p.retention.selected.length,0);
  }
});
test('repository retention rejects inventory drift and stops partial cleanup with exact receipt',async()=>{
  const f=await fixture(),p=await scan(f.wrapper);await writeFile(path.join(f.wrapper,'.pipeline/new.json'),'{}');
  await assert.rejects(apply(f,p),e=>e.code==='repository-retention.drift');
  const fresh=await scan(f.wrapper);let once=false;
  const result=await apply(f,fresh,{boundary:async phase=>{if(phase==='file-removed'&&!once){once=true;throw new Error('injected');}}});
  assert.equal(result.status,'failed');assert.equal(result.removedFiles,1);assert.equal(result.removedGroups,0);
  const receipt=JSON.parse(await readFile(result.receiptPath,'utf8'));assert.ok(receipt.currentFile);assert.equal(receipt.status,'failed');
  assert.equal((await scan(f.wrapper)).retention.selected.length,0);
});
test('repository retention checks age/count OR, deletion cap and current-run protection',async()=>{
  const f=await fixture(),now=Date.now()+1000;
  const age=await scanRepositoryRetention(f.wrapper,{policy:{maxAgeDays:0,maxJournals:10,maxDeletesPerRun:1},now});
  assert.deepEqual(age.retention.selected[0].reasons,['age']);
  const count=await scanRepositoryRetention(f.wrapper,{policy:{maxAgeDays:100,maxJournals:0,maxDeletesPerRun:1},now});
  assert.deepEqual(count.retention.selected[0].reasons,['count']);
  assert.equal((await scanRepositoryRetention(f.wrapper,{policy:{...policy,maxDeletesPerRun:0},now})).retention.selected.length,0);
  assert.equal((await scanRepositoryRetention(f.wrapper,{policy,now,currentRuns:[f.id]})).retention.selected.length,0);
  await assert.rejects(scanRepositoryRetention(f.wrapper,{policy:{...policy,maxAgeDays:-1},now}));
});
test('repository retention protects hash-only references and rejects malformed state',async()=>{
  const f=await fixture(),p=await scan(f.wrapper);
  await writeFile(path.join(f.wrapper,'.pipeline/reference.json'),JSON.stringify({subject:p.groups[0].files[0].hash}));
  const referenced=await scan(f.wrapper);assert.equal(referenced.retention.selected.length,0);
  assert.ok(referenced.groups[0].protectionReasons.includes('retained-reference'));
  await writeFile(path.join(f.wrapper,'.pipeline/state.json'),'{}');assert.equal((await scan(f.wrapper)).complete,false);
});
test('repository cleanup process death retains exact uncertain file and abandoned lock',async()=>{
  const f=await fixture(),p=await scan(f.wrapper),preview=path.join(f.base,'cleanup-preview.json');await writeFile(preview,JSON.stringify(p));
  const script=`import {readFile} from 'node:fs/promises';
    import {acquireWorkspaceLock} from ${JSON.stringify(new URL('../src/operations/lock.js',import.meta.url).href)};
    import {applyRepositoryRetention} from ${JSON.stringify(new URL('../src/operations/repository-retention-apply.js',import.meta.url).href)};
    const p=JSON.parse(await readFile(process.argv[1],'utf8')),lock=await acquireWorkspaceLock(p.workspace);
    await applyRepositoryRetention(lock,p,{decision:'approve',previewDigest:p.digest},{boundary:async phase=>{if(phase==='file-removed')process.exit(42);}});`;
  await assert.rejects(promisify(execFile)(process.execPath,['--input-type=module','-e',script,preview]),e=>e.code===42);
  const receipts=await readdir(path.join(f.wrapper,'.pipeline/repository-cleanup'));assert.equal(receipts.length,1);
  const r=JSON.parse(await readFile(path.join(f.wrapper,'.pipeline/repository-cleanup',receipts[0]),'utf8'));
  assert.equal(r.status,'in-progress');assert.ok(r.currentFile);assert.equal(r.removedFiles.length,0);
  await assert.rejects(readFile(r.currentFile),e=>e.code==='ENOENT');
  assert.equal((await scan(f.wrapper)).retention.selected.length,0);
  await assert.rejects(acquireWorkspaceLock(f.wrapper),e=>e.code==='lock.busy');
});
test('repository retention protects completed groups while bootstrap recovery is pending',async()=>{
  const f=await fixture(),gate=bootstrapLockDirectory(f.wrapper)+'.recovery';await mkdir(gate);await writeFile(path.join(gate,'owner.json'),'{}');
  const p=await scan(f.wrapper);assert.equal(p.complete,false);assert.equal(p.retention.selected.length,0);
  assert.ok(p.diagnostics.some(d=>d.code==='repository-retention.recovery-pending'));
});
test('public repository cleanup requires explicit domain on preview and apply',async()=>{
  const f=await fixture();const invoke=async args=>{let out='',err='';const code=await runCli(args,{stdout:s=>{out+=s;},stderr:s=>{err+=s;}});return {code,out,err};};
  const p=await invoke(['logs','clean','--repositories','--workspace',f.wrapper,'--max-age-days','0','--keep-last','0','--max-delete','1']);
  assert.equal(p.code,0,p.err);const preview=JSON.parse(p.out);assert.equal(preview.kind,'repository-retention-preview');
  const saved=path.join(f.base,'repository-cleanup.json');await writeFile(saved,p.out);
  const wrong=await invoke(['logs','clean','--workspace',f.wrapper,'--apply','--preview',saved]);
  assert.equal(wrong.code,2);assert.match(wrong.err,/retention-apply.approval/);
  assert.throws(()=>parseCommand(['logs','list','--repositories','--workspace',f.wrapper]));
  assert.throws(()=>parseCommand(['logs','clean','--repositories','--workspace',f.wrapper,'--max-age-days','0','--keep-last','0','--max-delete','1','--receipt-max-age-days','0']));
  const applied=await invoke(['logs','clean','--repositories','--workspace',f.wrapper,'--apply','--preview',saved]);
  assert.equal(applied.code,0,applied.err);assert.equal(JSON.parse(applied.out).removedGroups,1);
  assert.match(applied.err,/cleanup-location/);
});

test('public CLI cleanup process death after exact unlink preserves uncertain receipt and other files',async()=>{
  const f=await fixture(),cli=fileURLToPath(new URL('../src/cli.js',import.meta.url));
  const sentinel=path.join(f.wrapper,'project/user.txt');await writeFile(sentinel,'user-owned data');
  const result=await promisify(execFile)(process.execPath,[cli,'logs','clean','--repositories','--workspace',f.wrapper,
    '--max-age-days','0','--keep-last','0','--max-delete','1']);
  const p=JSON.parse(result.stdout);assert.equal(p.retention.selected.length,1);
  const group=p.groups.find(g=>g.id===p.retention.selected[0].id),target=group.files[0].path;
  const before=new Map(await Promise.all(group.files.map(async f=>[f.path,await readFile(f.path)])));
  const saved=path.join(f.base,'public-cleanup.json'),shim=path.join(f.base,'unlink-crash.mjs');
  await writeFile(saved,result.stdout);
  await writeFile(shim,`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
    const original=fs.promises.unlink;fs.promises.unlink=async function(filename){
      const result=await original.call(this,filename);if(filename===${JSON.stringify(target)})process.exit(42);return result;};
    syncBuiltinESMExports();process.once('beforeExit',()=>process.exit(43));`);
  await assert.rejects(promisify(execFile)(process.execPath,['--import',pathToFileURL(shim).href,cli,'logs','clean','--repositories',
    '--workspace',f.wrapper,'--apply','--preview',saved]),e=>e.code===42);
  const directory=path.join(f.wrapper,'.pipeline/repository-cleanup'),receipts=await readdir(directory);assert.equal(receipts.length,1);
  const receipt=JSON.parse(await readFile(path.join(directory,receipts[0]),'utf8'));
  assert.equal(receipt.status,'in-progress');assert.equal(receipt.currentFile,target);assert.deepEqual(receipt.removedFiles,[]);
  await assert.rejects(readFile(target),e=>e.code==='ENOENT');
  for(const [filename,bytes] of before)if(filename!==target)assert.deepEqual(await readFile(filename),bytes);
  assert.equal(await readFile(sentinel,'utf8'),'user-owned data');
  assert.equal((await scan(f.wrapper)).retention.selected.length,0);
  await assert.rejects(acquireWorkspaceLock(f.wrapper),e=>e.code==='lock.busy');
});
