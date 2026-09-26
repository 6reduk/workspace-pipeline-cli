import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {acquireGlobalSettings} from '../src/desired-state/global-settings.js';
const ops=[{target:'grok.user',pointer:'/compat/claude/skills',operation:'set',value:true}];
async function home(t) {
  const userHome=await mkdtemp(path.join(os.tmpdir(),'wpc-global-settings-'));
  t.after(()=>rm(userHome,{recursive:true,force:true}));
  await mkdir(path.join(userHome,'.grok'));
  await writeFile(path.join(userHome,'.grok/config.toml'),'# keep\nmodel = "mine"\n[compat.claude]\nskills = false\n');
  return userHome;
}
test('global edit preserves model and comments, defaults to no backup, lock released',async t=>{
  const userHome=await home(t),lease=await acquireGlobalSettings(ops,{userHome});
  try{await lease.apply();}finally{await lease.release();}
  const text=await readFile(path.join(userHome,'.grok/config.toml'),'utf8');
  assert.match(text,/# keep\nmodel = "mine"/);assert.match(text,/skills = true/);
  assert.deepEqual(await readdir(path.join(userHome,'.grok')),['config.toml']);
});
test('global backup stays in user profile and matches original bytes',async t=>{
  const userHome=await home(t),before=await readFile(path.join(userHome,'.grok/config.toml'));
  const lease=await acquireGlobalSettings(ops,{userHome});
  try {
    const backup=await lease.backup();await lease.apply();
    assert.ok(backup.startsWith(path.join(userHome,'.grok')));
    assert.deepEqual(await readFile(path.join(backup,'config.toml')),before);
  }finally{await lease.release();}
});
test('profile lock refuses a second workspace installer',async t=>{
  const userHome=await home(t),lease=await acquireGlobalSettings(ops,{userHome});
  try{await assert.rejects(acquireGlobalSettings(ops,{userHome}),e=>e.code==='desired.profile-busy');}
  finally{await lease.release();}
});
test('concurrent config change is not overwritten',async t=>{
  const userHome=await home(t),lease=await acquireGlobalSettings(ops,{userHome});
  try{
    await writeFile(lease.path,'model = "edited"\n');
    await assert.rejects(lease.apply(),e=>e.code==='desired.global-config-changed');
    assert.equal(await readFile(lease.path,'utf8'),'model = "edited"\n');
  }finally{await lease.release();}
});
