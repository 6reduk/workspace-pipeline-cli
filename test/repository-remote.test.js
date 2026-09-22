import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp,mkdir,writeFile,readdir } from 'node:fs/promises';
import { acquireRemoteRepository,runGit } from '../src/source/git.js';
import { inventoryRepository } from '../src/workspace/repository-inventory.js';
import { prepareRepositoryPreview,revalidateRepositoryPreview } from '../src/workspace/repository-preview.js';
import { applyRepositoryWorkspace } from '../src/operations/repository-workspace.js';
import { inspectRepositoryReconciliation } from '../src/operations/repository-reconcile.js';

const source={type:'git',transport:'remote',url:'ssh://git@fixture.invalid/repo',ref:'main',subdirectory:'.'};
test('S7 remote preparation requires explicit network opt-in before creating files',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wpc-s7-remote-off-'));
  await assert.rejects(acquireRemoteRepository(source,{tempRoot:root}),e=>e.code==='source.network-required');
  assert.deepEqual(await readdir(root),[]);
});
test('S7 remote repository staging pins commit without requiring pipeline package, cap fails closed',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wpc-s7-remote-')),repo=path.join(root,'origin');
  await mkdir(repo); await runGit(repo,['init','--template=','-b','main']);
  await writeFile(path.join(repo,'game.txt'),'ordinary project, not a pipeline package');
  await runGit(repo,['add','game.txt']);
  await runGit(repo,['-c','user.name=S7','-c','user.email=s7@example.invalid','commit','-m','fixture']);
  const bare=path.join(root,'remote.git');
  await runGit(root,['clone','--bare','--no-hardlinks',repo,bare]);
  const before=await inventoryRepository(bare), helper=path.join(root,'ssh-fixture.cjs');
  await writeFile(helper,"const {spawn}=require('node:child_process');"+
    "if(process.argv.includes('-G'))process.exit(1);"+
    "const c=spawn('git',['-c','core.hooksPath=/dev/null','upload-pack',"+JSON.stringify(bare)+
    "],{stdio:'inherit',windowsHide:true,shell:false});c.on('error',()=>process.exit(1));c.on('exit',n=>process.exit(n??1));");
  const previous=process.env.GIT_SSH_COMMAND;
  process.env.GIT_SSH_COMMAND='"'+process.execPath.replaceAll('\\','/')+'" "'+helper.replaceAll('\\','/')+'"';
  try {
    const result=await acquireRemoteRepository(source,{tempRoot:root,network:true});
    assert.equal(result.commit,(await runGit(repo,['rev-parse','HEAD'])).bytes.toString().trim());
    assert.equal(result.executionAuthorized,false);assert.equal(result.history,'shallow-depth-1');
    assert.equal((await runGit(result.repo,['show',result.commit+':game.txt'])).bytes.toString(),'ordinary project, not a pipeline package');
    assert.deepEqual(await inventoryRepository(bare),before);
    await assert.rejects(acquireRemoteRepository(source,{tempRoot:root,network:true,packLimit:1}),e=>e.code==='source.pack' && Boolean(e.preparation));
    const pipeline={schemaVersion:1,id:'example',version:'1.0.0',resources:'resources',inventory:'inventory.json',
      providers:{codex:{skills:'skills',agents:null,mcp:null,entryInstructions:null,requires:[]}},agentsDocument:{mode:'default'}};
    const workspace={schemaVersion:1,pipeline:source,providers:['codex'],layout:{kind:'single-repo',
      repositories:{game:{path:'project',role:'code',source}},documentation:{repository:'game',path:'docs'}}};
    const wrapper=path.join(root,'wrapper'),choices={game:{action:'clone'}};
    const manifestPath=path.join(root,'workspace.json');
    await writeFile(manifestPath,JSON.stringify(workspace));
    const options={command:'init',tempRoot:root,network:true,manifestPath};
    const candidate=await prepareRepositoryPreview(pipeline,workspace,wrapper,choices,options);
    const driftWrapper=path.join(root,'drift-wrapper');
    const driftCandidate=await prepareRepositoryPreview(pipeline,workspace,driftWrapper,choices,options);
    // If reload accidentally tries transport, this invalid command makes it fail.
    process.env.GIT_SSH_COMMAND='wpc-must-not-launch-network';
    const reloaded=await revalidateRepositoryPreview(JSON.stringify(candidate),candidate.digest,pipeline,workspace,wrapper,choices,{...options,network:false});
    assert.deepEqual(reloaded,candidate);
    const previewText=JSON.stringify(candidate);
    const applied=await applyRepositoryWorkspace({pipeline,workspace,wrapper,choices,
      options:{...options,network:false},previewText,
      approval:{decision:'approve',previewDigest:candidate.digest}});
    assert.equal(applied.status,'effects-completed');
    assert.equal((await runGit(path.join(wrapper,'project'),['rev-parse','HEAD'])).bytes.toString().trim(),result.commit);
    assert.equal((await runGit(path.join(wrapper,'project'),['remote'])).bytes.length,0);
    assert.equal((await inspectRepositoryReconciliation(wrapper,JSON.stringify(applied.executionPreview),applied.executionPreview.digest)).canFinalize,true);
    assert.deepEqual(await inventoryRepository(bare),before);
    await writeFile(path.join(driftCandidate.operations[0].binding.repo,'unexpected.txt'),'staging drift');
    await assert.rejects(revalidateRepositoryPreview(JSON.stringify(driftCandidate),driftCandidate.digest,pipeline,workspace,driftWrapper,choices,options),
      e=>e.code==='repositories.preparation-drift');
  } finally {
    if(previous===undefined)delete process.env.GIT_SSH_COMMAND;else process.env.GIT_SSH_COMMAND=previous;
  }
});
