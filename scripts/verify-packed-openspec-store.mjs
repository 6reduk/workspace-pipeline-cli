// Opt-in real packed-CLI/OpenSpec lifecycle. Only newly created temp repositories.
// May fetch the pinned OpenSpec dependency; never runs a harness or changes globals.
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,rename,readdir,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const repository=fileURLToPath(new URL('../',import.meta.url)),npm=process.env.npm_execpath;
assert.ok(npm&&path.isAbsolute(npm),'Run npm run test:packed:openspec-store');
const root=await mkdtemp(path.join(tmpdir(),'wpc-packed-store-'));
const report={root,status:'running',checks:[],network:'pinned npm dependency allowed',native:'NOT_RUN',publication:false};
const hash=b=>createHash('sha256').update(b).digest('hex');
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^GIT_/i.test(k)));
Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',npm_config_ignore_scripts:'true',npm_config_audit:'false',npm_config_fund:'false'});
async function put(base,relative,bytes){const f=path.join(base,relative);await mkdir(path.dirname(f),{recursive:true});await writeFile(f,bytes);}
function git(cwd,args){execFileSync('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],{cwd,env,windowsHide:true,stdio:'pipe'});}
function runNode(file,args,cwd,extraEnv={},expected=0){
  const r=spawnSync(process.execPath,[file,...args],{cwd,env:{...env,...extraEnv},windowsHide:true,encoding:'utf8',timeout:240000,maxBuffer:8*1024*1024});
  assert.equal(r.status,expected,JSON.stringify({command:args[0],status:r.status,error:r.error?.code,stderr:r.stderr?.slice(-1200)}));
  return JSON.parse(expected===0?r.stdout:r.stdout||r.stderr);
}
try{
  const [pack]=JSON.parse(execFileSync(process.execPath,[npm,'pack','--offline','--ignore-scripts','--json','--pack-destination',root],{cwd:repository,env,encoding:'utf8',windowsHide:true}));
  const tarball=path.join(root,pack.filename),prefix=path.join(root,'consumer');await mkdir(prefix);
  execFileSync(process.execPath,[npm,'install','--prefix',prefix,'--prefer-offline','--ignore-scripts','--no-audit','--no-fund',tarball],{cwd:root,env,stdio:'pipe',windowsHide:true,timeout:120000});
  const installed=path.join(prefix,'node_modules/@6reduk/workspace-pipeline');
  for(const file of pack.files)assert.equal(hash(await readFile(path.join(installed,file.path))),hash(await readFile(path.join(repository,file.path))),file.path);
  report.checks.push('packed bytes match source');
  report.tarball={path:tarball,integrity:pack.integrity};
  const cli=path.join(installed,'src/cli.js'),source=path.join(root,'source');let workspace=path.join(root,'workspace');
  await mkdir(source);await mkdir(workspace);
  const manifest={schemaVersion:2,id:'store-probe',version:'1.0.0',integrations:{openspec:{version:'1.14.1',repository:'docs',store:{id:'probe',implementationRepositories:['a','b']}}},
    adapters:{both:{providers:['codex','claude','grok'],files:[{source:'entry.md',target:'AGENTS.md',kind:'file'}],settings:[]}}};
  await put(source,'pipeline.json',JSON.stringify(manifest));await put(source,'entry.md','Synthetic routing test. Read .pipeline/openspec/README.md. No implementation authorized.\n');
  git(source,['init','--initial-branch=main','--template=']);git(source,['add','pipeline.json','entry.md']);
  git(source,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','synthetic store source']);
  for(const rel of ['sevenpay/docs/analytics','sevenpay/backend/a','sevenpay/backend/b']){await mkdir(path.join(workspace,rel),{recursive:true});git(path.join(workspace,rel),['init','--template=']);}
  const docs='sevenpay/docs/analytics',a='sevenpay/backend/a',b='sevenpay/backend/b';
  const aOriginal=Buffer.from('\ufeff# keep a\r\ncontext: keep\r\n'),bOriginal=Buffer.from('store: probe # borrowed\ncontext: preserve\n');
  await put(workspace,a+'/openspec/config.yaml',aOriginal);await put(workspace,b+'/openspec/config.yaml',bOriginal);
  await put(workspace,docs+'/openspec/config.yaml','schema: spec-driven\n');
  await put(workspace,docs+'/openspec/changes/probe/proposal.md','# Why\n\nSynthetic only.\n\n## What Changes\n\n- No code changes.\n\n## Capabilities\n\n### New Capabilities\n- note: synthetic requirement.\n\n## Impact\n\nOnly fixture.\n');
  await put(workspace,docs+'/openspec/changes/probe/design.md','## Context\nSynthetic routing only.\n');
  await put(workspace,docs+'/openspec/changes/probe/tasks.md','## Work\n- [ ] A: permitted only after user decision.\n- [ ] B: blocked by another change.\n');
  await put(workspace,docs+'/openspec/changes/probe/specs/note/spec.md','## ADDED Requirements\n\n### Requirement: Note\nThe fixture SHALL remain unchanged.\n\n#### Scenario: Read\n- **WHEN** inspected\n- **THEN** no files change\n');
  const protectedNames=[docs+'/openspec/config.yaml',docs+'/openspec/changes/probe/tasks.md',b+'/openspec/config.yaml'];
  const protectedBytes=await Promise.all(protectedNames.map(n=>readFile(path.join(workspace,n))));
  const invoke=(args,expected=0)=>runNode(cli,[...args,'--workspace',workspace,'--json'],prefix,{},expected);
  const setup=['setup','--source',source,'--ref','main','--adapters','both','--repository',`docs=${docs}`,'--repository',`a=${a}`,'--repository',`b=${b}`,'--documentation','docs=docs'];
  const preview=invoke([...setup,'--preview']);assert.equal(preview.status,'preview');
  await assert.rejects(access(path.join(workspace,'.pipeline/openspec/installation.json')),{code:'ENOENT'});
  invoke([...setup,'--yes']);assert.equal(invoke(['doctor']).ready,true);
  report.checks.push('public preview/setup/doctor and owned/borrowed pointers');
  const runtime=()=>path.join(workspace,'.pipeline/openspec/tool/node_modules/@fission-ai/openspec/bin/openspec.js');
  const isolated=()=>({XDG_CONFIG_HOME:path.join(workspace,'.pipeline/openspec/config'),XDG_DATA_HOME:path.join(workspace,'.pipeline/openspec/data'),OPENSPEC_TELEMETRY:'0',OPENSPEC_NO_UPDATE_CHECK:'1'});
  for(const rel of [a,b]){
    const s=runNode(runtime(),['status','--change','probe','--json'],path.join(workspace,rel),isolated());
    assert.equal(s.changeRoot,path.join(workspace,docs,'openspec/changes/probe'));
    assert.deepEqual(s.actionContext.allowedEditRoots,[path.join(workspace,rel),path.join(workspace,docs)]);
    const i=runNode(runtime(),['instructions','apply','--change','probe','--json'],path.join(workspace,rel),isolated());
    assert.equal(i.progress.total,2);assert.equal(i.progress.complete,0);
  }
  report.checks.push('real upstream shared change and per-service actionContext');
  for(const scope of ['.agents','.claude']){
    for(const name of (await readdir(path.join(workspace,scope,'skills'))).filter(n=>n.startsWith('openspec-'))){
      assert.deepEqual(await readFile(path.join(workspace,scope,'skills',name,'SKILL.md')),await readFile(path.join(workspace,'.pipeline/openspec/stage',scope,'skills',name,'SKILL.md')));
    }
  }
  report.checks.push('generated skills unchanged from upstream staging');
  const keyFile=path.join(workspace,a,'openspec/config.yaml');
  const installedConfig=await readFile(keyFile,'utf8');assert.ok(installedConfig.includes('store:'));
  await writeFile(keyFile,installedConfig.replace(/store:.*(?:\r?\n|$)/,'store: modified\r\n'));
  assert.equal(invoke(['doctor'],1).ready,false);
  const updated=invoke(['update','--yes','--backup']);assert.ok(updated.backupDirectory||updated.openspec?.backupDirectory);
  assert.equal(invoke(['doctor']).ready,true);
  report.checks.push('drift/update with opt-in config backup');
  invoke(['reset','--yes']);assert.equal(invoke(['doctor']).ready,true);
  const moved=path.join(root,'moved-workspace');await rename(workspace,moved);workspace=moved;
  assert.equal(invoke(['doctor'],1).ready,false);invoke(['update','--yes']);assert.equal(invoke(['doctor']).ready,true);
  report.checks.push('reset and whole-workspace relocation repair');
  const removePreview=invoke(['remove','--preview']);assert.ok(removePreview.openspecStore);
  invoke(['remove','--yes']);
  const after=await readFile(path.join(workspace,a,'openspec/config.yaml'),'utf8');assert.doesNotMatch(after,/^store:/m);assert.ok(after.includes('context: keep'));
  assert.deepEqual(await Promise.all(protectedNames.map(n=>readFile(path.join(workspace,n)))),protectedBytes);
  await access(path.join(workspace,docs,'.openspec-store/store.yaml'));
  await assert.rejects(access(path.join(workspace,'.pipeline/openspec/tool')),{code:'ENOENT'});
  report.checks.push('remove preserves borrowed config, docs identity and planning');
  report.status='passed';
}catch(error){report.status='failed';report.error={name:error.name,message:String(error.message).slice(0,2000)};process.exitCode=1;}
finally{await writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...report,reportPath:path.join(root,'report.json')},null,2));}
