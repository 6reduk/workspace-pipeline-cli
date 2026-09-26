import {fail} from '../contracts/parse.js';
import {contractDigest} from '../contracts/semantic.js';
import {readDesiredRecords} from './records.js';
import {parseDesiredWorkspace,prepareDesiredWorkspace} from './source.js';

// Reset is restoration of the recorded Git package, not a fetch of today's ref.
// The source remains declarative: updates keep using its original branch/ref.
export async function prepareDesiredReset(workspace,text,options={}) {
  const descriptor=parseDesiredWorkspace(text),records=await readDesiredRecords(workspace);
  if(records.pending?.value.intent==='remove')fail('desired.finish-remove-before-reset');
  const record=(records.pending??records.installed)?.value;
  if(!record?.binding || !record.adapters)fail('desired.reset-binding-required');
  if(contractDigest(descriptor.pipeline)!==contractDigest(record.binding.source) ||
      contractDigest(descriptor.layout)!==contractDigest(record.binding.layout) ||
      contractDigest([...descriptor.adapters].sort())!==contractDigest([...record.adapters].sort()))
    fail('desired.reset-workspace-different');
  const pinned={...descriptor,pipeline:{...record.binding.source,ref:record.binding.commit}};
  const prepared=await prepareDesiredWorkspace(workspace,JSON.stringify(pinned),options);
  if(prepared.provenance.commit!==record.binding.commit || prepared.provenance.digest!==record.binding.digest)
    fail('desired.reset-source-mismatch');
  prepared.input.binding=record.binding;
  prepared.provenance={source:record.binding.source,commit:record.binding.commit,digest:record.binding.digest};
  prepared.descriptor=descriptor;
  prepared.reset={mode:records.pending?'pending-installation':'installed',commit:record.binding.commit};
  prepared.expectedRecords={installed:records.installed?.hash??null,pending:records.pending?.hash??null};
  return prepared;
}
