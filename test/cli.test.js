import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,mkdir,readdir,writeFile,readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseCommand,runCli} from '../src/commands/dispatch.js';

const entry=fileURLToPath(new URL('../src/cli.js',import.meta.url));
const invoke=args=>spawnSync(process.execPath,[entry,...args,...(args.includes('--json')?[]:['--json'])],{encoding:'utf8',windowsHide:true,timeout:30000});
test('CLI bootstrap retirement admits only preview or explicit apply without selector overrides',()=>{
  const base=['repositories','retire-bootstrap','--workspace',path.resolve('synthetic')];
  assert.equal(parseCommand(base).action,'retire-bootstrap');
  for(const tail of [['--apply'],['--initial','sha256:'+'a'.repeat(64)],
    ['--journal','11111111-1111-1111-1111-111111111111'],['--network']])assert.throws(()=>parseCommand([...base,...tail]));
});
test('CLI bootstrap continuation restricts initial digest and explicit apply flags',()=>{
  const base=['repositories','continue-bootstrap','--workspace',path.resolve('synthetic')];
  assert.equal(parseCommand(base).action,'continue-bootstrap');
  assert.equal(parseCommand([...base,'--initial','sha256:'+'a'.repeat(64)]).initialDigest,'sha256:'+'a'.repeat(64));
  for(const tail of [['--initial','wrong'],['--apply'],['--journal','11111111-1111-1111-1111-111111111111']])
    assert.throws(()=>parseCommand([...base,...tail]));
  assert.throws(()=>parseCommand(['repositories','status','--workspace',path.resolve('synthetic'),'--initial','sha256:'+'a'.repeat(64)]));
});
test('CLI lock recovery requires explicit journal and paired preview apply',()=>{
  const root=path.resolve('synthetic-root'),id='11111111-1111-1111-1111-111111111111';
  const base=['repositories','recover-locks','--workspace',root];
  assert.throws(()=>parseCommand(base));
  for(const tail of [['--journal','../secret'],['--journal',id,'--apply'],
    ['--journal',id,'--preview',path.resolve('p.json')],['--journal',id,'--journal',id],['--journal',id,'--network']])
    assert.throws(()=>parseCommand([...base,...tail]));
  assert.equal(parseCommand([...base,'--journal',id]).journalId,id);
  assert.equal(parseCommand([...base,'--journal',id,'--apply','--preview',path.resolve('p.json')]).apply,true);
  assert.throws(()=>parseCommand(['repositories','finalize','--workspace',root,'--journal',id]));
});
test('CLI help lists built-in providers without claiming runtime certification',()=>{
  const result=invoke(['--help']);assert.equal(result.status,0);
  assert.match(result.stdout,/Doctor is read-only/);assert.match(result.stdout,/Built-in workspace adapters: Codex, Claude, Kimi and Grok/);assert.match(result.stdout,/setup is not runtime certification/);
});
test('CLI parser rejects duplicate, unknown and unsafe arguments without echoing them',async()=>{
  for(const args of [['doctor'],['doctor','--workspace'],['doctor','--workspace','relative'],
    ['doctor','--workspace',path.resolve('x'),'--workspace',path.resolve('y')],
    ['doctor','--workspace',path.resolve('x'),'--apply'],
    ['doctor','--workspace',path.resolve('x'),'--recovery','../secret'],['setup','--token','secret']]) {
    let out='',err='';const code=await runCli(args,{stdout:s=>{out+=s;},stderr:s=>{err+=s;}});
    assert.equal(code,2);assert.equal(out,'');assert.ok(!err.includes('secret'));
  }
  assert.equal(parseCommand(['doctor','--workspace',path.resolve('x'),'--json']).command,'doctor');
});
test('CLI doctor missing installation returns JSON and creates nothing',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wpc-cli-'));
  const result=invoke(['doctor','--workspace',root,'--json']);
  assert.equal(result.status,1);const data=JSON.parse(result.stdout);
  assert.equal(data.status,'not-installed');assert.equal(data.runtime,'not-run');
  assert.deepEqual(await readdir(root),[]);
});
test('CLI doctor reports orphan with missing state without deleting evidence',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wpc-cli-'));
  const dir=path.join(root,'.pipeline/journals/11111111-1111-1111-1111-111111111111');
  await mkdir(dir,{recursive:true});await writeFile(path.join(dir,'000000.json'),'{');
  const result=invoke(['doctor','--workspace',root]);assert.equal(result.status,1);
  assert.ok(JSON.parse(result.stdout).diagnostics.some(d=>d.code==='history.orphan'));
  assert.equal(await readFile(path.join(dir,'000000.json'),'utf8'),'{');
});
test('CLI output transport failure is a safe nonzero result',async()=>{
  let error='';assert.equal(await runCli(['--help'],{stdout(){throw Error('secret');},stderr:s=>{error=s;}}),2);
  assert.deepEqual(JSON.parse(error),{error:'cli.io'});
});

test('CLI lifecycle parsing separates acquisition and exact apply without code-loading flags',()=>{
  const root=path.resolve('workspace'),file=path.resolve('private-preview.json');
  for(const verb of ['setup','update']) {
    assert.deepEqual(parseCommand([verb,'--workspace',root,'--network']),{command:verb,workspace:root,network:true});
    assert.deepEqual(parseCommand([verb,'--workspace',root,'--apply','--preview',file]),
      {command:verb,workspace:root,apply:true,previewFile:file});
    for(const extra of [['--apply'],['--preview',file],['--apply','--preview',file,'--network'],
      ['--apply','--preview',file,'--manifest',file],['--network','--network'],['--adapter',file],
      ['--registry',file],['--manifest','relative'],['--apply','--preview',file,'--preview',file]])
      assert.throws(()=>parseCommand([verb,'--workspace',root,...extra]),e=>!!e.code);
  }
});

