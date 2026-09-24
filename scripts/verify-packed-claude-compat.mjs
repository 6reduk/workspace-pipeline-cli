// Synthetic migration of an old dual bundle to a single Claude delivery.
// No real provider profile, model session or MCP invocation.
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const repository=fileURLToPath(new URL('../',import.meta.url)),npm=process.env.npm_execpath;
assert.ok(npm&&path.isAbsolute(npm),'Run via npm run test:packed:claude-compat');
const root=await mkdtemp(path.join(tmpdir(),'wpc-packed-claude-compat-'));
const report={root,status:'running',checks:[],runtime:'not-run'};
const hash=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^GIT_|^GROK_|^CLAUDE_|TOKEN|API_KEY|SECRET|PASSWORD/i.test(k)));
const home=path.join(root,'home');
Object.assign(env,{HOME:home,USERPROFILE:home,GROK_HOME:path.join(home,'.grok'),CLAUDE_CONFIG_DIR:path.join(home,'.claude'),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',npm_config_offline:'true',npm_config_ignore_scripts:'true'});
const npmEnv={...process.env,npm_config_offline:'true',npm_config_ignore_scripts:'true'};
const runNpm=args=>execFileSync(process.execPath,[npm,...args],{cwd:repository,env:npmEnv,encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:4*1024*1024});
async function put(base,name,bytes){const p=path.join(base,name);await mkdir(path.dirname(p),{recursive:true});await writeFile(p,bytes);}
try{
  const [packed]=JSON.parse(runNpm(['pack','--offline','--ignore-scripts','--json','--pack-destination',root]));
  const prefix=path.join(root,'consumer');await mkdir(prefix);
  runNpm(['install','--prefix',prefix,'--offline','--ignore-scripts','--no-audit','--no-fund',path.join(root,packed.filename)]);
  const installed=path.join(prefix,'node_modules/@6reduk/workspace-pipeline'),cli=path.join(installed,'src/cli.js');
  for(const file of packed.files)assert.equal(hash(await readFile(path.join(installed,file.path))),hash(await readFile(path.join(repository,file.path))));
  report.tarball={path:path.join(root,packed.filename),integrity:packed.integrity};
  const source=path.join(root,'source'),workspace=path.join(root,'workspace');await mkdir(source);await mkdir(workspace);
  const decl={skills:'skills',agents:null,mcp:'mcp.json',entryInstructions:null,requires:[]};
  const manifest={schemaVersion:1,id:'fixture',version:'1.0.0',resources:'resources',inventory:'inventory.json',agentsDocument:{mode:'default'},providers:{codex:decl,claude:decl,grok:decl},bundles:{pair:{providers:['claude','grok'],entry:{source:'entry.md',target:'CLAUDE.md'}}}};
  const files={'pipeline.json':JSON.stringify(manifest),'resources/rules.md':'Human approval required.',
    'entry.md':'# Pipeline\nRead AGENTS.md and use the delivered Claude skills.\n',
    'skills/sdx-review/SKILL.md':'---\nname: sdx-review\ndescription: Review only\n---\nRead ../../resources/rules.md.\n',
    'mcp.json':JSON.stringify({mcpServers:{fixture:{type:'stdio',command:'never-execute'}}})};
  const git=args=>{const p=spawnSync('git',['-C',source,'-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],{env,windowsHide:true,encoding:'utf8'});assert.equal(p.status,0,p.stderr);};
  async function commit(){for(const [name,data]of Object.entries(files))await put(source,name,data);await put(source,'inventory.json',JSON.stringify(Object.fromEntries(Object.entries(files).map(([p,b])=>[p,hash(b)]))));git(['add','--all']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','synthetic source']);}
  git(['init','--initial-branch=main','--template=']);await commit();
  const config='# personal\r\n[models]\r\ndefault="keep"\r\n[compat.claude]\r\nskills=false # keep comment\r\nsessions=false\r\n';
  await put(home,'.grok/config.toml',config);
  await put(workspace,'.grok/config.toml','[models]\ndefault="workspace-keep"\n[mcp_servers.foreign]\ncommand="personal"\n');
  await put(workspace,'workspace.json',JSON.stringify({schemaVersion:1,pipeline:{type:'git',transport:'local',path:'../source',ref:'main',subdirectory:'.'},providers:['codex'],bundles:['pair'],layout:{kind:'single-repo',repositories:{game:{path:'project',role:'code'}},documentation:{repository:'game',path:'docs'}}}));
  function cliRun(args,expected=0){const r=spawnSync(process.execPath,[cli,...args,'--json'],{cwd:root,env,encoding:'utf8',windowsHide:true,timeout:180000,maxBuffer:16*1024*1024});assert.equal(r.status,expected,JSON.stringify({args:args.slice(0,2),status:r.status,error:r.error?.code,stderr:r.stderr}));return JSON.parse(r.stdout||r.stderr);}
  let seq=0;
  async function apply(command,extra=[]){const preview=cliRun([command,'--workspace',workspace,...extra]);const p=path.join(root,`preview-${++seq}.json`);await writeFile(p,JSON.stringify(preview));return {preview,result:cliRun([command,'--workspace',workspace,'--apply','--preview',p])};}
  await apply('setup',['--manifest',path.join(workspace,'workspace.json')]);
  assert.equal(await readFile(path.join(home,'.grok/config.toml'),'utf8'),config);
  const codex=await readFile(path.join(workspace,'.agents/skills/sdx-review/SKILL.md'));
  manifest.version='1.1.0';delete manifest.providers.grok;manifest.bundles.pair.providers=['claude'];files['pipeline.json']=JSON.stringify(manifest);await commit();
  const updated=await apply('update');assert.equal(updated.preview.kind,'prepared-with-claude-compatibility');assert.equal(updated.result.compatibility.status,'configured');
  assert.equal(await readFile(path.join(updated.result.compatibility.backupDir,'config.before.toml'),'utf8'),config);
  await assert.rejects(readFile(path.join(workspace,'.grok/skills/sdx-review/SKILL.md')),e=>e.code==='ENOENT');
  assert.ok((await readFile(path.join(workspace,'.grok/config.toml'),'utf8')).includes('command="personal"'));
  assert.ok(!(await readFile(path.join(workspace,'.grok/config.toml'),'utf8')).includes('never-execute'));
  assert.ok((await readFile(path.join(workspace,'.agents/skills/sdx-review/SKILL.md'))).length);
  assert.ok((await readFile(path.join(workspace,'.claude/skills/sdx-review/SKILL.md'))).length);
  const doctor=cliRun(['doctor','--workspace',workspace]);assert.equal(doctor.ready,true);assert.equal(doctor.compatibility.status,'configured');
  report.checks.push('old bundle -> Claude only; retired Grok owned files; preserved Codex and foreign Grok config; global backup');
  // A changed global preference is detected, and repair changes only approved fields.
  await put(home,'.grok/config.toml',config);
  assert.equal(cliRun(['doctor','--workspace',workspace],1).status,'needs-compatibility');
  assert.equal((await apply('repair')).result.compatibility.status,'configured');
  // Human convenience path uses the same installed executable without a supplied preview.
  await put(home,'.grok/config.toml',config);
  const automatic=cliRun(['update','--workspace',workspace,'--yes']);
  assert.equal(automatic.status,'ready');assert.equal(automatic.compatibility.status,'configured');
  report.checks.push('published-shape executable update --yes --json applies without a user preview file');
  assert.equal((await apply('reset',['--bundles','pair'])).result.compatibility.status,'configured');
  const retained=await readFile(path.join(home,'.grok/config.toml'));
  await apply('remove',['--bundles','pair']);assert.deepEqual(await readFile(path.join(home,'.grok/config.toml')),retained);
  assert.equal(cliRun(['doctor','--workspace',workspace]).ready,true);
  report.checks.push('doctor detects global drift; repair/reset work; remove retains global compatibility');
  report.checks.push({packedFiles:packed.files.length,backups:(await readdir(path.join(home,'.grok/workspace-pipeline-backups'))).length});
  report.status='pass';
}catch(error){report.status='fail';report.error={name:error.name,message:error.message};throw error;}
finally{await writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));}
