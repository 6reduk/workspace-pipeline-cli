import test from 'node:test';
import assert from 'node:assert/strict';
import {retiredSkillOwnership} from '../src/operations/skill-retirement.js';
import {restoreRetired,planObservationPaths} from '../src/operations/bundle-update.js';
import {sha256} from '../src/source/inventory.js';

const bytes=Buffer.from('installed skill');
const skill={owner:'codex',path:'.agents/skills/old/SKILL.md',kind:'file',pointer:null,
  beforeHash:null,managedHash:sha256(bytes),backup:null};
test('only absent native skill files belonging to retained providers retire',()=>{
  const records=[skill,...['AGENTS.md','.codex/config.toml','.agents/skills/old/user.md',
    '.agents/skills/old/nested/SKILL.md','.agents/skills/../SKILL.md'].map(path=>({...skill,path})),
    {...skill,path:'.claude/skills/old/SKILL.md',owner:'claude'},
    {...skill,kind:'field',pointer:'/x'}, {...skill,owner:'shared'}];
  const previous={active:{owned:records}},selection={providers:['codex']};
  assert.deepEqual(retiredSkillOwnership(previous,selection,[]),[skill]);
  assert.deepEqual(retiredSkillOwnership(previous,selection,[{path:skill.path}]),[]);
  assert.deepEqual(retiredSkillOwnership(previous,{providers:[]},[]),[]);
  assert.deepEqual(retiredSkillOwnership(null,selection,[]),[]);
});
test('retiring skill is observed, deletes exact managed bytes, restores takeover backup',()=>{
  const previous={active:{owned:[skill]}},selection={providers:['codex']};
  assert.deepEqual(planObservationPaths([],previous,selection),[skill.path]);
  const observed=new Map([[skill.path,bytes]]);
  assert.equal(restoreRetired([skill],observed)[0].action,'delete');
  observed.set(skill.path,Buffer.from('user customization'));
  assert.throws(()=>restoreRetired([skill],observed),e=>e.code==='ownership.drift');
  observed.set(skill.path,null);
  assert.throws(()=>restoreRetired([skill],observed),e=>e.code==='bundle.retirement-missing');
  const original=Buffer.from('before takeover'),backup='.pipeline/backups/original.bin';
  const taken={...skill,beforeHash:sha256(original),backup};
  observed.set(skill.path,bytes);observed.set(backup,original);
  assert.deepEqual(restoreRetired([taken],observed)[0].bytes,original);
  observed.set(backup,Buffer.from('bad backup'));
  assert.throws(()=>restoreRetired([taken],observed),e=>e.code==='bundle.backup-mismatch');
});
