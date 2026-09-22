import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { acquire, validateSource, runGit, parseListing, gitArgs, environment } from '../src/source/git.js';
import { sha256, verifyPackage, checkEntries, LIMITS, cap } from '../src/source/inventory.js';
import { materialize, checkDestination } from '../src/source/snapshot.js';

const h = 'a'.repeat(40), hash = 'sha256:' + 'a'.repeat(64);
const devNull = '/dev/null';
const decl = { skills: 'skills', agents: null, mcp: null, entryInstructions: null, requires: [] };
function contents(extra = {}) {
  const manifest = { schemaVersion: 1, id: 'fixture', version: '1.0.0', resources: 'resources',
    inventory: 'inventory.json', agentsDocument: { mode: 'default' }, providers: { codex: decl } };
  const files = new Map(Object.entries({ 'pipeline.json': JSON.stringify(manifest),
    'resources/process.md': '# Rules\n', 'skills/example/SKILL.md': '# Skill\n', ...extra })
    .map(([p, b]) => [p, Buffer.from(b)]));
  files.set('inventory.json', Buffer.from(JSON.stringify(Object.fromEntries([...files].map(([p, b]) => [p, sha256(b)])))));
  return files;
}
function entries(files) { return [...files].map(([p,b])=>({ path:p, size:b.length, mode:'100644', type:'blob', oid:h })); }
const verify = files => verifyPackage(entries(files), async e => files.get(e.path));
function git(cwd, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:devNull });
  const r=spawnSync('git',['-C',cwd,'-c','core.hooksPath='+devNull,'-c','commit.gpgsign=false',...args],
    {encoding:'utf8',env,windowsHide:true,shell:false});
  if(r.status!==0)throw Error('fixture Git failed: '+r.stderr);
  return r.stdout.trim();
}
async function fixture(extra = {}, format = 'sha1') {
  const root=await mkdtemp(path.join(tmpdir(),'wpc-s2-'));
  const repo=path.join(root,'repo with spaces');
  await mkdir(repo);
  git(repo,['init','--initial-branch=main','--template=','--object-format='+format]);
  git(repo,['config','user.name','Fixture']);git(repo,['config','user.email','fixture@example.invalid']);
  for(const [p,b]of contents(extra)) {await mkdir(path.dirname(path.join(repo,p)),{recursive:true});await writeFile(path.join(repo,p),b);}
  git(repo,['add','--all']);git(repo,['commit','-m','fixture']);
  return {root,repo,source:{type:'git',transport:'local',path:'repo with spaces',ref:'main',subdirectory:'.'}};
}
async function treeHashes(root) {
  const hashes={};
  async function walk(p) { for(const entry of await readdir(p,{withFileTypes:true})) {
    const f=path.join(p,entry.name);
    if(entry.isDirectory()) await walk(f);
    else hashes[path.relative(root,f)]=sha256(await readFile(f));
  }}
  await walk(root);return hashes;
}
const rejectsCode = (fn, code) => assert.rejects(fn, e => e.code === code);

