import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {initialDescriptor,desiredArguments} from '../src/commands/desired-setup.js';
import {formatResult} from '../src/commands/output.js';

test('store diagnostics retain repository path and recovery hint in human output',()=>{
  const diagnostic={code:'openspec.store-config-conflict',repository:'a',subject:'services/a/openspec/config.yaml',hint:'Inspect the file; repeat the same operation.'};
  const text=formatResult({ready:false,status:'not-ready',diagnostics:[diagnostic]});
  assert.match(text,/\[a\]/);assert.match(text,/services\/a\/openspec\/config.yaml/);assert.match(text,/repeat the same operation/);
});

test('public setup distinguishes separate documentation repository without changing single-repo role',()=>{
  const workspace=path.resolve('fixture'),source=path.join(workspace,'source');
  const base=['setup','--source',source,'--adapters','both'];
  const single=initialDescriptor(workspace,desiredArguments(base));
  assert.equal(single.layout.repositories.game.role,'code');
  const multi=initialDescriptor(workspace,desiredArguments([...base,'--repository','docs=sevenpay/docs/analytics','--repository','api=sevenpay/backend/api','--documentation','docs=docs']));
  assert.equal(multi.layout.repositories.docs.role,'documentation');
  assert.equal(multi.layout.repositories.api.role,'code');
});

test('doctor displays store bindings and escapes control characters without claiming execution',()=>{
  const text=formatResult({ready:true,status:'ready',workspace:'fixture',diagnostics:[],openspec:{version:'1.14.1',status:'ready',store:{id:'test',repository:'docs',root:'docs',bindings:[{repository:'api',path:'api/openspec/config.yaml',ownership:'owned'},{repository:'foreign\n',path:'foreign/openspec/config.yaml',ownership:'borrowed'}]}}});
  assert.match(text,/OpenSpec store: test/);assert.match(text,/borrowed/);assert.match(text,/foreign\\u000a/);
  assert.match(text,/do not approve tasks/);assert.match(text,/not verified by doctor/);
});
