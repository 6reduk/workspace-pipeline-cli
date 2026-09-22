import {prepareRepositoryAncestors,applyRepositoryAncestors,inspectRepositoryAncestors,finishRepositoryAncestors} from '../operations/repository-ancestors.js';
import {readRecord} from '../operations/state.js';
import {contractDigest} from '../contracts/semantic.js';
import {fail} from '../contracts/parse.js';

export async function runRepositoryAncestors(c,stdout){
  let result;
  if(c.action==='prepare-parent'){
    if(c.apply){const p=(await readRecord(c.previewFile)).value;if(p.wrapper!==c.workspace)fail('ancestors.workspace');result=await applyRepositoryAncestors(p);}
    else result=await prepareRepositoryAncestors(c.workspace);
  }else if(!c.apply){
    const p=(await readRecord(c.parentPreview)).value;if(p.wrapper!==c.workspace)fail('ancestors.workspace');
    const observation=await inspectRepositoryAncestors(p),body={kind:'repository-parent-continuation-preview',wrapper:c.workspace,parent:p,observation,executionAuthorized:false};
    result={...body,digest:contractDigest(body)};
  }else{
    const p=(await readRecord(c.previewFile)).value,{digest,...body}=p;
    if(p.kind!=='repository-parent-continuation-preview' || p.wrapper!==c.workspace || p.parent?.wrapper!==c.workspace || contractDigest(body)!==digest)fail('ancestors.approval');
    result=await finishRepositoryAncestors(p.parent,p.observation?.digest);
  }
  await stdout(JSON.stringify(result)+'\n');return 0;
}