test('leading-dash source rejected before acquisition',()=>{
  assert.throws(()=>validateSource({type:'git',transport:'local',path:'-evil',ref:'HEAD',subdirectory:'.'}),e=>e.code==='schema.invalid');
});
test('SHA256 local commit pin and source preservation',async()=>{
  const f=await fixture({},'sha256'),before=await treeHashes(f.repo),commit=git(f.repo,['rev-parse','HEAD']);
  assert.equal(commit.length,64);
  const a=await acquire({...f.source,ref:commit},{manifestBase:f.root,tempRoot:f.root});
  assert.equal(a.commit,commit);assert.deepEqual(await treeHashes(f.repo),before);
});
test('missing repository has safe code and exact retained preparation',async()=>{
  const f=await fixture();
  try { await acquire({...f.source,path:'missing-private-name'},{manifestBase:f.root,tempRoot:f.root});assert.fail('expected rejection'); }
  catch(e) {
    assert.equal(e.name,'ContractError');assert.equal(e.code,'source.missing-repository');
    assert.equal(e.message,'source.missing-repository');assert.equal(e.cause,undefined);
    assert.equal(path.dirname(e.preparation),f.root);assert.ok((await stat(e.preparation)).isDirectory());
  }
});
test('failed snapshot carries exact retained directory',async()=>{
  const f=await fixture(),v=await verify(contents());v.fileHashes['pipeline.json']='wrong';
  try {await materialize(v,f.root);assert.fail('expected rejection');}
  catch(e) {assert.equal(e.code,'snapshot.input');assert.equal(path.dirname(e.snapshotPath),f.root);assert.ok((await stat(e.snapshotPath)).isDirectory());}
});
test('failed taskkill and held pipes report termination-unconfirmed without real processes',async()=>{
  const child=new EventEmitter(),calls=[];
  Object.assign(child,{pid:12345,stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>{calls.push('fallback');return false;},unref:()=>calls.push('unref')});
  const launch=(name,args)=>{
    calls.push([name,args]);
    if(name==='git')return child;
    const killer=new EventEmitter();setImmediate(()=>killer.emit('exit',1));return killer;
  };
  await assert.rejects(()=>runGit(tmpdir(),['--version'],{deadline:performance.now()+20},{spawn:launch,platform:'win32'}),e=>e.code==='source.termination-unconfirmed'&&e.processId===12345);
  assert.deepEqual(calls.find(c=>Array.isArray(c)&&c[0]==='taskkill'),['taskkill',['/PID','12345','/T','/F']]);
  assert.ok(calls.includes('fallback'));assert.ok(calls.includes('unref'));
  assert.ok(child.stdout.destroyed&&child.stderr.destroyed);
});
test('stderr classification is narrow, chunk-safe and does not expose text',async()=>{
  for(const [parts,enabled,code] of [
    [['error: Server does not allow request for unadvert','ised object '+h+' secret'],true,'source.unadvertised-commit'],
    [['Permission denied secret'],true,'source.git-failed'],
    [['Server does not allow request for unadvertised object '+h],false,'source.git-failed']
  ]) {
    const child=new EventEmitter();Object.assign(child,{stdout:new PassThrough(),stderr:new PassThrough()});
    const launch=()=>{setImmediate(()=>{for(const p of parts)child.stderr.write(p);child.emit('close',1);});return child;};
    await assert.rejects(()=>runGit(tmpdir(),['--version'],{diagnoseUnadvertised:enabled},{spawn:launch}),e=>e.code===code&&e.message===code&&!JSON.stringify(e).includes('secret'));
  }
});

