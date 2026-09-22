import path from 'node:path';
import { lstat,opendir } from 'node:fs/promises';
import { absoluteRoot,inspectDirectory } from '../workspace/paths.js';
import { fail } from '../contracts/parse.js';
import { bootstrapLockDirectory } from './bootstrap-lock.js';
import { readRecord } from './state.js';

// Location inventory only, not journal/evidence validation or cleanup authority.
// No recursive enumeration and no secret-bearing record contents in the output.
export async function listRepositoryHistory(workspace,{maxEntries=1000}={}) {
  workspace=absoluteRoot(workspace);
  if(!Number.isSafeInteger(maxEntries) || maxEntries<1 || maxEntries>1000)fail('repository-history.limit-option');
  const entries=[],diagnostics=[];let count=0;
  const issue=(error,subject)=>diagnostics.push({code:error.code??'repository-history.io',subject});
  const consume=()=>{if(++count>maxEntries)fail('repository-history.limit');};
  const add=async(filename,kind)=>{
    let info;try{info=await lstat(filename);}catch(e){if(e.code==='ENOENT')return;throw e;}
    entries.push({path:filename,kind,type:info.isSymbolicLink()?'link':info.isDirectory()?'directory':info.isFile()?'file':'other',
      deletionEligible:false,protectionReasons:['requires-validated-retention-preview']});
    if(info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()) || (info.isFile() && info.nlink!==1))
      fail('repository-history.unsafe-type');
  };
  const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
  for(const [name,pattern] of [
    ['repository-journals',new RegExp('^'+uuid+'$')],['repository-evidence',new RegExp('^'+uuid+'$')],
    ['repository-authorizations',new RegExp('^'+uuid+'\\.json$')],
    ['repository-inputs',new RegExp('^'+uuid+'\\.json$')],
    ['repository-lock-recoveries',/^[a-f0-9]{64}$/],
    ['repository-cleanup',new RegExp('^'+uuid+'\\.json$')],
    ['repository-completions',new RegExp('^'+uuid+'(?:\\.pending)?\\.json$')]]) {
    const directory=path.join(workspace,'.pipeline',name);
    try {
      if(!(await inspectDirectory(directory)).exists)continue;
      for await(const entry of await opendir(directory)) {
        consume();const filename=path.join(directory,entry.name);
        try{await add(filename,name);}catch(e){issue(e,filename);}
        if(!pattern.test(entry.name))issue({code:'repository-history.foreign-name'},filename);
      }
    }catch(e){issue(e,directory);}
  }
  for(const name of ['repository-operation.json','repository-bootstrap.json','repository-bootstrap-intent.json',
    'repository-bootstrap-recovery.json','repository-bootstrap-recovered-lock']) {
    const filename=path.join(workspace,'.pipeline',name);
    try{consume();await inspectDirectory(path.dirname(filename));await add(filename,'repository-bootstrap-record');}
    catch(e){issue(e,filename);}
  }
  const bootstrap=bootstrapLockDirectory(workspace);
  for(const filename of [bootstrap,bootstrap+'.recovery',bootstrap+'.recovery-resume']) {
    try{consume();await inspectDirectory(path.dirname(filename));await add(filename,'repository-bootstrap-lock');}
    catch(e){issue(e,filename);}
  }
  const parent=path.dirname(workspace);
  try {
    let scanned=0;
    if((await inspectDirectory(parent)).exists)for await(const item of await opendir(parent)) {
      if(++scanned>100000)fail('repository-history.parent-limit');
      const abandoned=/^\.wpc-bootstrap-abandoned-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$(?![\s\S])/.test(item.name);
      const resolution=new RegExp('^\\.wpc-repository-resolution-'+uuid+'$(?![\\s\\S])').test(item.name);
      if(!abandoned && !resolution && !/^\.wpc-bootstrap-(?:history|recovery)-[a-f0-9]{64}$(?![\s\S])/.test(item.name))continue;
      consume();
      const directory=path.join(parent,item.name);
      // Historical siblings may belong to another wrapper. Only an exact owner
      // binding selects one; ambiguous/unreadable history is reported, not deleted.
      try {
        await inspectDirectory(directory);
        if(resolution) {
          const request=await readRecord(path.join(directory,'request.json'));
          if(typeof request.value?.wrapper!=='string')fail('repository-history.owner');
          if(request.value.wrapper===workspace)await add(directory,'repository-resolution-history');
          continue;
        }
        if(abandoned) {
          const request=await readRecord(path.join(directory,'request.json'));
          if(typeof request.value?.preview?.wrapper!=='string')fail('repository-history.owner');
          if(request.value.preview.wrapper===workspace)await add(directory,'repository-bootstrap-abandoned-history');
          continue;
        }
        const owner=await readRecord(path.join(directory,'owner.json'));
        const isRecovery=item.name.startsWith('.wpc-bootstrap-recovery-');
        const binding=isRecovery?owner.value?.wrapper:owner.value?.workspace;
        if(typeof binding!=='string')fail('repository-history.owner');
        if(binding===workspace)await add(directory,isRecovery?'repository-bootstrap-recovery-history':'repository-bootstrap-history');
      }catch(e){issue(e,directory);}
    }
  }catch(e){issue(e,parent);}
  // Ancestor creation may have retained ownership evidence above the direct
  // wrapper parent. Scan only names, under a shared depth/entry bound; never
  // descend through unrelated directories or infer deletion authority.
  try {
    let ancestor=parent,scanned=0,depth=0;
    for(;depth<32;depth++) {
      if((await inspectDirectory(ancestor)).exists)for await(const item of await opendir(ancestor)) {
        if(++scanned>100000)fail('repository-history.ancestor-limit');
        if(!new RegExp('^\\.wpc-ancestors-'+uuid+'$(?![\\s\\S])').test(item.name))continue;
        consume();const directory=path.join(ancestor,item.name);
        try {
          await inspectDirectory(directory);const request=await readRecord(path.join(directory,'request.json'));
          if(typeof request.value?.wrapper!=='string')fail('repository-history.owner');
          if(request.value.wrapper===workspace)await add(directory,'repository-ancestor-history');
        }catch(e){issue(e,directory);}
      }
      const next=path.dirname(ancestor);if(next===ancestor)break;ancestor=next;
    }
    if(depth===32)fail('repository-history.ancestor-depth');
  }catch(e){issue(e,parent);}
  entries.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  return {workspace,entries,diagnostics,complete:diagnostics.length===0,validation:'locations-only',deletionEligible:false};
}
