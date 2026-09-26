import path from 'node:path';
import {tmpdir} from 'node:os';
import {parse,fail} from '../contracts/parse.js';
import {validateStructure} from '../contracts/validate.js';
import {validateLayoutReferences} from '../contracts/semantic.js';
import {absoluteRoot} from '../workspace/paths.js';
import {assertUnreserved,overlaps} from '../workspace/reserved.js';
import {acquire} from '../source/git.js';
import {compileDesiredManifest} from '../contracts/desired-state.js';

export function parseDesiredWorkspace(text) {
  const value=parse(text,'json');
  if(value.schemaVersion!==2 || Object.keys(value).some(k=>!['schemaVersion','pipeline','adapters','layout'].includes(k)) ||
      !Array.isArray(value.adapters)||!value.adapters.length || new Set(value.adapters).size!==value.adapters.length ||
      value.adapters.some(id=>typeof id!=='string'||!/^[a-z][a-z0-9-]{0,62}$/.test(id)))fail('desired.workspace-schema');
  // Reuse the established Git/layout data types, not old provider installation.
  validateStructure('workspace',{schemaVersion:1,pipeline:value.pipeline,providers:['codex'],layout:value.layout});
  validateLayoutReferences(value.layout);
  const repositories=Object.values(value.layout.repositories).map(repo=>repo.path);
  for(const name of repositories){assertUnreserved(name);if(overlaps(name,'workspace.json'))fail('layout.reserved');}
  for(let i=0;i<repositories.length;i++)for(let j=0;j<i;j++)
    if(overlaps(repositories[i],repositories[j]))fail('desired.repository-overlap');
  return value;
}

// No writes to workspace, no harness execution. Acquired Git objects/snapshot
// are temporary source material, never backups of installed user contents.
export async function prepareDesiredWorkspace(workspace,text,{manifestBase,tempRoot=tmpdir(),network=false}={}) {
  workspace=absoluteRoot(workspace);tempRoot=absoluteRoot(tempRoot);
  const rel=path.relative(workspace,tempRoot);
  if(!rel || (!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel)))fail('desired.preparation-location');
  const descriptor=parseDesiredWorkspace(text);
  const acquired=await acquire(descriptor.pipeline,{manifestBase:manifestBase??workspace,tempRoot,network,packageFormat:'desired'});
  const protectedPaths=Object.values(descriptor.layout.repositories).map(repo=>repo.path);
  const manifest=JSON.stringify(acquired.manifest);
  compileDesiredManifest(manifest,{selected:descriptor.adapters,protectedPaths});
  const binding={source:acquired.source,commit:acquired.commit,digest:acquired.digest,layout:descriptor.layout};
  return {input:{workspace,manifest,selected:descriptor.adapters,protectedPaths,source:acquired.files,binding},
    provenance:{source:acquired.source,commit:acquired.commit,digest:acquired.digest},
    preparation:{objects:acquired.preparation,snapshot:acquired.snapshotPath},descriptor};
}
