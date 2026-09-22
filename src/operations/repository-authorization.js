import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { fail } from '../contracts/parse.js';
import { contractDigest } from '../contracts/semantic.js';
import { resolveChild,inspectDirectory } from '../workspace/paths.js';
import { readRecord } from './state.js';

const same=(a,b)=>contractDigest(a)===contractDigest(b);
const exact=(value,keys)=>value && typeof value==='object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',')===[...keys].sort().join(',');
export async function verifyRepositoryAuthorization(wrapper,journal,preview,binding) {
  if(!binding)return [];
  const expectedPath=journal.replace('/repository-journals/','/repository-authorizations/')+'.json';
  if(!exact(binding,['path','digest']) || binding.path!==expectedPath)fail('repository-authorization.binding');
  const record=await readRecord(resolveChild(wrapper,binding.path)),chain=record.value;
  if(record.digest!==binding.digest || !exact(chain,['schemaVersion','kind','originalPreview','originalApproval','derivedPreview',
    'bootstrapReceiptDigest','bootstrapIntentDigest','journal','newHumanApproval']) || chain.schemaVersion!==1 ||
    chain.kind!=='wrapper-creation-projection' || chain.journal!==journal || chain.newHumanApproval!==false ||
    !same(chain.derivedPreview,preview))fail('repository-authorization.chain');
  const original=chain.originalPreview;
  if(!original || typeof original!=='object' || Array.isArray(original))fail('repository-authorization.original');
  const {digest,...body}=original;
  if(contractDigest(body)!==digest || original.wrapper!==wrapper || original.wrapperObservation?.action!=='create' ||
    original.wrapperObservation.target!==wrapper || original.kind!=='repository-preview-candidate' ||
    original.executionAuthorized!==false || original.status!=='review-only' || !Array.isArray(original.blockers) ||
    original.blockers.length || !Array.isArray(original.operations) ||
    !same(chain.originalApproval,{decision:'approve',previewDigest:digest}))fail('repository-authorization.original');
  const receiptPath='.pipeline/repository-bootstrap.json',intentPath='.pipeline/repository-bootstrap-intent.json';
  const receipt=await readRecord(resolveChild(wrapper,receiptPath)),intent=await readRecord(resolveChild(wrapper,intentPath));
  if(receipt.digest!==chain.bootstrapReceiptDigest || intent.digest!==chain.bootstrapIntentDigest ||
    !same(intent.value,{schemaVersion:1,kind:'wrapper-create-intent',previewDigest:digest,wrapper,
      before:original.wrapperObservation,compensation:'no-automatic-rollback'}))fail('repository-authorization.bootstrap');
  await inspectDirectory(wrapper);await inspectDirectory(path.join(wrapper,'.pipeline'));
  const root=await lstat(wrapper,{bigint:true}),metadata=await lstat(path.join(wrapper,'.pipeline'),{bigint:true});
  const identity={dev:String(root.dev),ino:String(root.ino)};
  if(!same(receipt.value,{schemaVersion:1,kind:'wrapper-created',previewDigest:digest,wrapper,identity,
    metadataIdentity:{dev:String(metadata.dev),ino:String(metadata.ino)},intentDigest:intent.digest,
    pipelineActivated:false,repositoryEffectsPerformed:false}))fail('repository-authorization.bootstrap');
  const derived=structuredClone(body);
  derived.wrapperObservation={action:'keep',path:wrapper,identity};
  for(const op of derived.operations) {
    if(path.dirname(op.target)!==wrapper || !op.destination || op.destination.ancestor!==path.dirname(wrapper) ||
      !same(op.destination.ancestorIdentity,original.wrapperObservation.ancestorIdentity))fail('repository-authorization.projection');
    op.destination={...op.destination,ancestor:wrapper,ancestorIdentity:identity};
  }
  if(!same({...derived,digest:contractDigest(derived)},preview))fail('repository-authorization.projection');
  return [binding,{path:receiptPath,digest:receipt.digest},{path:intentPath,digest:intent.digest}];
}
