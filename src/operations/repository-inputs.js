import path from 'node:path';
import {mkdir,open} from 'node:fs/promises';
import {fail,MAX_INPUT_BYTES} from '../contracts/parse.js';
import {contractDigest} from '../contracts/semantic.js';
import {resolveChild,inspectDirectory} from '../workspace/paths.js';
import {readRecord} from './state.js';
import {sha256} from '../source/inventory.js';

function location(wrapper,journal) {
  if(!/^\.pipeline\/repository-journals\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(journal))
    fail('repository-inputs.journal');
  return resolveChild(wrapper,'.pipeline/repository-inputs/'+path.basename(journal)+'.json');
}
function validate(value,wrapper,journal,digest) {
  if(!value || Object.keys(value).sort().join(',')!=='journal,preview,schemaVersion,wrapper' ||
    value.schemaVersion!==1 || value.wrapper!==wrapper || value.journal!==journal)
    fail('repository-inputs.binding');
  const {digest:actual,...body}=value.preview??{};
  if(actual!==digest || contractDigest(body)!==digest || body.wrapper!==wrapper ||
    body.kind!=='repository-preview-candidate')fail('repository-inputs.preview');
}
// Recorded before any repository effect. This is recoverable input, not approval
// to execute/replay: callers still inspect current state and obtain exact authority.
export async function persistRepositoryInputs(wrapper,journal,preview) {
  const filename=location(wrapper,journal),value={schemaVersion:1,wrapper,journal,preview};
  validate(value,wrapper,journal,preview.digest);
  const bytes=Buffer.from(JSON.stringify(value)+'\n');
  if(bytes.length>MAX_INPUT_BYTES)fail('repository-inputs.size');
  try{await mkdir(path.dirname(filename));}catch(e){if(e.code!=='EEXIST')throw e;}
  await inspectDirectory(path.dirname(filename));
  const handle=await open(filename,'wx',0o600);
  try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
  if((await readRecord(filename)).digest!==sha256(bytes))fail('repository-inputs.readback');
  return filename;
}
export async function readRepositoryInputs(wrapper,journal,previewDigest) {
  if(!/^sha256:[a-f0-9]{64}$/.test(previewDigest??''))fail('repository-inputs.digest');
  const record=await readRecord(location(wrapper,journal));
  validate(record.value,wrapper,journal,previewDigest);
  return {previewText:JSON.stringify(record.value.preview),previewDigest,path:record.path,recordDigest:record.digest};
}
