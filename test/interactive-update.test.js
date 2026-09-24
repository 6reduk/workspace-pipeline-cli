import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import {runInteractiveUpdate,updateSummary} from '../src/commands/interactive-update.js';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const args=['update','--workspace',path.join(tmpdir(),'interactive-fixture')];
const saved={kind:'prepared-with-claude-compatibility',workspace:{preview:{plan:{workspace:args[2],desired:{pipelineId:'sample',version:'1',providers:['claude']},targets:[{action:'delete',path:'old.md'}]}}},compatibility:{status:'needs-apply',path:'global.toml',changes:['skills'],warning:'Affects all workspaces'}};
async function scenario(argv=args,{tty=true,answer=true,previewCode=0,applyCode=0,plan=saved}={}){
  const calls=[],out=[],shown=[];let questions=0,file;
  const options={stdout:async x=>out.push(x),stderr:async()=>{}};
  const execute=async(a,o)=>{calls.push(a);if(a.includes('--apply')){file=a.at(-1);assert.deepEqual(JSON.parse(await readFile(file,'utf8')),plan);return applyCode;}await o.stdout(JSON.stringify(plan));return previewCode;};
  const code=await runInteractiveUpdate(argv,options,{isTTY:tty,display:async x=>shown.push(x),confirm:async()=>{questions++;return answer;},execute});
  if(file)await assert.rejects(access(file));
  return {code,calls,out,shown,questions};
}
test('human confirmation applies the same saved bytes; rejects/default no do not apply',async()=>{
  const yes=await scenario();assert.equal(yes.code,0);assert.equal(yes.calls.length,2);assert.equal(yes.questions,1);
  for(const answer of [false,undefined,null]){const r=await scenario(args,{answer:answer??null});assert.equal(r.calls.length,1);assert.equal(JSON.parse(r.out[0]).applied,false);}
});
test('non-TTY refuses before preparation; yes explicitly authorizes without a prompt',async()=>{
  const no=await scenario(args,{tty:false});assert.equal(no.code,2);assert.equal(no.calls.length,0);
  const yes=await scenario([...args,'--yes','--json'],{tty:false});assert.equal(yes.calls.length,2);assert.equal(yes.questions,0);assert.match(yes.shown[0],/Affects all workspaces/);
});
test('preview/json remain read-only and incompatible flags refuse',async()=>{
  for(const flags of [['--preview'],['--preview','--json'],['--json']]){const r=await scenario([...args,...flags],{tty:false});assert.equal(r.calls.length,1);assert.equal(r.questions,0);assert.equal(r.shown.length,0);}
  for(const flags of [['--yes','--preview'],['--yes','--yes']])assert.equal((await scenario([...args,...flags])).code,2);
});
test('preparation failure and blocked global prerequisite never prompt/apply; apply failure preserved',async()=>{
  const failed=await scenario(args,{previewCode:1});assert.equal(failed.code,1);assert.equal(failed.calls.length,1);
  const blocked=structuredClone(saved);blocked.compatibility.status='blocked';
  const b=await scenario(args,{plan:blocked});assert.equal(b.code,1);assert.equal(b.questions,0);assert.equal(b.calls.length,1);
  assert.equal((await scenario(args,{applyCode:1})).code,1);
});
test('summary lists every target, escapes terminal controls and omits payload',()=>{
  const p=structuredClone(saved);p.workspace.preview.plan.targets=Array.from({length:70},(_,i)=>({action:'replace',path:`skill-${i}`,bytes:'SECRET'}));
  p.compatibility.warning='a\u001b[31m';const s=updateSummary(p);assert.match(s,/skill-69/);assert.ok(!s.includes('SECRET'));assert.ok(!s.includes('\u001b'));
});
test('real executable non-TTY update exits 2 before touching an absent workspace',()=>{
  const r=spawnSync(process.execPath,[fileURLToPath(new URL('../src/cli.js',import.meta.url)),...args],{encoding:'utf8',windowsHide:true});
  assert.equal(r.status,2);assert.match(r.stdout,/cli.confirmation-required/);
});
test('consent summary escapes bidi controls in paths and global warnings without changing plan',()=>{
  const chars='\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069';
  const p=structuredClone(saved);p.workspace.preview.plan.targets[0].path=chars;
  p.workspace.preview.plan.workspace=chars;p.compatibility.path=chars;p.compatibility.warning=chars;
  const before=JSON.stringify(p),text=updateSummary(p);
  for(const c of chars){assert.ok(!text.includes(c));assert.ok(text.includes('\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')));}
  assert.equal(JSON.stringify(p),before);
});
test('empty failed preview stdout is not replayed; failure status preserved',async()=>{
  const output=[];let displayed=false;
  const code=await runInteractiveUpdate(args,{stdout:async s=>output.push(s)},
    {isTTY:true,confirm:async()=>true,display:async()=>{displayed=true;},execute:async()=>2});
  assert.equal(code,2);assert.deepEqual(output,[]);assert.equal(displayed,false);
});
