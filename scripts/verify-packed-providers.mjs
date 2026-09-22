// Run via npm run test:packed:providers. Installs only into a fresh Temp prefix.
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,readdir,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const repository=fileURLToPath(new URL('../',import.meta.url)),npm=process.env.npm_execpath;
assert.ok(npm&&path.isAbsolute(npm),'Run through npm run test:packed:providers');
const root=await mkdtemp(path.join(tmpdir(),'wpc-packed-providers-'));
const hash=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
const report={root,status:'running',checks:[],network:'offline',runtime:'not-run',publication:false};
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^GIT_/i.test(key)));
Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',npm_config_offline:'true',npm_config_ignore_scripts:'true',npm_config_audit:'false',npm_config_fund:'false'});
const runNpm=args=>execFileSync(process.execPath,[npm,...args],{cwd:repository,env,encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:4*1024*1024});
try{
  const [packed]=JSON.parse(runNpm(['pack','--offline','--ignore-scripts','--json','--pack-destination',root]));
  const tarball=path.join(root,packed.filename),prefix=path.join(root,'consumer');await mkdir(prefix);
  runNpm(['install','--prefix',prefix,'--offline','--ignore-scripts','--no-audit','--no-fund',tarball]);
  const installed=path.join(prefix,'node_modules/@6reduk/workspace-pipeline');
  for(const item of packed.files)assert.equal(hash(await readFile(path.join(installed,item.path))),hash(await readFile(path.join(repository,item.path))),item.path);
  report.tarball={path:tarball,sha256:hash(await readFile(tarball)),integrity:packed.integrity};
  report.checks.push({name:'installed-bytes-match-source',files:packed.files.length});
  const cli=path.join(installed,'src/cli.js'),source=path.join(root,'source'),a=path.join(root,'a'),b=path.join(root,'b');
  for(const p of [source,a,b])await mkdir(p);
  const declaration={skills:'skills',agents:null,mcp:'mcp.json',entryInstructions:null,requires:[]};
  const providers=['codex','claude','kimi','grok'];
  const manifest={schemaVersion:1,id:'fixture',version:'1.0.0',resources:'resources',inventory:'inventory.json',agentsDocument:{mode:'default'},providers:Object.fromEntries(providers.map(p=>[p,declaration]))};
  manifest.bundles={pair:{providers:['claude','grok'],entry:{source:'instructions/CLAUDE.md',target:'CLAUDE.md'}}};
  const files={
    'pipeline.json':JSON.stringify(manifest),'resources/process.md':'Only human-approved mutations.',
    'instructions/CLAUDE.md':'# Full shared pipeline\nRead AGENTS.md for project routing.\nUse the skills and MCP of your own harness.\n',
    'skills/fixture-review/SKILL.md':'---\nname: fixture-review\ndescription: Read-only review\n---\nRead ../../resources/process.md.\n',
    'mcp.json':JSON.stringify({mcpServers:{'fixture-tool':{type:'stdio',command:'never-executed'}}})
  };
  for(const [p,t]of Object.entries(files)){const target=path.join(source,p);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,t);}
  await writeFile(path.join(source,'inventory.json'),JSON.stringify(Object.fromEntries(Object.entries(files).map(([p,t])=>[p,hash(Buffer.from(t))]))));
  for(const args of [['init','--initial-branch=main','--template='],['add','--all'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture']]){
    const result=spawnSync('git',['-C',source,'-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],{env,windowsHide:true,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
  }
  const workspace={schemaVersion:1,pipeline:{type:'git',transport:'local',path:'../source',ref:'main',subdirectory:'.'},providers:['codex','kimi'],bundles:['pair'],
    layout:{kind:'single-repo',repositories:{game:{path:'project',role:'code'}},documentation:{repository:'game',path:'docs'}}};
  await writeFile(path.join(a,'workspace.json'),JSON.stringify(workspace));
  const foreign='# personal\r\nmodel="user-choice"\r\n';await mkdir(path.join(a,'.codex'));await writeFile(path.join(a,'.codex/config.toml'),foreign);
  await writeFile(path.join(a,'.mcp.json'),JSON.stringify({mcpServers:{foreign:{command:'personal'}}}));
  const kimiForeign=JSON.stringify({mcpServers:{foreign:{command:'kimi-personal'}},note:'keep'});
  const grokForeign='# personal Grok\r\n[models]\r\ndefault="personal"\r\n[mcp_servers.foreign]\r\ncommand="grok-personal"\r\n';
  await mkdir(path.join(a,'.kimi-code'));await writeFile(path.join(a,'.kimi-code/mcp.json'),kimiForeign);
  await mkdir(path.join(a,'.grok'));await writeFile(path.join(a,'.grok/config.toml'),grokForeign);
  function run(args,expected=0){
    const result=spawnSync(process.execPath,[cli,...args],{cwd:prefix,env,encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:8*1024*1024});
    assert.equal(result.status,expected,JSON.stringify({command:args[0],status:result.status,error:result.error?.code,stderr:result.stderr}));
    return JSON.parse(expected===0?result.stdout:result.stderr);
  }
  let sequence=0;
  async function apply(command,extra=[]){
    const preview=run([command,'--workspace',a,...extra]);
    const previewPath=path.join(root,`preview-${++sequence}.json`);await writeFile(previewPath,JSON.stringify(preview));
    const result=run([command,'--workspace',a,'--apply','--preview',previewPath]);
    report.checks.push({name:command,providers:extra,status:result.status??null});return result;
  }
  assert.equal((await apply('setup',['--manifest',path.join(a,'workspace.json')])).status,'ready');
  assert.equal(run(['doctor','--workspace',a]).ready,true);
  const commonEntry=await readFile(path.join(a,'CLAUDE.md'));
  assert.equal(commonEntry.toString(),files['instructions/CLAUDE.md']);
  assert.ok(!commonEntry.toString().includes('providers/claude'));
  // Preview only: Node's executable is an inert path for validation; never spawned.
  const launch=run(['launch','grok','--workspace',a,'--executable',process.execPath]);
  assert.equal(launch.runtime,'not-run');assert.equal(launch.environmentOverrides.GROK_CLAUDE_SKILLS_ENABLED,'false');
  for(const location of ['.agents','.claude','.kimi-code','.grok'])assert.ok((await readFile(path.join(a,location,'skills/fixture-review/SKILL.md'))).length);
  assert.equal((await apply('update')).status,'ready');
  const skill=path.join(a,'.grok/skills/fixture-review/SKILL.md'),original=await readFile(skill);
  await rename(skill,path.join(root,'saved-skill.md'));
  await apply('repair');assert.deepEqual(await readFile(skill),original);
  assert.equal(run(['remove','--workspace',a,'--providers','claude'],2).error,'remove.bundle-required');
  assert.deepEqual(await readFile(path.join(a,'CLAUDE.md')),commonEntry);
  assert.equal(run(['doctor','--workspace',a]).ready,true);
  await apply('remove',['--bundles','pair']);
  await assert.rejects(readFile(path.join(a,'CLAUDE.md')),e=>e.code==='ENOENT');
  assert.equal(await readFile(path.join(a,'.grok/config.toml'),'utf8'),grokForeign);
  assert.ok((await readFile(path.join(a,'.kimi-code/skills/fixture-review/SKILL.md'))).length);
  await apply('remove',['--providers','kimi']);
  assert.deepEqual(JSON.parse(await readFile(path.join(a,'.kimi-code/mcp.json'),'utf8')),JSON.parse(kimiForeign));
  assert.ok((await readFile(path.join(a,'.agents/skills/fixture-review/SKILL.md'))).length);
  assert.equal(run(['doctor','--workspace',a]).ready,true);
  assert.ok((await readFile(path.join(a,'AGENTS.md'))).length);
  await apply('remove');
  assert.ok((await readFile(path.join(a,'.codex/config.toml'),'utf8')).startsWith(foreign));
  assert.deepEqual(JSON.parse(await readFile(path.join(a,'.mcp.json'),'utf8')),{mcpServers:{foreign:{command:'personal'}}});
  await assert.rejects(readFile(path.join(a,'AGENTS.md')),e=>e.code==='ENOENT');
  assert.deepEqual(await readdir(b),[]);
  report.checks.push({name:'foreign-config-and-sibling-preserved'});report.status='pass';
}catch(error){report.status='fail';report.error={name:error.name,message:error.message};throw error;}
finally{await writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));}
