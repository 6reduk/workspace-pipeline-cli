import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp,readFile,writeFile } from 'node:fs/promises';
import { contractDigest } from '../src/contracts/semantic.js';
import { acquireWorkspaceLock } from '../src/operations/lock.js';
import { createRepositoryJournal,readRepositoryJournal } from '../src/operations/repository-journal.js';

async function fixture() {
  const workspace=await mkdtemp(path.join(tmpdir(),'wpc-s7-journal-')),lock=await acquireWorkspaceLock(workspace);
  const body={kind:'repository-preview-candidate',wrapper:workspace,status:'review-only',blockers:[],
    operations:[{repository:'a',action:'init',target:path.join(workspace,'a')},{repository:'b',action:'move',from:path.join(tmpdir(),'synthetic-source'),target:path.join(workspace,'b')}]};
  return {workspace,lock,preview:{...body,digest:contractDigest(body)}};
}
test('S7 journal binds ordered operations and completed evidence without claiming verification',async()=>{
  const {workspace,lock,preview}=await fixture(),journal=await createRepositoryJournal(lock,preview);
  const evidence=contractDigest({synthetic:'observation'});
  await journal.intent('a');await journal.outcome('completed',evidence);await journal.intent('b');
  const terminal=await journal.outcome('completed',evidence);
  assert.equal(terminal.phase,'terminal');assert.equal(terminal.evidenceVerified,false);
  assert.deepEqual(terminal.operations.map(o=>o.status),['completed','completed']);
  assert.deepEqual(await readRepositoryJournal(workspace,journal.relative,preview),terminal);await lock.release();
});
test('S7 intent without outcome reads as uncertain and remaining operation skipped',async()=>{
  const {workspace,lock,preview}=await fixture(),journal=await createRepositoryJournal(lock,preview);
  await journal.intent('a');const read=await readRepositoryJournal(workspace,journal.relative,preview);
  assert.equal(read.phase,'interrupted');assert.deepEqual(read.operations.map(o=>o.status),['uncertain','skipped']);await lock.release();
});
test('S7 failed outcome stops remaining operations and wrong order fails',async()=>{
  const {workspace,lock,preview}=await fixture(),journal=await createRepositoryJournal(lock,preview);
  await journal.intent('a');await journal.outcome('failed',contractDigest({before:true}));
  await assert.rejects(journal.intent('b'),e=>e.code==='repository-journal.sequence');
  assert.deepEqual((await readRepositoryJournal(workspace,journal.relative,preview)).operations.map(o=>o.status),['failed','skipped']);await lock.release();
});
test('S7 journal rejects changed preview and altered chain',async()=>{
  const {workspace,lock,preview}=await fixture(),journal=await createRepositoryJournal(lock,preview);
  const wrong=structuredClone(preview);wrong.operations[0].action='move';
  await assert.rejects(readRepositoryJournal(workspace,journal.relative,wrong),e=>e.code==='repository-journal.preview');
  const filename=path.join(journal.directory,'000000.json'),bytes=await readFile(filename);
  await writeFile(filename,bytes.toString().replace('"payload":null','"payload":{}'));
  await assert.rejects(journal.intent('a'),e=>e.code==='repository-journal.drift');await lock.release();
});
test('S7 journal preserves torn append and rejects forged workspace lock',async()=>{
  const {workspace,lock,preview}=await fixture();
  await assert.rejects(createRepositoryJournal({...lock},preview),e=>e.code==='lock.capability');
  let calls=0;
  const journal=await createRepositoryJournal(lock,preview,{ioBoundary:async stage=>{if(stage==='opened' && ++calls===2)throw Error('synthetic crash');}});
  await assert.rejects(journal.intent('a'),e=>e.code==='repository-journal.io');
  await assert.rejects(readRepositoryJournal(workspace,journal.relative,preview),e=>Boolean(e.code));
  assert.equal((await readFile(path.join(journal.directory,'000001.json'))).length,0);await lock.release();
});

test('S7 journal authorization is hash-chained and bound to its own run',async()=>{
  const {workspace,lock,preview}=await fixture(),journal=await createRepositoryJournal(lock,preview);
  const binding={path:journal.relative.replace('/repository-journals/','/repository-authorizations/')+'.json',digest:contractDigest({chain:true})};
  assert.throws(()=>journal.authorize({...binding,path:'.pipeline/repository-authorizations/00000000-0000-0000-0000-000000000000.json'}),
    e=>e.code==='repository-journal.authorization');
  await journal.authorize(binding);
  await journal.intent('a');await journal.outcome('completed',contractDigest({evidence:true}));
  const read=await readRepositoryJournal(workspace,journal.relative,preview);
  assert.equal(contractDigest(read.authorization),contractDigest(binding));assert.equal(read.evidenceVerified,false);
  await lock.release();
});

test('S7 journal authorization cannot be inserted after an operation intent',async()=>{
  const {lock,preview}=await fixture(),journal=await createRepositoryJournal(lock,preview);
  await journal.intent('a');
  await assert.rejects(journal.authorize({path:journal.relative.replace('/repository-journals/','/repository-authorizations/')+'.json',
    digest:contractDigest({late:true})}),e=>e.code==='repository-journal.authorization');
  await lock.release();
});