test('local committed tree excludes staged/dirty/untracked, source remains byte-identical',async()=>{
  const f=await fixture({'.gitattributes':'* filter=probe\n'});
  await writeFile(path.join(f.repo,'resources/process.md'),'staged bytes');
  git(f.repo,['add','--','resources/process.md']);
  await writeFile(path.join(f.repo,'resources/process.md'),'dirty bytes');
  await writeFile(path.join(f.repo,'untracked.txt'),'not pipeline');
  git(f.repo,['config','filter.probe.smudge','echo SHOULD_NOT_RUN']);
  git(f.repo,['config','core.fsmonitor','echo SHOULD_NOT_RUN']);
  await mkdir(path.join(f.repo,'.git/hooks'),{recursive:true});
  await writeFile(path.join(f.repo,'.git/hooks/post-checkout'),'#!/bin/sh\necho unexpected > hook-marker\n',{mode:0o700});
  const before=await treeHashes(f.repo);
  const a=await acquire(f.source,{manifestBase:f.root,tempRoot:f.root});
  const isolatedConfig=await readFile(path.join(a.preparation,'objects.git/config'),'utf8');
  assert.doesNotMatch(isolatedConfig,/SHOULD_NOT_RUN|smudge|fsmonitor|Fixture/);
  assert.equal(await stat(path.join(a.preparation,'objects.git/index')).then(()=>true,()=>false),false);
  assert.equal(await stat(path.join(a.preparation,'objects.git/objects/info/alternates')).then(()=>true,()=>false),false);
  assert.equal((await readFile(path.join(a.snapshotPath,'resources/process.md'))).toString(),'# Rules\n');
  assert.equal(a.commit,git(f.repo,['rev-parse','HEAD']));
  assert.deepEqual(await treeHashes(f.repo),before);
  const b=await acquire(f.source,{manifestBase:f.root,tempRoot:f.root});
  await writeFile(path.join(a.snapshotPath,'resources/process.md'),'mutated independent copy');
  assert.equal((await readFile(path.join(b.snapshotPath,'resources/process.md'))).toString(),'# Rules\n');
  assert.notEqual(a.snapshotPath,b.snapshotPath);
});
test('local ambiguity, full commit, missing ref and annotated tag',async()=>{
  const f=await fixture(),opts={manifestBase:f.root,tempRoot:f.root};
  git(f.repo,['tag','main']);
  await rejectsCode(()=>acquire(f.source,opts),'source.ambiguous-ref');
  const sha=git(f.repo,['rev-parse','HEAD']);
  const pinned=await acquire({...f.source,ref:sha},opts);assert.equal(pinned.commit,sha);
  git(f.repo,['tag','-a','release','-m','tag']);
  const tag=await acquire({...f.source,ref:'refs/tags/release'},opts);assert.equal(tag.commit,sha);
  await rejectsCode(()=>acquire({...f.source,ref:'missing'},opts),'source.missing-ref');
  await rejectsCode(()=>acquire({...f.source,ref:git(f.repo,['rev-parse','refs/tags/release'])},opts),'source.not-commit');
});
test('linked worktree HEAD resolves in isolated repo without changing either worktree',async()=>{
  const f=await fixture(), linked=path.join(f.root,'linked');
  git(f.repo,['worktree','add','--detach',linked,'HEAD']);
  const before=await treeHashes(f.repo), linkedBefore=await treeHashes(linked);
  const a=await acquire({...f.source,path:'linked',ref:'HEAD'},{manifestBase:f.root,tempRoot:f.root});
  assert.equal(a.commit,git(f.repo,['rev-parse','HEAD']));
  assert.deepEqual(await treeHashes(f.repo),before);
  assert.deepEqual(await treeHashes(linked),linkedBefore);
});
test('remote auth configuration stays user-controlled; source Git environment cannot leak',()=>{
  const keys=['GIT_CONFIG_GLOBAL','GIT_CONFIG_SYSTEM','GIT_CONFIG_NOSYSTEM','GIT_SSH_COMMAND','GIT_CONFIG_COUNT','GIT_DIR','GIT_ALTERNATE_OBJECT_DIRECTORIES'];
  const before=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  try {
    for(const k of keys)process.env[k]='fixture-'+k;
    const remote=environment(true),local=environment(false);
    for(const k of keys.slice(0,4))assert.equal(remote[k],process.env[k]);
    for(const k of keys.slice(4))assert.equal(remote[k],undefined);
    assert.equal(local.GIT_CONFIG_GLOBAL,'/dev/null');
    assert.equal(local.GIT_CONFIG_NOSYSTEM,'1');
    assert.equal(local.GIT_CONFIG_SYSTEM,undefined);
  } finally {for(const k of keys)if(before[k]===undefined)delete process.env[k];else process.env[k]=before[k];}
});
test('deadline stops a running synthetic SSH helper',async()=>{
  const f=await fixture(),helper=path.join(f.root,'slow-ssh.cjs'),pidFile=path.join(f.root,'pid');
  await writeFile(helper,"require('node:fs').writeFileSync("+JSON.stringify(pidFile)+",String(process.pid));setTimeout(()=>process.exit(0),6000);");
  const previous=process.env.GIT_SSH_COMMAND;
  process.env.GIT_SSH_COMMAND='"'+process.execPath.replaceAll('\\','/')+'" "'+helper.replaceAll('\\','/')+'"';
  try {
    await rejectsCode(()=>runGit(f.repo,['-c','ssh.variant=ssh','ls-remote','--','ssh://git@fixture.invalid/repo','HEAD'],
      {network:true,deadline:performance.now()+1500}),'source.timeout');
    const pid=Number(await readFile(pidFile,'utf8'));
    assert.throws(()=>process.kill(pid,0),e=>e.code==='ESRCH');
  } finally {if(previous===undefined)delete process.env.GIT_SSH_COMMAND;else process.env.GIT_SSH_COMMAND=previous;}
});
test('bare local remote and nested package use same committed content',async()=>{
  const f=await fixture(),bare=path.join(f.root,'bare.git');
  git(f.root,['clone','--bare','--no-hardlinks',f.repo,bare]);
  const a=await acquire({...f.source,path:'bare.git'},{manifestBase:f.root,tempRoot:f.root});
  assert.equal(a.commit,git(f.repo,['rev-parse','HEAD']));
  await mkdir(path.join(f.repo,'packages/unity'),{recursive:true});
  for(const [p,b] of contents()) { const dst=path.join(f.repo,'packages/unity',p);await mkdir(path.dirname(dst),{recursive:true});await writeFile(dst,b); }
  git(f.repo,['add','--all']);git(f.repo,['commit','-m','nested']);
  const nested=await acquire({...f.source,subdirectory:'packages/unity'},{manifestBase:f.root,tempRoot:f.root});
  assert.equal(Object.keys(nested.fileHashes).length,4);
});
test('reject plain directory and repository child mistaken for root',async()=>{
  const f=await fixture(),opts={manifestBase:f.root,tempRoot:f.root};
  await rejectsCode(()=>acquire({...f.source,path:'repo with spaces/resources'},opts),'source.repository-root');
  await mkdir(path.join(f.root,'plain'));
  await rejectsCode(()=>acquire({...f.source,path:'plain'},opts),'source.git-failed');
});
test('replacement refs do not change committed bytes',async()=>{
  const f=await fixture(),sha=git(f.repo,['rev-parse','HEAD']);
  await writeFile(path.join(f.repo,'resources/process.md'),'wrong');
  git(f.repo,['add','--all']);git(f.repo,['commit','-m','other']);
  const other=git(f.repo,['rev-parse','HEAD']);
  git(f.repo,['replace',sha,other]);
  const a=await acquire({...f.source,ref:sha},{manifestBase:f.root,tempRoot:f.root});
  assert.equal((await readFile(path.join(a.snapshotPath,'resources/process.md'))).toString(),'# Rules\n');
});
for(const ref of ['-x','main:evil','foo/./bar','foo.lock','main.','refs/heads/.hidden','a..b','HEAD~1','refs/remotes/origin/main'])
  test('reject ref '+ref,()=>assert.throws(()=>validateSource({type:'git',transport:'local',path:'../repo',subdirectory:'.',ref})));
