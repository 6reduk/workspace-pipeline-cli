import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,mkdir,writeFile,readFile,unlink,symlink} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {parseCommand,runCli} from '../src/commands/dispatch.js';
import {providerRegistry} from '../src/providers/registry.js';
import {sha256} from '../src/source/inventory.js';
import {prepareReset} from '../src/operations/reset.js';
import {applyReset} from '../src/operations/apply.js';
import {acquireWorkspaceLock} from '../src/operations/lock.js';
import {clearResetTOMLSections} from '../src/operations/toml-fields.js';
import {contractDigest} from '../src/contracts/semantic.js';

async function fixture(){
  const root=await mkdtemp(path.join(tmpdir(),'wpc-reset-')),workspace=path.join(root,'a'),source=path.join(root,'source');
  await mkdir(workspace);await mkdir(source);
  const declaration={skills:'skills',agents:null,mcp:'mcp.json',entryInstructions:null,requires:[]};
  const pipeline={schemaVersion:1,id:'sample',version:'1.0.0',resources:'resources',inventory:'inventory.json',agentsDocument:{mode:'default'},
    providers:Object.fromEntries(['codex','claude','kimi','grok'].map(p=>[p,{...declaration,agents:'agents/'+p}])),
    bundles:{pair:{providers:['claude','grok'],entry:{source:'entry.md',target:'CLAUDE.md'}}}};
  const files={'pipeline.json':JSON.stringify(pipeline),'resources/process.md':'Inert test.',
    'entry.md':'Full shared instructions. Read AGENTS.md.',
    'skills/sdx-review/SKILL.md':'---\nname: sdx-review\ndescription: Inert test\n---\nRead only.\n',
    'mcp.json':JSON.stringify({mcpServers:{sample:{type:'stdio',command:'never-run'}}})};
  for(const p of ['codex','claude','kimi','grok'])files['agents/'+p+'/sdx-reviewer.'+(p==='codex'?'toml':'md')]=p==='codex'?
    'name="sdx-reviewer"\ndescription="Inert reviewer"\ndeveloper_instructions="Read only"\n':
    '---\nname: sdx-reviewer\ndescription: Inert reviewer\n---\nRead only.\n';
  for(const [name,bytes] of Object.entries(files)){
    const f=path.join(source,name);await mkdir(path.dirname(f),{recursive:true});await writeFile(f,bytes);
  }
  await writeFile(path.join(source,'inventory.json'),JSON.stringify(Object.fromEntries(Object.entries(files).map(([p,b])=>[p,sha256(Buffer.from(b))]))));
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^GIT_/i.test(k)));
  Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'});
  for(const args of [['init','--initial-branch=main','--template='],['add','.'],['-c','user.name=Fixture','-c','user.email=test@example.invalid','commit','-m','fixture']]){
    const r=spawnSync('git',['-C',source,'-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],{env,encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);
  }
  const manifest={schemaVersion:1,pipeline:{type:'git',transport:'local',path:'../source',ref:'main',subdirectory:'.'},providers:['codex','kimi'],bundles:['pair'],
    layout:{kind:'single-repo',repositories:{game:{path:'project',role:'code'}},documentation:{repository:'game',path:'docs'}}};
  await writeFile(path.join(workspace,'workspace.json'),JSON.stringify(manifest));
  await mkdir(path.join(workspace,'.codex'));await writeFile(path.join(workspace,'.codex/config.toml'),'# personal\nmodel="mine"\n');
  await mkdir(path.join(workspace,'project/docs'),{recursive:true});await writeFile(path.join(workspace,'project/docs/user.txt'),'game documents');
  let seq=0;
  async function run(args,expected=0){
    let out='',err='';const code=await runCli(args,{registry:providerRegistry,stdout:s=>{out+=s;},stderr:s=>{err+=s;}});
    if(expected!==null)assert.equal(code,expected,err+' '+out);
    return {code,out,err,json:out?JSON.parse(out):null};
  }
  async function save(value){const f=path.join(root,'preview-'+(++seq)+'.json');await writeFile(f,JSON.stringify(value));return f;}
  const setup=(await run(['setup','--workspace',workspace,'--manifest',path.join(workspace,'workspace.json')])).json;
  await run(['setup','--workspace',workspace,'--apply','--preview',await save(setup)]);
  return {root,workspace,source,run,save,state:path.join(workspace,'.pipeline/state.json')};
}

test('reset parser chooses installed and requires explicit selection / separate apply',()=>{
  const w=path.resolve('wrapper'),p=path.resolve('preview.json');
  assert.deepEqual(parseCommand(['reset','--workspace',w,'--all']).options,{to:'installed',all:true});
  assert.equal(parseCommand(['reset','--workspace',w,'--all','--to','empty']).options.to,'empty');
  for(const args of [[],['--all','--providers','codex'],['--all','--to','latest'],['--all','--network'],
    ['--apply','--preview',p,'--all'],['--apply','--preview',p,'--to','empty'],['--preview',p]])
    assert.throws(()=>parseCommand(['reset','--workspace',w,...args]));
});

test('reset TOML section editor preserves model/auth/agent controls and refuses unsafe forms',()=>{
  const prefix='model="mine"\n[auth]\ntoken="synthetic"\n[agents]\nmax_threads=3\ndefault_subagent_model="mine"\n';
  const bytes=Buffer.from(prefix+'[agents.personal]\ndescription="custom"\n[mcp_servers.custom]\ncommand="custom"\n');
  assert.equal(clearResetTOMLSections(bytes,['agents','mcp_servers']).toString(),prefix);
  assert.throws(()=>clearResetTOMLSections(Buffer.from('agents = { personal = { description = "custom" }, max_threads = 3 }'),['agents']));
  assert.throws(()=>clearResetTOMLSections(Buffer.from('[broken'),['agents']));
  assert.throws(()=>clearResetTOMLSections(bytes,['auth']));
});

test('reset installed restores snapshot, backs up custom bytes, protects auth/game and rejects stale inventory',async()=>{
  const f=await fixture(),skill=path.join(f.workspace,'.agents/skills/sdx-review/SKILL.md');
  const supplied=await readFile(skill),beforeState=await readFile(f.state);
  const suppliedAgent=path.join(f.workspace,'.codex/agents/sdx-reviewer.toml'),agentBytes=await readFile(suppliedAgent);
  await writeFile(suppliedAgent,'custom agent instructions');
  await writeFile(skill,'custom skill');
  const note=path.join(f.workspace,'.agents/skills/sdx-review/notes.md');await writeFile(note,'personal notes');
  const agent=path.join(f.workspace,'.grok/agents/personal.md');await mkdir(path.dirname(agent),{recursive:true});await writeFile(agent,'personal agent');
  const auth=path.join(f.workspace,'.grok/auth.json');await writeFile(auth,'synthetic auth sentinel');
  const settings=path.join(f.workspace,'.claude/settings.local.json');await writeFile(settings,'{"permissions":{"ask":["*"]}}');
  const personalAgents='[agents]\ntemperature = 0.5 # personal control\nfuture_options = ["mine"]\n';
  const cfg=path.join(f.workspace,'.codex/config.toml');await writeFile(cfg,(await readFile(cfg,'utf8'))+'\n[mcp_servers.personal]\ncommand="personal"\n'+personalAgents);
  const p=(await f.run(['reset','--workspace',f.workspace,'--all'])).json;
  assert.equal(p.reset.selection.to,'installed');assert.ok(p.preview.plan.targets.some(t=>t.path.endsWith('notes.md') && t.action==='delete'));
  assert.deepEqual(await readFile(f.state),beforeState);
  const saved=await f.save(p),extra=path.join(f.workspace,'.agents/skills/new.md');await writeFile(extra,'late');
  assert.notEqual((await f.run(['reset','--workspace',f.workspace,'--apply','--preview',saved],null)).code,0);
  assert.equal(await readFile(skill,'utf8'),'custom skill');await unlink(extra);
  const b=p.reset.backup.files[0];await mkdir(path.dirname(path.join(f.workspace,b.path)),{recursive:true});await writeFile(path.join(f.workspace,b.path),'wrong backup');
  assert.notEqual((await f.run(['reset','--workspace',f.workspace,'--apply','--preview',saved],null)).code,0);
  assert.deepEqual(await readFile(f.state),beforeState);assert.equal(await readFile(note,'utf8'),'personal notes');await unlink(path.join(f.workspace,b.path));
  const result=await f.run(['reset','--workspace',f.workspace,'--apply','--preview',saved]);
  assert.equal(result.json.status,'ready');assert.ok(result.err.includes('reset-backup-location'));
  assert.deepEqual(await readFile(skill),supplied);await assert.rejects(readFile(note),e=>e.code==='ENOENT');await assert.rejects(readFile(agent),e=>e.code==='ENOENT');
  assert.deepEqual(await readFile(suppliedAgent),agentBytes);
  for(const backup of p.reset.backup.files)assert.equal(sha256(await readFile(path.join(f.workspace,backup.path))),backup.hash);
  const backupManifest=await readFile(path.join(f.workspace,p.reset.backup.manifest.path));
  assert.equal(sha256(backupManifest),p.reset.backup.manifest.hash);
  assert.deepEqual(JSON.parse(backupManifest).files,p.reset.backup.files);
  assert.ok((await readFile(cfg,'utf8')).includes('model="mine"'));assert.ok(!(await readFile(cfg,'utf8')).includes('mcp_servers.personal'));
  assert.ok((await readFile(cfg,'utf8')).includes(personalAgents));
  assert.equal(await readFile(auth,'utf8'),'synthetic auth sentinel');assert.equal(await readFile(settings,'utf8'),'{"permissions":{"ask":["*"]}}');
  assert.equal(await readFile(path.join(f.workspace,'project/docs/user.txt'),'utf8'),'game documents');
  assert.equal((await f.run(['doctor','--workspace',f.workspace])).json.ready,true);
  const update=(await f.run(['update','--workspace',f.workspace])).json;
  assert.equal((await f.run(['update','--workspace',f.workspace,'--apply','--preview',await f.save(update)])).json.status,'ready');
  // Current Git/manifest are unnecessary for installed reset and later repair.
  const manifestBytes=await readFile(path.join(f.workspace,'workspace.json'));
  await unlink(path.join(f.workspace,'workspace.json'));
  const empty=(await f.run(['reset','--workspace',f.workspace,'--all','--to','empty'])).json;
  assert.equal((await f.run(['reset','--workspace',f.workspace,'--apply','--preview',await f.save(empty)])).json.status,'not-installed');
  assert.ok((await readFile(cfg,'utf8')).includes(personalAgents));
  assert.equal(JSON.parse(await readFile(f.state)).active,null);
  assert.equal((await f.run(['doctor','--workspace',f.workspace],1)).json.status,'not-installed');
  assert.equal(await readFile(auth,'utf8'),'synthetic auth sentinel');
  const newManifest=path.join(f.workspace,'reinstall.json');await writeFile(newManifest,manifestBytes);
  const reinstall=(await f.run(['setup','--workspace',f.workspace,'--manifest',newManifest])).json;
  assert.equal((await f.run(['setup','--workspace',f.workspace,'--apply','--preview',await f.save(reinstall)])).json.status,'ready');
  assert.equal(await readFile(path.join(f.workspace,'project/docs/user.txt'),'utf8'),'game documents');
});

test('reset bundle selection and drift in unselected provider fail closed; links never traversed',async()=>{
  const f=await fixture();
  await assert.rejects(prepareReset(f.workspace,providerRegistry,{providers:['claude']}),e=>e.code==='remove.bundle-required');
  const codex=path.join(f.workspace,'.agents/skills/sdx-review/SKILL.md'),original=await readFile(codex);
  await writeFile(codex,'unselected custom');
  await assert.rejects(prepareReset(f.workspace,providerRegistry,{bundles:['pair']}),e=>e.code==='reset.unselected-drift');
  await writeFile(codex,original);
  const link=path.join(f.workspace,'.grok/skills/link');await symlink(path.join(f.workspace,'project'),link,process.platform==='win32'?'junction':'dir');
  await assert.rejects(prepareReset(f.workspace,providerRegistry,{bundles:['pair']}));await unlink(link);
  const p=await prepareReset(f.workspace,providerRegistry,{bundles:['pair'],to:'empty'});
  assert.ok(!p.preview.plan.targets.some(t=>t.path.startsWith('.agents/') || t.path==='AGENTS.md'));
  assert.equal((await f.run(['reset','--workspace',f.workspace,'--apply','--preview',await f.save(p)])).json.status,'ready');
  assert.deepEqual(await readFile(codex),original);assert.equal((await f.run(['doctor','--workspace',f.workspace])).json.ready,true);
});

test('reset refuses malformed config, corrupt snapshot, stale bytes and forged scope before writes',async()=>{
  const f=await fixture(),state=await readFile(f.state),cfg=path.join(f.workspace,'.codex/config.toml');
  const original=await readFile(cfg);await writeFile(cfg,'[broken');
  await assert.rejects(prepareReset(f.workspace,providerRegistry,{all:true}),e=>e.code==='toml.syntax');
  await writeFile(cfg,original);
  const resource=path.join(f.workspace,JSON.parse(state).active.snapshot.path,'resources/process.md');
  const canonical=await readFile(resource);await writeFile(resource,'corrupt snapshot');
  await assert.rejects(prepareReset(f.workspace,providerRegistry,{all:true}));await writeFile(resource,canonical);
  const p=await prepareReset(f.workspace,providerRegistry,{all:true}),saved=await f.save(p);
  const skill=path.join(f.workspace,'.agents/skills/sdx-review/SKILL.md'),skillBytes=await readFile(skill);
  await writeFile(skill,'late tuning');
  assert.notEqual((await f.run(['reset','--workspace',f.workspace,'--apply','--preview',saved],null)).code,0);
  assert.equal(await readFile(skill,'utf8'),'late tuning');await writeFile(skill,skillBytes);
  const forged=structuredClone(p);forged.reset.scope.trees=['project'];
  const {digest,...body}=forged;forged.digest=contractDigest(body);
  assert.notEqual((await f.run(['reset','--workspace',f.workspace,'--apply','--preview',await f.save(forged)],null)).code,0);
  assert.deepEqual(await readFile(f.state),state);
  assert.equal(await readFile(path.join(f.workspace,'project/docs/user.txt'),'utf8'),'game documents');
});

for(const to of ['installed','empty'])test('reset continuation after deletion preserves backups and approved scope '+to,async()=>{
  const f=await fixture();
  const extra=path.join(f.workspace,'.agents/skills/extra.md');await writeFile(extra,'custom original');
  const p=await prepareReset(f.workspace,providerRegistry,{all:true,to});
  const lock=await acquireWorkspaceLock(f.workspace);let stopped;
  try{stopped=await applyReset(lock,p,{decision:'approve',preparedDigest:p.digest},providerRegistry,
    {ioBoundary:event=>{if(event.purpose==='target' && event.phase==='deleted')throw Error('synthetic stop');}});}
  finally{await lock.release();}
  assert.equal(stopped.status,'needs-reconciliation');
  const before=await readFile(path.join(f.workspace,stopped.recoveryPath));
  const late=path.join(f.workspace,'.agents/skills/late.md');await writeFile(late,'new unknown');
  assert.notEqual((await f.run(['continue','--workspace',f.workspace,'--recovery',stopped.recoveryPath],null)).code,0);await unlink(late);
  const continuation=(await f.run(['continue','--workspace',f.workspace,'--recovery',stopped.recoveryPath])).json;
  const result=await f.run(['continue','--workspace',f.workspace,'--apply','--preview',await f.save(continuation)]);
  assert.equal(result.json.status,to==='installed'?'ready':'not-installed');
  assert.deepEqual(await readFile(path.join(f.workspace,stopped.recoveryPath)),before);
  for(const b of p.reset.backup.files)assert.equal(sha256(await readFile(path.join(f.workspace,b.path))),b.hash);
  assert.equal((await f.run(['doctor','--workspace',f.workspace],to==='installed'?0:1)).json.status,to==='installed'?'ready':'not-installed');
});

for(const noOp of [false,true])test('reset can continue a recorded interruption before publishing pending state; noOp='+noOp,async()=>{
  const f=await fixture();
  if(noOp){
    const initial=await prepareReset(f.workspace,providerRegistry,{all:true});
    await f.run(['reset','--workspace',f.workspace,'--apply','--preview',await f.save(initial)]);
  }else await writeFile(path.join(f.workspace,'.agents/skills/user.md'),'custom');
  const before=await readFile(f.state),p=await prepareReset(f.workspace,providerRegistry,{all:true});
  if(noOp)assert.equal(p.preview.plan.targets.length,0);
  const lock=await acquireWorkspaceLock(f.workspace);let journal;
  try{await assert.rejects(()=>applyReset(lock,p,{decision:'approve',preparedDigest:p.digest},providerRegistry,
    {onJournal:event=>{journal=event.relative;},boundary:phase=>{if(phase==='recovery')throw Error('stop before pending');}}));}
  finally{await lock.release();}
  assert.deepEqual(await readFile(f.state),before);
  const recovery=journal.replace('/journals/','/transactions/')+'/recovery.json';
  const next=(await f.run(['continue','--workspace',f.workspace,'--recovery',recovery])).json;
  assert.equal((await f.run(['continue','--workspace',f.workspace,'--apply','--preview',await f.save(next)])).json.status,'ready');
  assert.equal((await f.run(['doctor','--workspace',f.workspace])).json.ready,true);
});
