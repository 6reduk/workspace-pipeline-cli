import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile,readFile,readdir,rename} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

// Invoked by test:packed after an offline tarball installation. Public commands
// use only the installed package entrypoint. Fault injection also imports that
// installed package (not working-tree code), explicitly recorded below.
export async function verifyPackedRepositories({root,installed,cli,report}) {
  const base=path.join(root,'repositories');await mkdir(base);
  const sha=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
  const git=(cwd,args)=>execFileSync('git',['-c','core.hooksPath=',...args],{
    cwd,encoding:'utf8',windowsHide:true,timeout:30000,stdio:['ignore','pipe','pipe'],
    env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_TERMINAL_PROMPT:'0'}}).trim();
  const invoke=(args,expected=0)=>{
    let out,err='',code=0;
    try{out=execFileSync(process.execPath,[cli,...args,...(args.includes('--json')?[]:['--json'])],{cwd:base,encoding:'utf8',windowsHide:true,
      timeout:120000,maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe']});}
    catch(e){code=e.status;out=e.stdout;err=e.stderr;}
    assert.equal(code,expected,JSON.stringify({args,code,stderr:String(err)}));
    return {text:out,value:out?JSON.parse(out):null,err};
  };
  const save=async(file,text)=>{await writeFile(file,text);return file;};
  const absent=async p=>assert.rejects(readdir(p),e=>e.code==='ENOENT');
  const pipeline={schemaVersion:1,id:'packed-fixture',version:'1.0.0',resources:'resources',inventory:'inventory.json',
    agentsDocument:{mode:'default'},providers:{codex:{skills:'skills',agents:null,mcp:null,entryInstructions:null,requires:[]}}};
  let sequence=0;
  async function fixture(action='directory',existing=false) {
    const directory=path.join(base,String(++sequence)),source=path.join(directory,'pipeline'),wrapper=path.join(directory,'wrapper');
    await mkdir(source,{recursive:true});if(existing)await mkdir(wrapper);
    const files={'pipeline.json':JSON.stringify(pipeline),'resources/process.md':'synthetic rules','skills/check/SKILL.md':'synthetic skill'};
    for(const [name,bytes] of Object.entries(files)){await mkdir(path.dirname(path.join(source,name)),{recursive:true});await writeFile(path.join(source,name),bytes);}
    await writeFile(path.join(source,'inventory.json'),JSON.stringify(Object.fromEntries(Object.entries(files).map(([p,b])=>[p,sha(b)]))));
    git(source,['init','--template=','--initial-branch=main']);git(source,['add','.']);
    git(source,['-c','user.name=Packed','-c','user.email=packed@example.invalid','commit','-m','synthetic']);
    const workspace={schemaVersion:1,pipeline:{type:'git',transport:'local',path:'pipeline',ref:'main',subdirectory:'.'},providers:['codex'],
      layout:{kind:'single-repo',repositories:{game:{path:'project',role:'code'}},documentation:{repository:'game',path:'docs'}}};
    const manifest=await save(path.join(directory,'workspace.json'),JSON.stringify(workspace));
    const choices=await save(path.join(directory,'choices.json'),JSON.stringify({game:{action}}));
    return {directory,source,wrapper,manifest,choices,workspace,preview:path.join(directory,'preview.json')};
  }
  async function preview(f,verb='init',expected=0){const r=invoke([verb,'--workspace',f.wrapper,'--manifest',f.manifest,'--choices',f.choices],expected);await save(f.preview,r.text);return r.value;}
  // Apply currently re-resolves the manifest's local source identity. Confirm
  // unavailable source fails closed; retained-input recovery below is offline.
  const empty=await fixture();await preview(empty);await absent(empty.wrapper);
  await rename(empty.source,empty.source+'-offline');
  const unavailable=invoke(['init','--workspace',empty.wrapper,'--apply','--preview',empty.preview],2);
  assert.match(String(unavailable.err),/source.missing-repository/);await absent(empty.wrapper);
  await rename(empty.source+'-offline',empty.source);
  const initialized=invoke(['init','--workspace',empty.wrapper,'--apply','--preview',empty.preview]).value;
  assert.equal(initialized.status,'repositories-prepared');assert.equal(initialized.pipelineActivated,false);
  assert.deepEqual(await readdir(path.join(empty.wrapper,'project')),[]);
  assert.equal(invoke(['repositories','status','--workspace',empty.wrapper]).value.status,'no-pending-marker');
  report.checks.push({name:'packed-init-source-unavailable-refused-without-effects-then-restored',providerActivated:false});
  const moved=await fixture(),original=path.join(moved.directory,'original');await mkdir(original);
  git(original,['init','--template=']);await writeFile(path.join(original,'tracked.txt'),'base');git(original,['add','.']);
  git(original,['-c','user.name=Packed','-c','user.email=packed@example.invalid','commit','-m','base']);
  git(original,['remote','add','origin','https://example.invalid/never-contacted.git']);
  await writeFile(path.join(original,'tracked.txt'),'dirty tracked');await writeFile(path.join(original,'untracked.txt'),'untracked');
  const before={head:git(original,['rev-parse','HEAD']),status:git(original,['status','--porcelain=v1']),origin:git(original,['remote','get-url','origin'])};
  await save(moved.choices,JSON.stringify({game:{action:'move',from:original}}));await preview(moved,'wrap');
  invoke(['wrap','--workspace',moved.wrapper,'--apply','--preview',moved.preview]);const target=path.join(moved.wrapper,'project');
  assert.equal(await readFile(path.join(target,'tracked.txt'),'utf8'),'dirty tracked');
  assert.equal(await readFile(path.join(target,'untracked.txt'),'utf8'),'untracked');
  assert.deepEqual({head:git(target,['rev-parse','HEAD']),status:git(target,['status','--porcelain=v1']),origin:git(target,['remote','get-url','origin'])},before);
  await absent(original);report.checks.push({name:'packed-wrap-dirty-untracked-head-origin-preserved'});
  const collision=await fixture('directory',true);await preview(collision,'adopt');
  await mkdir(path.join(collision.wrapper,'project'));await writeFile(path.join(collision.wrapper,'project/foreign.txt'),'foreign');
  invoke(['adopt','--workspace',collision.wrapper,'--apply','--preview',collision.preview],2);
  assert.equal(await readFile(path.join(collision.wrapper,'project/foreign.txt'),'utf8'),'foreign');
  await absent(path.join(collision.wrapper,'.pipeline'));
  report.checks.push({name:'packed-adopt-stale-target-collision-preserves-foreign-files'});
  // Fault setup uses the installed native executor and a real abruptly exited
  // child, because the public CLI intentionally has no crash/test-only flags.
  const recovery=await fixture('directory',true),prepared=await preview(recovery,'adopt');
  const child=`import {readFile} from 'node:fs/promises';
    import {applyRepositoryOperations} from ${JSON.stringify(pathToFileURL(path.join(installed,'src/operations/repository-apply.js')).href)};
    const p=JSON.parse(await readFile(process.argv[1],'utf8'));
    await applyRepositoryOperations({pipeline:${JSON.stringify(pipeline)},workspace:p.origin.manifest,wrapper:p.wrapper,choices:p.choices,options:p.options,
      previewText:JSON.stringify(p.preview),approval:{decision:'approve',previewDigest:p.preview.digest},
      ioBoundary:async phase=>{if(phase==='evidence-persisted')process.exit(73);}});`;
  let stopped;try{execFileSync(process.execPath,['--input-type=module','-e',child,recovery.preview],{cwd:base,windowsHide:true,timeout:120000,stdio:'pipe'});}catch(e){stopped=e.status;}
  assert.equal(stopped,73);
  // The kill point precedes journal outcome: native classification must remain
  // uncertain, not silently finalize or replay an already-created directory.
  const uncertain=invoke(['repositories','status','--workspace',recovery.wrapper],1).value;
  assert.ok(uncertain.blockers.some(b=>b.code==='repositories.effects-unresolved'));
  const blocked=await save(path.join(recovery.directory,'blocked.json'),JSON.stringify(uncertain));
  invoke(['repositories','finalize','--workspace',recovery.wrapper,'--apply','--preview',blocked],2);
  assert.deepEqual(await readdir(path.join(recovery.wrapper,'project')),[]);
  report.checks.push({name:'packed-real-child-crash-uncertain-effects-not-finalized',faultSetup:'installed-native-api',exit:73});
  await writeFile(path.join(recovery.wrapper,'project/partial.txt'),'partial user data');
  const abandonArgs=['repositories','abandon','--workspace',recovery.wrapper];
  const abandon=invoke(abandonArgs),abandonFile=await save(path.join(recovery.directory,'abandon.json'),abandon.text);
  const abandonChild=`import {readFile} from 'node:fs/promises';
    import {applyRepositoryAbandon} from ${JSON.stringify(pathToFileURL(path.join(installed,'src/operations/repository-abandon.js')).href)};
    const p=JSON.parse(await readFile(process.argv[1],'utf8'));
    await applyRepositoryAbandon(p.wrapper,p,{ioBoundary:async phase=>{if(phase==='abandon-moved-0')process.exit(75);}});`;
  let abandonExit;try{execFileSync(process.execPath,['--input-type=module','-e',abandonChild,abandonFile],
    {cwd:base,windowsHide:true,timeout:120000,stdio:'pipe'});}catch(e){abandonExit=e.status;}assert.equal(abandonExit,75);
  const abandonResumeArgs=['repositories','continue-abandon','--workspace',recovery.wrapper,'--attempt',abandon.value.attempt];
  const abandonResume=invoke(abandonResumeArgs),abandonResumeFile=await save(path.join(recovery.directory,'abandon-resume.json'),abandonResume.text);
  const abandoned=invoke([...abandonResumeArgs,'--apply','--preview',abandonResumeFile]).value;
  assert.equal(abandoned.completed,false);assert.equal(abandoned.pipelineActivated,false);
  assert.equal(await readFile(path.join(recovery.wrapper,'project/partial.txt'),'utf8'),'partial user data');
  report.checks.push({name:'packed-public-abandon-continuation-preserves-partial-data-no-completion',faultSetup:'installed-native-api',exit:75});
  // Fully evidenced interruption is produced by retaining normal operation
  // state (without public command auto-finalization), then public finalize runs.
  const clean=await fixture('directory',true);await preview(clean,'adopt');
  const normal=child.replace("if(phase==='evidence-persisted')process.exit(73);",'');
  execFileSync(process.execPath,['--input-type=module','-e',normal,clean.preview],{cwd:base,windowsHide:true,timeout:120000,stdio:'pipe'});
  await rename(clean.source,clean.source+'-offline');
  await writeFile(clean.preview,'user preview no longer available');
  const status=invoke(['repositories','status','--workspace',clean.wrapper]).value;assert.equal(status.status,'review-only');
  const finalizer=`import {readFile} from 'node:fs/promises';
    import {finalizeRepositoryOperations} from ${JSON.stringify(pathToFileURL(path.join(installed,'src/operations/repository-reconcile.js')).href)};
    import {readRepositoryInputs} from ${JSON.stringify(pathToFileURL(path.join(installed,'src/operations/repository-inputs.js')).href)};
    const p=JSON.parse(process.argv[1]),r=p.reconciliation;
    const input=await readRepositoryInputs(p.wrapper,r.journal,r.previewDigest);
    await finalizeRepositoryOperations({wrapper:p.wrapper,previewText:input.previewText,previewDigest:input.previewDigest,
      approval:{decision:'approve',reconciliationDigest:r.digest},ioBoundary:async phase=>{if(phase==='finalization-receipt-verified')process.exit(74);}});`;
  let finalizerExit;try{execFileSync(process.execPath,['--input-type=module','-e',finalizer,JSON.stringify(status)],
    {cwd:base,windowsHide:true,timeout:120000,stdio:'pipe'});}catch(e){finalizerExit=e.status;}
  assert.equal(finalizerExit,74);
  const journalId=path.basename(status.reconciliation.journal);
  const recoverArgs=['repositories','recover-locks','--workspace',clean.wrapper,'--journal',journalId];
  const recoveryPreview=invoke(recoverArgs);
  const recoveryFile=await save(path.join(clean.directory,'recover-locks.json'),recoveryPreview.text);
  assert.equal(invoke([...recoverArgs,'--apply','--preview',recoveryFile]).value.status,'repository-locks-retired');
  const resumed=invoke(['repositories','status','--workspace',clean.wrapper]).value;
  assert.equal(resumed.action,'resume-finalization');
  const ready=await save(path.join(clean.directory,'finalize.json'),JSON.stringify(resumed));
  invoke(['repositories','finalize','--workspace',clean.wrapper,'--apply','--preview',ready]);
  assert.equal(invoke(['repositories','status','--workspace',clean.wrapper]).value.status,'no-pending-marker');
  report.checks.push({name:'packed-public-recover-locks-and-finalize-without-source-or-user-preview',faultSetup:'installed-native-api',exit:74});
  const parentWrapper=path.join(base,'parent-one','parent-two','wrapper');
  const parentArgs=['repositories','prepare-parent','--workspace',parentWrapper],parent=invoke(parentArgs);
  await absent(path.join(base,'parent-one'));
  const parentFile=await save(path.join(base,'parent-preview.json'),parent.text);
  const parentChild=`import {readFile} from 'node:fs/promises';
    import {applyRepositoryAncestors} from ${JSON.stringify(pathToFileURL(path.join(installed,'src/operations/repository-ancestors.js')).href)};
    const p=JSON.parse(await readFile(process.argv[1],'utf8'));
    await applyRepositoryAncestors(p,{ioBoundary:async phase=>{if(phase==='ancestors-projection-retained')process.exit(76);}});`;
  let parentExit;try{execFileSync(process.execPath,['--input-type=module','-e',parentChild,parentFile],
    {cwd:base,windowsHide:true,timeout:120000,stdio:'pipe'});}catch(e){parentExit=e.status;}assert.equal(parentExit,76);
  const parentResume=invoke(['repositories','continue-parent','--workspace',parentWrapper,'--parent-preview',parentFile]);
  const parentResumeFile=await save(path.join(base,'parent-resume.json'),parentResume.text);
  invoke(['repositories','continue-parent','--workspace',parentWrapper,'--apply','--preview',parentResumeFile]);
  assert.deepEqual(await readdir(path.dirname(parentWrapper)),[]);await absent(parentWrapper);
  const directWrapper=path.join(base,'direct-parent','wrapper');
  const direct=invoke(['repositories','prepare-parent','--workspace',directWrapper]);
  const directFile=await save(path.join(base,'direct-parent.json'),direct.text);
  invoke(['repositories','prepare-parent','--workspace',directWrapper,'--apply','--preview',directFile]);
  assert.deepEqual(await readdir(path.dirname(directWrapper)),[]);await absent(directWrapper);
  report.checks.push({name:'packed-public-parent-prepare-apply-and-crash-continuation',faultSetup:'installed-native-api',exit:76});
  const bootstrap=await fixture();await preview(bootstrap);
  const bootstrapChild=`import {readFile} from 'node:fs/promises';
    import {createRepositoryWrapper} from ${JSON.stringify(pathToFileURL(path.join(installed,'src/operations/repository-bootstrap.js')).href)};
    const p=JSON.parse(await readFile(process.argv[1],'utf8'));
    await createRepositoryWrapper({pipeline:${JSON.stringify(pipeline)},workspace:p.origin.manifest,wrapper:p.wrapper,choices:p.choices,options:p.options,
      previewText:JSON.stringify(p.preview),approval:{decision:'approve',previewDigest:p.preview.digest},
      ioBoundary:async phase=>{if(phase==='wrapper-receipt-persisted')process.exit(77);}});`;
  let bootstrapExit;try{execFileSync(process.execPath,['--input-type=module','-e',bootstrapChild,bootstrap.preview],
    {cwd:base,windowsHide:true,timeout:120000,stdio:'pipe'});}catch(e){bootstrapExit=e.status;}assert.equal(bootstrapExit,77);
  await rename(bootstrap.source,bootstrap.source+'-offline');
  const bootstrapRecovery=invoke(['repositories','recover-bootstrap','--workspace',bootstrap.wrapper,'--bootstrap-preview',bootstrap.preview]);
  assert.equal(bootstrapRecovery.value.status,'review-only');
  const bootstrapFile=await save(path.join(bootstrap.directory,'bootstrap-recovery.json'),bootstrapRecovery.text);
  const recovered=invoke(['repositories','recover-bootstrap','--workspace',bootstrap.wrapper,'--apply','--preview',bootstrapFile]).value;
  assert.equal(recovered.status,'bootstrap-recovered');assert.equal(recovered.pipelineActivated,false);
  assert.equal(JSON.parse(await readFile(recovered.receipt,'utf8')).repositoryEffectsPerformed,false);
  assert.deepEqual(await readdir(bootstrap.wrapper),['.pipeline']);await absent(path.join(bootstrap.wrapper,'project'));
  report.checks.push({name:'packed-public-first-bootstrap-recovery-without-source-or-effect-replay',faultSetup:'installed-native-api',exit:77});
  const cleanup=await fixture('directory',true);await preview(cleanup,'adopt');
  const cleanupSeed=`import {readFile} from 'node:fs/promises';
    import {applyRepositoryOperations} from ${JSON.stringify(pathToFileURL(path.join(installed,'src/operations/repository-apply.js')).href)};
    import {inspectRepositoryReconciliation,finalizeRepositoryOperations} from ${JSON.stringify(pathToFileURL(path.join(installed,'src/operations/repository-reconcile.js')).href)};
    const p=JSON.parse(await readFile(process.argv[1],'utf8')),previewText=JSON.stringify(p.preview);
    await applyRepositoryOperations({pipeline:${JSON.stringify(pipeline)},workspace:p.origin.manifest,wrapper:p.wrapper,choices:p.choices,options:p.options,
      previewText,approval:{decision:'approve',previewDigest:p.preview.digest}});
    const r=await inspectRepositoryReconciliation(p.wrapper,previewText,p.preview.digest);
    await finalizeRepositoryOperations({wrapper:p.wrapper,previewText,previewDigest:p.preview.digest,
      approval:{decision:'approve',reconciliationDigest:r.digest}});`;
  execFileSync(process.execPath,['--input-type=module','-e',cleanupSeed,cleanup.preview],
    {cwd:base,windowsHide:true,timeout:120000,stdio:'pipe'});
  const cleanupUser=path.join(cleanup.wrapper,'project/user.txt');await writeFile(cleanupUser,'preserved user bytes');
  const cleanupArgs=['logs','clean','--repositories','--workspace',cleanup.wrapper];
  const cleanupPreview=invoke([...cleanupArgs,'--max-age-days','0','--keep-last','0','--max-delete','1']);
  assert.equal(cleanupPreview.value.retention.selected.length,1);
  const cleanupGroup=cleanupPreview.value.groups.find(g=>g.id===cleanupPreview.value.retention.selected[0].id);
  const cleanupTarget=cleanupGroup.files[0].path;
  const cleanupBefore=new Map(await Promise.all(cleanupGroup.files.map(async f=>[f.path,await readFile(f.path)])));
  const cleanupFile=await save(path.join(cleanup.directory,'cleanup.json'),cleanupPreview.text);
  const shim=await save(path.join(cleanup.directory,'cleanup-crash.mjs'),`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
    const original=fs.promises.unlink;fs.promises.unlink=async function(filename){const result=await original.call(this,filename);
      if(filename===${JSON.stringify(cleanupTarget)})process.exit(42);return result;};
    syncBuiltinESMExports();process.once('beforeExit',()=>process.exit(43));`);
  let cleanupExit;try{execFileSync(process.execPath,['--import',pathToFileURL(shim).href,cli,...cleanupArgs,'--apply','--preview',cleanupFile],
    {cwd:base,windowsHide:true,timeout:120000,stdio:'pipe'});}catch(e){cleanupExit=e.status;}assert.equal(cleanupExit,42);
  const receiptDirectory=path.join(cleanup.wrapper,'.pipeline/repository-cleanup'),cleanupReceipts=await readdir(receiptDirectory);
  assert.equal(cleanupReceipts.length,1);
  const cleanupReceipt=JSON.parse(await readFile(path.join(receiptDirectory,cleanupReceipts[0]),'utf8'));
  assert.equal(cleanupReceipt.status,'in-progress');assert.equal(cleanupReceipt.currentFile,cleanupTarget);
  assert.deepEqual(cleanupReceipt.removedFiles,[]);await assert.rejects(readFile(cleanupTarget),e=>e.code==='ENOENT');
  for(const [filename,bytes] of cleanupBefore)if(filename!==cleanupTarget)assert.deepEqual(await readFile(filename),bytes);
  assert.equal(await readFile(cleanupUser,'utf8'),'preserved user bytes');
  const {scanRepositoryRetention}=await import(pathToFileURL(path.join(installed,'src/operations/repository-retention.js')).href);
  const cleanupAfter=await scanRepositoryRetention(cleanup.wrapper,{policy:{maxAgeDays:0,maxJournals:0,maxDeletesPerRun:1},now:Date.now()});
  assert.equal(cleanupAfter.retention.selected.length,0);
  const replay=invoke([...cleanupArgs,'--apply','--preview',cleanupFile],2);assert.match(String(replay.err),/lock.busy/);
  report.checks.push({name:'packed-public-cleanup-crash-after-exact-unlink-retains-uncertainty',faultSetup:'test-only-fs-preload',exit:42});
  report.packedRepositoryLimits=['Synthetic local Git only; no remote network or provider runtime.',
    'Recovery crash fixtures use installed native APIs; cleanup crash uses installed CLI with a test-only unlink preload.',
    'This is author regression, not independent review or S7 acceptance.'];
}