for(const url of ['https://user:token@host/repo','ssh://-x@host/repo','ssh://git@-host/repo',
  'https://host:0/repo','https://host:65536/repo','https://host/repo%00','https://host/repo%2500',
  'https://host/repo\\x','https://host/repo?token=secret','https://host/repo%2f..%2frepo%0a'])
  test('reject URL '+url,()=>assert.throws(()=>validateSource({type:'git',transport:'remote',url,ref:'main',subdirectory:'.'})));
test('remote explicit opt-in required without contact',async()=>{
  await rejectsCode(()=>acquire({type:'git',transport:'remote',url:'https://example.invalid/repo',ref:'main',subdirectory:'.'},
    {manifestBase:tmpdir()}),'source.network-required');
});
test('argv retains literal source-looking strings, no shell',()=>{
  const p=path.resolve(tmpdir(),'space $(literal)');
  const args=gitArgs(p,['cat-file','blob',h]);
  assert.equal(args[args.indexOf('-C')+1],p);
  assert.deepEqual(args.slice(-3),['cat-file','blob',h]);
});
test('inventory valid package and exact content digest',async()=>{
  const f=contents(),v=await verify(f);
  assert.equal(v.inventoryDigest,sha256(f.get('inventory.json')));
  assert.equal(v.files.size,4);
});
for(const [name,edit,code]of [
  ['hash', f=>f.set('skills/example/SKILL.md',Buffer.from('wrong')), 'inventory.hash'],
  ['extra', f=>f.set('extra',Buffer.from('extra')), 'inventory.files'],
  ['missing', f=>f.delete('skills/example/SKILL.md'), 'inventory.files'],
  ['lfs', f=>f.set('resources/process.md',Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1\n')), 'source.lfs']
])test('inventory rejects '+name,async()=>{const f=contents();edit(f);await rejectsCode(()=>verify(f),code);});
test('strict UTF8 manifest',async()=>{
  const f=contents();f.set('pipeline.json',Buffer.from([0xff]));await rejectsCode(()=>verify(f),'source.utf8');
});
for(const mode of ['120000','160000','040000'])
  test('reject Git mode '+mode,()=>assert.throws(()=>checkEntries([{path:'x',type:mode==='160000'?'commit':'blob',mode,oid:h,size:0}]),e=>e.code==='source.entry-type'));
for(const names of [['A/x','a/y'],['x','x/y'],['x','x'],['CON'],['x.'],['x '],['../x'],['.git/config']])
  test('hostile names '+names.join(','),()=>assert.throws(()=>checkEntries(names.map(p=>({path:p,mode:'100644',type:'blob',oid:h,size:0})))));
test('numeric caps at and over (no giant allocation)',()=>{
  for(const [key,limit]of Object.entries(LIMITS)) {
    cap(limit,limit,'cap.'+key); assert.throws(()=>cap(limit+1,limit,'cap.'+key));
  }
  const e={path:'x',type:'blob',mode:'100644',oid:h,size:LIMITS.blob};
  checkEntries([e]);assert.throws(()=>checkEntries([{...e,size:LIMITS.blob+1}]));
  const total=Array.from({length:16},(_,i)=>({...e,path:'f'+i}));checkEntries(total);
  assert.throws(()=>checkEntries([...total,{...e,path:'more',size:1}]));
  const count=Array.from({length:LIMITS.files},(_,i)=>({...e,path:'f'+i,size:0}));checkEntries(count);
  assert.throws(()=>checkEntries([...count,{...e,path:'extra',size:0}]));
});
test('path budgets at/over both platforms',()=>{
  checkDestination('a'.repeat(240),'win32');assert.throws(()=>checkDestination('a'.repeat(241),'win32'));
  checkDestination('a'.repeat(1024),'linux');assert.throws(()=>checkDestination('a'.repeat(1025),'linux'));
});
test('Git output and deadline caps',async()=>{
  const f=await fixture();
  await rejectsCode(()=>runGit(f.repo,['--version'],{outputLimit:1}),'source.output');
  await rejectsCode(()=>runGit(f.repo,['--version'],{deadline:performance.now()-1}),'source.timeout');
  const storage=path.join(f.root,'capped-objects');await mkdir(storage);
  await writeFile(path.join(storage,'pack'),Buffer.alloc(65));
  await runGit(f.repo,['--version'],{objects:storage,packLimit:65});
  await rejectsCode(()=>runGit(f.repo,['--version'],{objects:storage,packLimit:64}),'source.pack');
  await rejectsCode(()=>runGit(f.repo,['--version'],{packLimit:LIMITS.pack+1}),'source.pack-limit');
});
test('tree output is NUL framed and parser preserves exact paths',()=>{
  const b=Buffer.from('100644 blob '+h+'      2\tx y\0');
  assert.equal(parseListing(b)[0].path,'x y');
  assert.throws(()=>parseListing(Buffer.from('incomplete')));
});
// Live HTTPS/SSH smoke is opt-in and not part of offline npm test.

for (const mode of ['120000','160000']) test('actual Git tree rejects special mode '+mode,async()=>{
  const f=await fixture();
  const object=git(f.repo,['rev-parse',mode==='160000'?'HEAD':'HEAD:resources/process.md']);
  git(f.repo,['update-index','--add','--cacheinfo',mode+','+object+',special']);
  git(f.repo,['commit','-m','special entry']);
  await rejectsCode(()=>acquire(f.source,{manifestBase:f.root,tempRoot:f.root}),'source.entry-type');
});

test('synthetic SSH transport exercises remote acquisition without account or network',async()=>{
  const f=await fixture(), bare=path.join(f.root,'remote.git');
  git(f.root,['clone','--bare','--no-hardlinks',f.repo,bare]);
  const helper=path.join(f.root,'ssh-fixture.cjs');
  await writeFile(helper, "const {spawn}=require('node:child_process');" +
    "if(process.argv.includes('-G'))process.exit(1);" +
    "const c=spawn('git',['-c','core.hooksPath=/dev/null','upload-pack'," + JSON.stringify(bare) +
    "],{stdio:'inherit',windowsHide:true,shell:false});c.on('error',()=>process.exit(1));c.on('exit',n=>process.exit(n??1));");
  const previous=process.env.GIT_SSH_COMMAND;
  process.env.GIT_SSH_COMMAND='"'+process.execPath.replaceAll('\\','/')+'" "'+helper.replaceAll('\\','/')+'"';
  try {
    const source={type:'git',transport:'remote',url:'ssh://git@fixture.invalid/repo',ref:'main',subdirectory:'.'};
    const a=await acquire(source,{manifestBase:f.root,tempRoot:f.root,network:true});
    assert.equal(a.commit,git(f.repo,['rev-parse','HEAD']));
    assert.equal((await readFile(path.join(a.snapshotPath,'resources/process.md'))).toString(),'# Rules\n');
    assert.equal(a.resolvedSource,source.url);
    // The fetch really produces Git objects; this is not a pre-created fake pack.
    await rejectsCode(()=>acquire(source,{manifestBase:f.root,tempRoot:f.root,network:true,packLimit:1}),'source.pack');
    git(bare,['tag','main']);
    await rejectsCode(()=>acquire(source,{manifestBase:f.root,tempRoot:f.root,network:true}),'source.ambiguous-ref');
    git(bare,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','tag','-a','release','-m','annotated']);
    const tagged=await acquire({...source,ref:'refs/tags/release'},{manifestBase:f.root,tempRoot:f.root,network:true});
    assert.equal(tagged.commit,a.commit);
  } finally {
    if(previous===undefined)delete process.env.GIT_SSH_COMMAND;else process.env.GIT_SSH_COMMAND=previous;
  }
});
test('remote non-tip pin refusal is explicit, tip and allowed parent still work',async()=>{
  const f=await fixture(),parent=git(f.repo,['rev-parse','HEAD']);
  git(f.repo,['commit','--allow-empty','-m','second']);
  const tip=git(f.repo,['rev-parse','HEAD']),bare=path.join(f.root,'pin-remote.git');
  git(f.root,['clone','--bare','--no-hardlinks',f.repo,bare]);
  const helper=path.join(f.root,'pin-ssh.cjs');
  await writeFile(helper,"const {spawn}=require('node:child_process');if(process.argv.includes('-G'))process.exit(1);"+
    "const c=spawn('git',['-c','core.hooksPath=/dev/null','upload-pack',"+JSON.stringify(bare)+"],{stdio:'inherit',windowsHide:true,shell:false});"+
    "c.on('error',()=>process.exit(1));c.on('exit',n=>process.exit(n??1));setTimeout(()=>process.exit(2),15000).unref();");
  const previous=process.env.GIT_SSH_COMMAND;
  process.env.GIT_SSH_COMMAND='"'+process.execPath.replaceAll('\\','/')+'" "'+helper.replaceAll('\\','/')+'"';
  const options={manifestBase:f.root,tempRoot:f.root,network:true};
  const source={type:'git',transport:'remote',url:'ssh://git@fixture.invalid/repo',subdirectory:'.',ref:parent};
  try {
    await rejectsCode(()=>acquire(source,options),'source.unadvertised-commit');
    assert.equal((await acquire({...source,ref:tip},options)).commit,tip);
    assert.equal((await acquire({...source,ref:'main'},options)).commit,tip);
    git(bare,['config','uploadpack.allowAnySHA1InWant','true']);
    assert.equal((await acquire(source,options)).commit,parent);
  } finally {if(previous===undefined)delete process.env.GIT_SSH_COMMAND;else process.env.GIT_SSH_COMMAND=previous;}
});
test('opt-in remote pipeline smoke',{skip:!process.env.WPC_S2_SMOKE_URL},async()=>{
  const result=await acquire({type:'git',transport:'remote',url:process.env.WPC_S2_SMOKE_URL,
    ref:process.env.WPC_S2_SMOKE_REF??'HEAD',subdirectory:process.env.WPC_S2_SMOKE_SUBDIRECTORY??'.'},
    {manifestBase:tmpdir(),network:true});
  assert.ok(result.commit);assert.ok(result.digest);
});
