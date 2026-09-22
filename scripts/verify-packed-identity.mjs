import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readInstallerIdentity,bindMigrationInstaller} from '../src/operations/installer-identity.js';
import {sha256} from '../src/source/inventory.js';
const repo=fileURLToPath(new URL('../',import.meta.url)),npm=process.env.npm_execpath;
assert.ok(npm&&path.isAbsolute(npm),'Run through npm run test:packed:identity');
const root=await mkdtemp(path.join(tmpdir(),'wpc-packed-identity-'));
const report={root,status:'running',network:'offline',publication:false};
const runNpm=args=>execFileSync(process.execPath,[npm,...args],{cwd:repo,encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:4*1024*1024,
 env:{...process.env,npm_config_offline:'true',npm_config_ignore_scripts:'true',npm_config_audit:'false',npm_config_fund:'false'}});
try{
 const [pack]=JSON.parse(runNpm(['pack','--offline','--ignore-scripts','--json','--pack-destination',root]));
 const tarball=path.join(root,pack.filename),prefix=path.join(root,'consumer');await mkdir(prefix);
 runNpm(['install','--prefix',prefix,'--offline','--ignore-scripts','--no-audit','--no-fund',tarball]);
 const installed=path.join(prefix,'node_modules','@6reduk','workspace-pipeline');
 const reader=await import(pathToFileURL(path.join(installed,'src/operations/installer-identity.js')).href);
 const before=await readInstallerIdentity(),after=await reader.readInstallerIdentity();
 assert.equal(after.digest,before.digest);
 const preview=await bindMigrationInstaller({kind:'identity-fixture'});
 assert.equal((await reader.verifyMigrationInstaller(preview)).kind,'identity-fixture');
 execFileSync(process.execPath,['--test','--test-name-pattern=public CLI preview/apply','test/legacy-unity-preflight.test.js'],{
  cwd:repo,encoding:'utf8',windowsHide:true,timeout:180000,maxBuffer:4*1024*1024,
  env:{...process.env,WPC_TEST_MIGRATION_CLI:path.join(installed,'src/cli.js')}});
 report.packedMigration='passed';
 await writeFile(path.join(installed,'src/identity-tamper.js'),'// fixture tamper');
 await assert.rejects(()=>reader.verifyMigrationInstaller(preview),e=>e.code==='installer.changed');
 report.status='passed';report.identity=before.digest;report.files=before.files.length;
 report.tarball={path:tarball,sha256:sha256(await readFile(tarball)),integrity:pack.integrity};
}catch(e){report.status='failed';report.error={code:e.code??null,message:String(e.message).slice(0,400)};process.exitCode=1;}
await writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,reportPath:path.join(root,'report.json')},null,2));
