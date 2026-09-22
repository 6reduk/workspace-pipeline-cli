import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,mkdir,writeFile,readFile,lstat} from 'node:fs/promises';
import {runGit} from '../src/source/git.js';
import {prepareRepositoryPreview} from '../src/workspace/repository-preview.js';
import {inventoryRepository} from '../src/workspace/repository-inventory.js';
import {applyRepositoryOperations} from '../src/operations/repository-apply.js';
import {readRepositoryJournal} from '../src/operations/repository-journal.js';
import {inspectRepositoryReconciliation} from '../src/operations/repository-reconcile.js';

for(const [nativeCode,expected] of [['EBUSY','repository-apply.busy'],['EACCES','repository-apply.access-denied']]){
  test('S7 classifies injected '+nativeCode+' before move without claiming completion or losing source data',async()=>{
    const base=await mkdtemp(path.join(tmpdir(),'wpc-s7-io-')),wrapper=path.join(base,'wrapper'),from=path.join(base,'source');
    await mkdir(wrapper);await mkdir(from);await runGit(from,['init','--template=']);
    await writeFile(path.join(from,'user.txt'),'untracked user data');
    const pipeline={schemaVersion:1,id:'example',version:'1.0.0',resources:'resources',inventory:'inventory.json',
      providers:{codex:{skills:'skills',agents:null,mcp:null,entryInstructions:null,requires:[]}},agentsDocument:{mode:'default'}};
    const workspace={schemaVersion:1,pipeline:{type:'git',transport:'local',path:'pipeline',ref:'HEAD',subdirectory:'.'},providers:['codex'],
      layout:{kind:'single-repo',repositories:{game:{path:'project',role:'code'}},documentation:{repository:'game',path:'docs'}}};
    const manifestPath=path.join(base,'workspace.json');await writeFile(manifestPath,JSON.stringify(workspace));
    const choices={game:{action:'move',from}},options={command:'adopt',manifestPath};
    const preview=await prepareRepositoryPreview(pipeline,workspace,wrapper,choices,options);
    const before=await inventoryRepository(from);let failure,hit=false;
    await assert.rejects(applyRepositoryOperations({pipeline,workspace,wrapper,choices,options,previewText:JSON.stringify(preview),
      approval:{decision:'approve',previewDigest:preview.digest},ioBoundary:async phase=>{
        if(phase==='before-effect'){hit=true;throw Object.assign(new Error('synthetic native I/O failure'),{code:nativeCode});}
      }}),e=>{failure=e;return e.code===expected;});
    assert.equal(hit,true);assert.equal((await inventoryRepository(from)).digest,before.digest);
    assert.equal(await readFile(path.join(from,'user.txt'),'utf8'),'untracked user data');
    await assert.rejects(lstat(path.join(wrapper,'project')),e=>e.code==='ENOENT');
    const marker=JSON.parse(await readFile(path.join(wrapper,'.pipeline/repository-operation.json'),'utf8'));
    assert.equal(marker.journal,failure.repositoryJournal);assert.equal(marker.status,'requires-reconciliation');
    const journal=await readRepositoryJournal(wrapper,marker.journal,preview);
    assert.equal(journal.phase,'interrupted');assert.equal(journal.operations[0].status,'uncertain');
    const observed=await inspectRepositoryReconciliation(wrapper,JSON.stringify(preview),preview.digest);
    assert.equal(observed.canFinalize,false);assert.equal(observed.observations[0].state,'before-state-observed');
  });
}
