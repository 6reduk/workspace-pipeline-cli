import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile,readFile,stat,readdir} from 'node:fs/promises';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';

export async function verifyPackedDesired({root,cli,report}) {
  const repo=path.join(root,'desired-source'),workspace=path.join(root,'desired-workspace');
  await mkdir(repo);await mkdir(workspace);
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^GIT_/i.test(k)));
  Object.assign(env,{GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'});
  const git=args=>execFileSync('git',['-C',repo,'-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],
    {env,encoding:'utf8',windowsHide:true,timeout:30000}).trim();
  git(['init','--initial-branch=main','--template=']);
  git(['config','user.name','Fixture']);git(['config','user.email','fixture@example.invalid']);
  const manifest={schemaVersion:2,id:'packed-desired',version:'1.0.0',
    files:[{source:'core',target:'.sdx',kind:'directory'}],
    adapters:{codex:{providers:['codex'],files:[{source:'entry.md',target:'AGENTS.md',kind:'file'}],settings:[]}}};
  await mkdir(path.join(repo,'core'));
  await writeFile(path.join(repo,'core/rules.md'),'canonical rules');
  await writeFile(path.join(repo,'entry.md'),'entry');
  await writeFile(path.join(repo,'pipeline.json'),JSON.stringify(manifest));
  git(['add','--all']);git(['commit','-m','fixture']);const commit=git(['rev-parse','HEAD']);
  const descriptor={schemaVersion:2,pipeline:{type:'git',transport:'local',path:'../desired-source',ref:'main',subdirectory:'.'},adapters:['codex'],
    layout:{kind:'single-repo',repositories:{game:{path:'project',role:'code'}},documentation:{repository:'game',path:'docs'}}};
  const run=(verb,flags=[])=>JSON.parse(execFileSync(process.execPath,[cli,verb,'--workspace',workspace,...flags,'--json'],
    {encoding:'utf8',windowsHide:true,timeout:60000,stdio:['ignore','pipe','pipe']}));
  const setup=['--source',repo,'--ref','main','--adapters','codex'];
  assert.equal(run('setup',[...setup,'--preview']).descriptor.action,'create');
  await assert.rejects(stat(path.join(workspace,'workspace.json')),{code:'ENOENT'});
  assert.equal(run('setup',[...setup,'--yes']).status,'applied');
  assert.deepEqual(JSON.parse(await readFile(path.join(workspace,'workspace.json'),'utf8')),descriptor);
  assert.equal(run('doctor').binding.commit,commit);
  assert.equal(run('update',['--yes']).status,'unchanged');
  await writeFile(path.join(workspace,'.sdx/custom.md'),'local customization');
  const preview=run('update',['--preview']);
  assert.equal(preview.applied,false);assert(preview.files.extra.some(e=>e.path==='.sdx/custom.md'));
  assert.equal(await readFile(path.join(workspace,'.sdx/custom.md'),'utf8'),'local customization');
  const updated=run('update',['--yes']);assert.equal(updated.status,'applied');assert.equal(updated.backupDirectory,null);
  await assert.rejects(stat(path.join(workspace,'.sdx/custom.md')),{code:'ENOENT'});
  const final=run('doctor');assert.equal(final.ready,true);assert.equal(final.binding.commit,commit);
  report.checks.push({name:'packed-desired-setup-update-preview-doctor-and-binding',commit,realProfilesTouched:false});
  await writeFile(path.join(repo,'entry.md'),'new release');git(['add','--all']);git(['commit','-m','next release']);
  const latest=git(['rev-parse','HEAD']);assert.notEqual(latest,commit);
  await writeFile(path.join(workspace,'AGENTS.md'),'customized entry');
  const reset=run('reset',['--yes']);assert.equal(reset.reset.commit,commit);
  assert.equal(await readFile(path.join(workspace,'AGENTS.md'),'utf8'),'entry');
  assert.equal(run('update',['--yes']).provenance.commit,latest);
  assert.equal(await readFile(path.join(workspace,'AGENTS.md'),'utf8'),'new release');
  report.checks.push({name:'packed-desired-reset-recorded-commit-before-update',commit,latest,realProfilesTouched:false});
  await writeFile(path.join(workspace,'.sdx/custom-remove.md'),'remove customization');
  const removal=run('remove',['--preview']);assert.equal(removal.applied,false);
  assert(removal.files.extra.some(e=>e.path==='.sdx/custom-remove.md'));
  assert.equal(run('remove',['--yes']).status,'removed');
  await assert.rejects(stat(path.join(workspace,'.sdx')),{code:'ENOENT'});
  await assert.rejects(stat(path.join(workspace,'AGENTS.md')),{code:'ENOENT'});
  assert.deepEqual(JSON.parse(await readFile(path.join(workspace,'workspace.json'),'utf8')),descriptor);
  assert.equal(run('remove',['--yes']).status,'removed');
  assert.equal(run('update',['--yes']).status,'applied');
  assert.equal(run('doctor').ready,true);
  report.checks.push({name:'packed-desired-remove-and-reinstall',realProfilesTouched:false});
  const record=await readFile(path.join(workspace,'.pipeline/desired-install.json'));
  const script=`import {acquireWorkspaceLock} from ${JSON.stringify(pathToFileURL(path.join(path.dirname(cli),'operations/lock.js')).href)};
    await acquireWorkspaceLock(process.argv[1],{purpose:'desired-state'});process.send('ready');setInterval(()=>{},1000);`;
  const child=spawn(process.execPath,['--input-type=module','-e',script,workspace],{windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
  const exited=once(child,'exit');let stderr='';child.stderr.on('data',b=>{stderr+=b;});
  try {
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('packed lock child timeout: '+stderr)),30000);
      child.once('message',m=>{clearTimeout(timer);m==='ready'?resolve():reject(Error('unexpected child message'));});
      child.once('exit',()=>{clearTimeout(timer);reject(Error('packed lock child exited: '+stderr));});
      child.once('error',e=>{clearTimeout(timer);reject(e);});
    });
  }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;}
  assert.equal(run('recover-lock',['--preview']).status,'stopped-owner-observed');
  const recovered=run('recover-lock',['--yes']);assert.equal(recovered.status,'lock-retired');
  assert.equal(recovered.archive,undefined);
  await assert.rejects(stat(path.join(workspace,'.pipeline/lock')),{code:'ENOENT'});
  assert.equal((await readdir(path.join(workspace,'.pipeline'))).some(n=>n==='recovered-locks'||n.includes('-retiring-')),false);
  assert.deepEqual(await readFile(path.join(workspace,'.pipeline/desired-install.json')),record);
  assert.equal(run('doctor').ready,true);
  report.checks.push({name:'packed-desired-killed-lock-owner-recovery',realProfilesTouched:false});
}
