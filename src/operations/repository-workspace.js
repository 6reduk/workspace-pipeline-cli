import path from 'node:path';
import { lstat,mkdir,open } from 'node:fs/promises';
import { fail,MAX_INPUT_BYTES } from '../contracts/parse.js';
import { contractDigest } from '../contracts/semantic.js';
import { sha256 } from '../source/inventory.js';
import { inspectDirectory } from '../workspace/paths.js';
import { revalidateRepositoryPreview } from '../workspace/repository-preview.js';
import { inspectRepositoryBootstrap } from './repository-bootstrap-reconcile.js';
import { createRepositoryWrapper } from './repository-bootstrap.js';
import { applyRepositoryOperations } from './repository-apply.js';
import { readRecord } from './state.js';

// Internal orchestration of already-authorized wrapper + repository effects.
// Only the newly created wrapper's identity/ancestor observations may change.
// This is a mechanical authorization projection, never a new human approval.
export async function applyRepositoryWorkspace(args) {
  const {pipeline,workspace,wrapper,choices,options={},previewText,approval,
    ioBoundary=async()=>{}}=args;
  if(!approval || Object.keys(approval).sort().join(',')!=='decision,previewDigest' || approval.decision!=='approve')
    fail('repository-workspace.approval');
  const original=await revalidateRepositoryPreview(previewText,approval.previewDigest,pipeline,workspace,wrapper,choices,options);
  if(original.wrapperObservation.action==='keep')return applyRepositoryOperations(args);
  // Refuse unsupported missing ancestors before creating anything.
  if(!(await inspectDirectory(path.dirname(original.wrapper))).exists ||
    original.operations.some(op=>path.dirname(op.target)!==original.wrapper))fail('repository-workspace.ancestors-unsupported');
  const bootstrap=await createRepositoryWrapper(args);
  const checked=await inspectRepositoryBootstrap(original.wrapper,previewText,original.digest);
  if(checked.status!=='handoff-recorded')fail('repository-workspace.bootstrap-state');
  const receipt=await readRecord(bootstrap.receipt);
  if(receipt.digest!==checked.recordDigests.receipt)fail('repository-workspace.bootstrap-drift');
  await ioBoundary('workspace-bootstrap-completed',{receipt:bootstrap.receipt});
  const identity=receipt.value.identity;
  const {digest:oldDigest,...body}=structuredClone(original);
  body.wrapperObservation={action:'keep',path:original.wrapper,identity};
  for(const op of body.operations) {
    if(!op.destination || op.destination.ancestor!==path.dirname(original.wrapper) ||
      contractDigest(op.destination.ancestorIdentity)!==contractDigest(original.wrapperObservation.ancestorIdentity))
      fail('repository-workspace.projection');
    op.destination={...op.destination,ancestor:original.wrapper,ancestorIdentity:identity};
  }
  const derived={...body,digest:contractDigest(body)};
  const derivedText=JSON.stringify(derived);
  // Reconstruct all semantics from the original inputs. Source bytes/commit,
  // manifest bytes, target absence, and prepared remote bindings remain exact.
  await revalidateRepositoryPreview(derivedText,derived.digest,pipeline,workspace,wrapper,choices,options);
  let authorizationFile,authorizationDigest;
  const result=await applyRepositoryOperations({...args,previewText:derivedText,
    approval:{decision:'approve',previewDigest:derived.digest},ioBoundary:async(phase,detail)=>{
      if(phase==='repository-run-started') {
        const current=await readRecord(bootstrap.receipt);
        const history=await readRecord(path.join(original.wrapper,'.pipeline/repository-bootstrap-intent.json'));
        if(current.digest!==receipt.digest || history.digest!==checked.recordDigests.history)
          fail('repository-workspace.bootstrap-drift');
        const stat=await lstat(original.wrapper,{bigint:true});
        if(String(stat.dev)!==identity.dev || String(stat.ino)!==identity.ino)fail('repository-workspace.bootstrap-drift');
        const directory=path.join(original.wrapper,'.pipeline/repository-authorizations');
        try{await mkdir(directory);}catch(e){if(e.code!=='EEXIST')throw e;}
        await inspectDirectory(directory);
        authorizationFile=path.join(directory,path.basename(detail.journal)+'.json');
        const bytes=Buffer.from(JSON.stringify({schemaVersion:1,kind:'wrapper-creation-projection',
          originalPreview:original,originalApproval:{decision:'approve',previewDigest:original.digest},derivedPreview:derived,
          bootstrapReceiptDigest:receipt.digest,bootstrapIntentDigest:history.digest,
          journal:detail.journal,newHumanApproval:false})+'\n');
        if(bytes.length>MAX_INPUT_BYTES)fail('repository-workspace.authorization-size');
        const handle=await open(authorizationFile,'wx',0o600);
        try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
        authorizationDigest=sha256(bytes);
        if((await readRecord(authorizationFile)).digest!==authorizationDigest)fail('repository-workspace.authorization-readback');
      }
      await ioBoundary(phase,detail);
      if(authorizationFile && (await readRecord(authorizationFile)).digest!==authorizationDigest)
        fail('repository-workspace.authorization-drift');
      if(phase==='repository-run-started')return {
        path:detail.journal.replace('/repository-journals/','/repository-authorizations/')+'.json',digest:authorizationDigest};
    }});
  return {...result,originalPreviewDigest:original.digest,executionPreview:derived,
    authorizationFile,authorizationDigest,bootstrapReceipt:bootstrap.receipt};
}
