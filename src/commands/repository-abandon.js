import {prepareRepositoryAbandon,inspectRepositoryAbandon,applyRepositoryAbandon} from '../operations/repository-abandon.js';
import {readRecord} from '../operations/state.js';
import {fail} from '../contracts/parse.js';

export async function runRepositoryAbandon(command,stdout){
  const continuation=command.action==='continue-abandon';
  if(command.apply){
    const preview=(await readRecord(command.previewFile)).value;
    if(continuation && preview.attempt!==command.attempt)fail('repository-abandon.attempt');
    const result=await applyRepositoryAbandon(command.workspace,preview,{continuation});
    await stdout(JSON.stringify(result)+'\n');return 0;
  }
  const result=continuation?await inspectRepositoryAbandon(command.workspace,command.attempt):
    await prepareRepositoryAbandon(command.workspace);
  await stdout(JSON.stringify(result)+'\n');return 0;
}
