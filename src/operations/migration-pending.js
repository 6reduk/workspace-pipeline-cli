import {lstat} from 'node:fs/promises';
import {absoluteRoot,resolveChild,inspectDirectory} from '../workspace/paths.js';
import {fail,ContractError} from '../contracts/parse.js';

// Presence is a blocker regardless of record validity. A partial write, directory
// or link must never be interpreted as permission to start a different lifecycle.
// This reader does not follow the marker, delete it or infer recovery authority.
export async function inspectMigrationPending(workspace){
 workspace=absoluteRoot(workspace);
 const relative='.pipeline/migration-operation.json',subject=resolveChild(workspace,relative);
 try{
  await inspectDirectory(resolveChild(workspace,'.pipeline'));
  await lstat(subject);
  return {workspace,blocked:true,blockers:[{code:'migration.pending',subject}]};
 }catch(error){
  if(error.code==='ENOENT')return {workspace,blocked:false,blockers:[]};
  throw error instanceof ContractError?error:new ContractError('migration.pending-io');
 }
}
export async function assertNoMigrationPending(workspace){
 if((await inspectMigrationPending(workspace)).blocked)fail('migration.pending');
}