test('CLI entrypoint refuses missing lifecycle prerequisites without workspace writes',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wpc-no-adapters-'));
  for(const verb of ['setup','update','repair','remove'])for(const suffix of [[],['--apply','--preview',path.join(root,'absent.json')]]) {
    const result=invoke([verb,'--workspace',root,...suffix]);
    assert.equal(result.status,2);assert.equal(result.stdout,'');
    assert.equal(typeof JSON.parse(result.stderr).error,'string');
    assert.notEqual(JSON.parse(result.stderr).error,'cli.providers-unavailable');
    assert.deepEqual(await readdir(root),[]);
  }
});

test('CLI maintenance parser rejects source overrides and apply-time provider changes',()=>{
  const root=path.resolve('workspace'),file=path.resolve('preview.json');
  assert.deepEqual(parseCommand(['remove','--workspace',root,'--providers','codex,claude']).providers,['claude','codex']);
  for(const verb of ['repair','remove'])for(const suffix of [['--network'],['--manifest',file],
    ['--apply'],['--apply','--preview',file,'--providers','codex'],['--providers','codex,codex'],['--providers','unknown']])
    assert.throws(()=>parseCommand([verb,'--workspace',root,...suffix]),e=>!!e.code);
  assert.throws(()=>parseCommand(['repair','--workspace',root,'--providers','codex']),e=>!!e.code);
});

test('CLI switch requires incoming manifest only for preview and refuses provider overrides',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wpc-switch-cli-')),file=path.join(root,'absent.json');
  assert.throws(()=>parseCommand(['switch','--workspace',root]),e=>e.code==='switch.manifest-required');
  for(const suffix of [['--manifest',file,'--providers','codex'],['--apply','--preview',file,'--manifest',file],
    ['--apply','--preview',file,'--network']])assert.throws(()=>parseCommand(['switch','--workspace',root,...suffix]),e=>!!e.code);
  for(const suffix of [['--manifest',file],['--apply','--preview',file]]) {
    const result=invoke(['switch','--workspace',root,...suffix]);assert.equal(result.status,2);
    assert.equal(typeof JSON.parse(result.stderr).error,'string');assert.notEqual(JSON.parse(result.stderr).error,'cli.providers-unavailable');assert.deepEqual(await readdir(root),[]);
  }
});

test('CLI continue requires exact recovery or saved preview without source overrides',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wpc-continue-cli-')),file=path.join(root,'absent.json');
  const recovery='.pipeline/transactions/00000000-0000-0000-0000-000000000000/recovery.json';
  assert.equal(parseCommand(['continue','--workspace',root,'--recovery',recovery]).recoveryPath,recovery);
  for(const suffix of [[],['--network'],['--manifest',file],['--recovery','../escape'],['--recovery',recovery+'\n'],
    ['--apply','--preview',file,'--recovery',recovery]])assert.throws(()=>parseCommand(['continue','--workspace',root,...suffix]),e=>!!e.code);
  for(const suffix of [['--recovery',recovery],['--apply','--preview',file]]) {
    const result=invoke(['continue','--workspace',root,...suffix]);assert.equal(result.status,2);
    assert.equal(typeof JSON.parse(result.stderr).error,'string');assert.notEqual(JSON.parse(result.stderr).error,'cli.providers-unavailable');assert.deepEqual(await readdir(root),[]);
  }
});

test('CLI logs list and clean preview are read-only and require explicit limits',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wpc-cli-'));
  const listed=invoke(['logs','list','--workspace',root]);assert.equal(listed.status,0);
  assert.equal(JSON.parse(listed.stdout).selectionDisabled,true);
  const preview=invoke(['logs','clean','--workspace',root,'--max-age-days','30','--keep-last','20','--max-delete','5']);
  assert.equal(preview.status,0);assert.deepEqual(JSON.parse(preview.stdout).retention.policy,{maxAgeDays:30,maxJournals:20,maxDeletesPerRun:5});
  assert.deepEqual(await readdir(root),[]);
  for(const suffix of [[],['--apply'],['--max-age-days','-1','--keep-last','20','--max-delete','5'],
    ['--apply','--preview',path.join(root,'preview.json'),'--keep-last','2']]) {
    assert.throws(()=>parseCommand(['logs','clean','--workspace',root,...suffix]),e=>!!e.code);
  }
  assert.throws(()=>parseCommand(['logs','list','--workspace',root,'--apply']),e=>e.code==='cli.arguments');
});

test('CLI logs no-work apply binds saved preview without creating a receipt',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wpc-cli-')),holder=await mkdtemp(path.join(tmpdir(),'wpc-cli-preview-'));
  const initial=invoke(['logs','clean','--workspace',root,'--max-age-days','30','--keep-last','20','--max-delete','5']);
  const filename=path.join(holder,'preview.json');await writeFile(filename,initial.stdout);
  const result=invoke(['logs','clean','--workspace',root,'--apply','--preview',filename]);
  assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(result.stdout);assert.equal(report.status,'completed');assert.equal(report.removedGroups,0);
  assert.equal(report.receiptCreated,false);assert.equal(report.receiptPath,null);
  assert.ok(result.stderr.includes('cleanup-result'));assert.deepEqual(await readdir(root),['.pipeline']);
  assert.deepEqual(await readdir(path.join(root,'.pipeline')),[]);
  const bad=JSON.parse(initial.stdout);bad.digest='wrong';await writeFile(filename,JSON.stringify(bad));
  const rejected=invoke(['logs','clean','--workspace',root,'--apply','--preview',filename]);
  assert.equal(rejected.status,2);assert.match(rejected.stderr,/retention-apply.approval/);
});
