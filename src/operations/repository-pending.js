import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { fail } from '../contracts/parse.js';
import { absoluteRoot,inspectDirectory } from '../workspace/paths.js';
import { bootstrapLockDirectory } from './bootstrap-lock.js';
import {inspectMigrationPending} from './migration-pending.js';

// Presence is enough to block, including malformed files and links. Never parse
// unknown records to infer that an unfinished operation is safe to ignore.
export async function inspectRepositoryPending(workspace) {
  workspace=absoluteRoot(workspace);
  const bootstrap=bootstrapLockDirectory(workspace),blockers=[];
  for(const [code,filename] of [
    ['repository.pending',path.join(workspace,'.pipeline/repository-operation.json')],
    ['repository.bootstrap-pending',bootstrap],
    ['repository.recovery-pending',bootstrap+'.recovery'],
    ['repository.recovery-resume-pending',bootstrap+'.recovery-resume']]) {
    await inspectDirectory(path.dirname(filename));
    try{await lstat(filename);blockers.push({code,subject:filename});}
    catch(e){if(e.code!=='ENOENT')throw e;}
  }
  blockers.push(...(await inspectMigrationPending(workspace)).blockers);
  return {workspace,blockers,blocked:blockers.length!==0};
}
export async function assertNoRepositoryPending(workspace) {
  const result=await inspectRepositoryPending(workspace);
  if(result.blockers.some(b=>b.code==='migration.pending'))fail('migration.pending');
  if(result.blocked)fail('lock.repository-pending');
}
