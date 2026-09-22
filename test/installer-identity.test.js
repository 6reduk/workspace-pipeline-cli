import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {readInstallerIdentity,bindMigrationInstaller,verifyMigrationInstaller} from '../src/operations/installer-identity.js';
import {contractDigest} from '../src/contracts/semantic.js';
test('installer binding is location independent and rejects changed code/schema/inventory',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'wpc-installer-identity-'));
 for(const d of ['src','schemas','docs'])await mkdir(path.join(root,d));
 await writeFile(path.join(root,'package.json'),JSON.stringify({name:'fixture',version:'1.0.0'}));
 await writeFile(path.join(root,'src/cli.js'),'// code');await writeFile(path.join(root,'schemas/a.json'),'{}');
 const record=await bindMigrationInstaller({kind:'fixture-preview'},root);
 assert.equal((await verifyMigrationInstaller(record,root)).kind,'fixture-preview');
 const copy=await mkdtemp(path.join(tmpdir(),'wpc-installer-copy-'));await cp(root,copy,{recursive:true});
 assert.equal((await readInstallerIdentity(copy)).digest,record.installer.digest);
 await writeFile(path.join(copy,'docs/info.md'),'non-executable docs');await verifyMigrationInstaller(record,copy);
 for(const [file,original] of [['src/cli.js','// code'],['schemas/a.json','{}']]){
  await writeFile(path.join(copy,file),original+' ');
  await assert.rejects(()=>verifyMigrationInstaller(record,copy),e=>e.code==='installer.changed');
  await writeFile(path.join(copy,file),original);
 }
 await writeFile(path.join(copy,'src/extra.js'),'// new');
 await assert.rejects(()=>verifyMigrationInstaller(record,copy),e=>e.code==='installer.changed');
 const forged=structuredClone(record);forged.installer.version='different';const {digest,...body}=forged;forged.digest=contractDigest(body);
 await assert.rejects(()=>verifyMigrationInstaller(forged,root),e=>e.code==='installer.changed');
});
