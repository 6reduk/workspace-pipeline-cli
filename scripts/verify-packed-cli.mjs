import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,readdir,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {verifyPackedRepositories} from './verify-packed-repositories.mjs';

// Explicit opt-in via npm run test:packed. Offline install into a unique temp
// prefix; scripts/audit/funding disabled, no harness, global install or cleanup.
const repo=fileURLToPath(new URL('../',import.meta.url)),npm=process.env.npm_execpath;
assert.ok(npm&&path.isAbsolute(npm),'Run through npm run test:packed');
const root=await mkdtemp(path.join(tmpdir(),'wpc-packed-'));
const report={root,status:'running',checks:[],network:'offline',publication:false};
const hash=b=>createHash('sha256').update(b).digest('hex');
const runNpm=args=>execFileSync(process.execPath,[npm,...args],{
  cwd:repo,encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:4*1024*1024,
  env:{...process.env,npm_config_offline:'true',npm_config_ignore_scripts:'true',npm_config_audit:'false',npm_config_fund:'false'}
});
try {
  const [packed]=JSON.parse(runNpm(['pack','--offline','--ignore-scripts','--json','--pack-destination',root]));
  const tarball=path.join(root,packed.filename),prefix=path.join(root,'consumer');await mkdir(prefix);
  runNpm(['install','--prefix',prefix,'--offline','--ignore-scripts','--no-audit','--no-fund',tarball]);
  const installed=path.join(prefix,'node_modules','@6reduk','workspace-pipeline');
  for(const item of packed.files) {
    assert.ok(!path.isAbsolute(item.path)&&!item.path.split(/[\\/]/).includes('..'));
    assert.equal(hash(await readFile(path.join(installed,item.path))),hash(await readFile(path.join(repo,item.path))),item.path);
  }
  report.checks.push({name:'packed-files-match-source',files:packed.files.length});
  report.tarball={path:tarball,sha256:hash(await readFile(tarball)),integrity:packed.integrity};
  const metadata=JSON.parse(await readFile(path.join(installed,'package.json'),'utf8'));
  assert.equal(metadata.bin['workspace-pipeline'],'src/cli.js');
  await lstat(path.join(prefix,'node_modules','.bin',process.platform==='win32'?'workspace-pipeline.cmd':'workspace-pipeline'));
  const cli=path.join(installed,metadata.bin['workspace-pipeline']);
  const run=(args,expected=0)=>{
    let out,code=0;
    try{out=execFileSync(process.execPath,[cli,...args],{cwd:prefix,encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:4*1024*1024,stdio:['ignore','pipe','pipe']});}
    catch(e){code=e.status;out=e.stdout;}
    assert.equal(code,expected,'packaged CLI exit for '+args.slice(0,3).join(' '));return out;
  };
  assert.match(run(['--help']),/Workspace Pipeline CLI/);
  report.checks.push({name:'installed-bin-metadata-and-node-entrypoint'});
  const a=path.join(root,'a'),b=path.join(root,'b');await mkdir(a);await mkdir(b);
  assert.equal(JSON.parse(run(['doctor','--workspace',a],1)).status,'not-installed');
    for(const verb of ['setup','update','repair','remove'])run([verb,'--workspace',a],2);
    run(['switch','--workspace',a,'--manifest',path.join(root,'absent-manifest.json')],2);
    run(['switch','--workspace',a,'--apply','--preview',path.join(root,'absent-preview.json')],2);
    run(['continue','--workspace',a,'--recovery','.pipeline/transactions/00000000-0000-0000-0000-000000000000/recovery.json'],2);
    run(['continue','--workspace',a,'--apply','--preview',path.join(root,'absent-preview.json')],2);
  assert.deepEqual(await readdir(a),[]);
  report.checks.push({name:'installed-lifecycle-refuses-missing-prerequisites-without-workspace-writes'});
  assert.equal(JSON.parse(run(['logs','policy','show','--workspace',a])).mode,'disabled');
  assert.deepEqual(await readdir(a),[]);
  const policy=JSON.parse(run(['logs','policy','set','--workspace',a,'--mode','automatic','--max-age-days','30','--keep-last','20',
    '--max-delete','2','--receipt-max-age-days','30','--keep-receipts','20']));
  assert.equal(policy.result.schemaVersion,2);assert.deepEqual(await readdir(a),[]);
  const preview=path.join(root,'policy-preview.json');await writeFile(preview,JSON.stringify(policy));
  const applied=JSON.parse(run(['logs','policy','set','--workspace',a,'--apply','--preview',preview]));
  assert.equal(applied.mode,'automatic');assert.equal(applied.cleanupPerformed,false);
  const cleanup=run(['logs','clean','--workspace',a,'--max-age-days','30','--keep-last','20','--max-delete','2',
    '--receipt-max-age-days','30','--keep-receipts','20']);
  const cleanupPreview=path.join(root,'cleanup-preview.json');await writeFile(cleanupPreview,cleanup);
  const cleaned=JSON.parse(run(['logs','clean','--workspace',a,'--apply','--preview',cleanupPreview]));
  assert.equal(cleaned.removedGroups,0);assert.equal(cleaned.receiptCreated,false);
  const disabled=path.join(root,'disable-preview.json');await writeFile(disabled,run(['logs','policy','disable','--workspace',a]));
  assert.equal(JSON.parse(run(['logs','policy','disable','--workspace',a,'--apply','--preview',disabled])).mode,'disabled');
  assert.deepEqual(JSON.parse(run(['logs','list','--workspace',a])).receipts,[]);
  assert.deepEqual(await readdir(b),[]);
  assert.deepEqual(await readdir(path.join(a,'.pipeline')),['retention.json']);
  report.checks.push({name:'isolated-doctor-policy-v2-preview-apply-disable-and-no-work-cleanup',workspaceBUnchanged:true});
  await verifyPackedRepositories({root,installed,cli,report});
  report.status='passed';
}catch(e){report.status='failed';report.error={name:e.name,code:e.code??null,message:String(e.message).slice(0,500)};process.exitCode=1;}
await writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,reportPath:path.join(root,'report.json')},null,2));
