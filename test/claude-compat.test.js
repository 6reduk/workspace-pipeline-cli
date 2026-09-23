import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,readdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {enableClaudeCompat,createClaudeCompatibility,compatKeys} from '../src/compat/claude.js';
import {bindCompatibility,unwrapCompatibility,finishCompatibility,doctorCompatibility} from '../src/compat/lifecycle.js';
import {parseCompat,runCompat} from '../src/commands/compat.js';
const buffer=s=>Buffer.from(s);
test('TOML: retains exactly one UTF-8 BOM on edit and on no-op',async()=>{
  for(const text of ['[models]\ndefault="x"\n','# comment\r\n','[compat.claude]\nskills=false\n','']){
    const expected=enableClaudeCompat(buffer(text)).bytes;
    const output=enableClaudeCompat(buffer('\uFEFF'+text));
    assert.deepEqual(output.bytes,Buffer.concat([buffer('\uFEFF'),expected]));
    assert.deepEqual(enableClaudeCompat(output.bytes).bytes,output.bytes);
    assert.deepEqual(enableClaudeCompat(output.bytes).changes,[]);
  }
  const f=await fixture('\uFEFF# личный config\r\n'),before=await readFile(path.join(f.profile,'config.toml'));
  const result=await f.service.apply(await f.service.inspect());
  assert.deepEqual(await readFile(path.join(result.backupDir,'config.before.toml')),before);
  assert.deepEqual(await readFile(path.join(f.profile,'config.toml')),enableClaudeCompat(before).bytes);
});
test('TOML: preserves unrelated bytes/comments/newlines and is idempotent',()=>{
  const inputs=['','# note\r\n[models]\r\ndefault="personal"\r\n',
    '[compat.claude] # keep\nskills=false # comment\nsessions=false\n[models]\ndefault="x"\n',
    'compat.claude.skills=false\n[models]\ndefault="x"\n',
    '[compat]\nclaude.skills=false\n','[compat.claude]',
    '[compat.claude]\n'+compatKeys.map(k=>`${k}=false`).join('\n')];
  for(const input of inputs){const output=enableClaudeCompat(buffer(input));assert.deepEqual(enableClaudeCompat(output.bytes).changes,[]);assert.deepEqual(enableClaudeCompat(output.bytes).bytes,output.bytes);
    if(input.includes('# comment'))assert.ok(output.bytes.toString().includes('skills=true # comment\nsessions=false'));
    if(input.includes('[models]'))assert.ok(output.bytes.toString().endsWith(input.slice(input.indexOf('[models]'))));
  }
});
test('TOML: rejects invalid types, duplicate keys, imported marker and inline rewrite',()=>{
  for(const input of ['[compat.claude]\nskills="false"','[compat.claude]\nskills=false\nskills=true','[claude_compat]\nimported=true','compat={claude={skills=false}}','compat=false'])assert.throws(()=>enableClaudeCompat(buffer(input)),/grok-compat/);
});
async function fixture(config='[models]\ndefault="personal"\n'){
  const home=await mkdtemp(path.join(tmpdir(),'wpc-compat-unit-')),profile=path.join(home,'.grok');
  await mkdir(profile);if(config!==null)await writeFile(path.join(profile,'config.toml'),config);
  const env={HOME:home,USERPROFILE:home,GROK_HOME:profile,PATH:''};
  return {home,profile,env,service:createClaudeCompatibility({env,home})};
}
test('global preview is read-only; apply backs up, enables only fields, retains foreign bytes',async()=>{
  const f=await fixture(),before=await readFile(path.join(f.profile,'config.toml'));
  const p=await f.service.inspect();assert.equal(p.status,'needs-apply');assert.deepEqual(await readdir(f.profile),['config.toml']);
  assert.ok(!JSON.stringify(p).includes('personal'));
  const r=await f.service.apply(p);assert.equal(r.status,'configured');assert.deepEqual(await readFile(path.join(r.backupDir,'config.before.toml')),before);
  const output=await readFile(path.join(f.profile,'config.toml'));assert.ok(output.toString().endsWith(before.toString()));
  const next=await f.service.inspect();assert.equal(next.status,'configured');assert.equal((await f.service.apply(next)).changed,false);
  assert.equal((await readdir(path.join(f.profile,'workspace-pipeline-backups'))).length,1);
});
test('absent config within detected profile is created, absent Grok profile is skipped',async()=>{
  const f=await fixture(null);assert.equal((await f.service.apply(await f.service.inspect())).changed,true);
  const home=await mkdtemp(path.join(tmpdir(),'wpc-no-grok-'));const s=createClaudeCompatibility({home,env:{HOME:home,USERPROFILE:home,PATH:''}});
  assert.equal((await s.apply(await s.inspect())).status,'not-present');assert.deepEqual(await readdir(home),[]);
});
test('stale preview, profile change, policy, environment and lock fail closed',async()=>{
  const f=await fixture(),p=await f.service.inspect();await writeFile(path.join(f.profile,'config.toml'),'# another edit\n');
  await assert.rejects(f.service.apply(p),/preview-drift/);assert.deepEqual(await readdir(f.profile),['config.toml']);
  f.env.GROK_CLAUDE_SKILLS_ENABLED='false';assert.equal((await f.service.inspect()).status,'blocked');delete f.env.GROK_CLAUDE_SKILLS_ENABLED;
  await writeFile(path.join(f.profile,'requirements.toml'),'');assert.ok((await f.service.inspect()).blockers.includes('policy:requirements.toml'));
});
test('symlinked profile refused without writing',async t=>{
  const f=await fixture(),link=path.join(f.home,'linked');try{await symlink(f.profile,link,process.platform==='win32'?'junction':'dir');}catch(e){if(['EPERM','EACCES'].includes(e.code)){t.skip('symlink privilege unavailable');return;}throw e;}
  const service=createClaudeCompatibility({env:{GROK_HOME:link},home:f.home});await assert.rejects(service.inspect(),/grok-compat.path/);
});
test('envelope binding requires new approval, no implicit global write for old previews',async()=>{
  const f=await fixture(),p={preview:{plan:{desired:{providers:['claude']}}},digest:'workspace-digest'};
  await assert.rejects(unwrapCompatibility(p,f.service),/preview-required/);
  const bound=await bindCompatibility(p,f.service);assert.deepEqual((await unwrapCompatibility(bound,f.service)).prepared,p);
  const forged=structuredClone(bound);forged.compatibility.path+='other';await assert.rejects(unwrapCompatibility(forged,f.service),/envelope/);
  const legacy={preview:{plan:{desired:{providers:['claude','grok']}}}};assert.equal(await bindCompatibility(legacy,f.service),legacy);
});
test('global failure is distinct from committed workspace; doctor stays false',async()=>{
  const f=await fixture(),requirement=await f.service.inspect();
  const result={status:'ready',lockRelease:'released'};await writeFile(path.join(f.profile,'config.toml'),'# external edit\n');
  const failed=await finishCompatibility(result,requirement,f.service);assert.equal(failed.status,'needs-compatibility');assert.equal(failed.workspaceStatus,'ready');
  const doctor=await doctorCompatibility({ready:true,status:'ready',pipeline:{providers:['claude']},diagnostics:[]},f.service);assert.equal(doctor.ready,false);
  assert.equal((await finishCompatibility({status:'failed'},requirement,f.service)).compatibility.status,'not-applied');
});
test('dead-process lock recovery is bound, explicit and does not change config',async()=>{
  const f=await fixture(),child=spawnSync(process.execPath,['-e','process.exit(0)']);assert.equal(child.status,0);
  const lock=path.join(f.profile,'workspace-pipeline-compat.lock'),owner={pid:child.pid,token:'00000000-0000-4000-8000-000000000001',createdAt:new Date().toISOString()};
  await writeFile(lock,JSON.stringify(owner));const before=await readFile(path.join(f.profile,'config.toml'));
  assert.ok((await f.service.inspect()).blockers.includes('global-lock'));
  const preview=await f.service.recovery();assert.equal((await f.service.recover(preview)).status,'lock-released');
  assert.deepEqual(await readFile(path.join(f.profile,'config.toml')),before);
  await writeFile(lock,JSON.stringify({...owner,pid:process.pid}));await assert.rejects(f.service.recovery(),/owner-running/);
});
test('global command preview/apply and native mismatch reporting',async()=>{
  const f=await fixture(),output=[];await runCompat(parseCompat(['compat','claude','--json']),f.service,v=>output.push(v));
  const preview=path.join(f.home,'preview.json');await writeFile(preview,output[0]);
  assert.equal(await runCompat(parseCompat(['compat','claude','--apply','--preview',preview]),f.service,v=>output.push(v)),0);
  const service={...f.service,verify:async()=>({status:'blocked'})};
  const result=await doctorCompatibility({workspace:f.home,ready:true,status:'ready',pipeline:{providers:['claude']},diagnostics:[]},service);
  assert.equal(result.ready,false);assert.equal(result.diagnostics[0].code,'grok-compat.native-mismatch');
  assert.throws(()=>parseCompat(['compat','claude','--apply']),/cli.arguments/);
});
