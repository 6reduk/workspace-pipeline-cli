import {mkdir,readdir,lstat,unlink,rmdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {scanRetention} from './retention-scan.js';
import {scanCombinedRetention} from './retention-combined-scan.js';
import {assertLockHeld} from './lock.js';
import {readRecord} from './state.js';
import {writeCheckedFile} from './apply.js';
import {resolveChild,inspectDirectory} from '../workspace/paths.js';
import {contractDigest} from '../contracts/semantic.js';
import {parse,fail,ContractError} from '../contracts/parse.js';
import {requestShape} from './ownership.js';
import {sha256} from '../source/inventory.js';
import {readRetentionPolicy,retentionLimits} from './retention-policy.js';

// Exact approved journal-group deletion only. No recursive deletion, snapshot or
// backup cleanup, lock stealing, rollback, or provider/project writes.
export async function applyRetention(lock,preview,approval,{boundary=async()=>{},report=async()=>{}}={}) {
  const p=parse(JSON.stringify(preview),'json'),a=parse(JSON.stringify(approval),'json');
  const combined=p.kind==='combined-retention-filesystem-preview';
  const key=g=>combined?g.type+':'+g.id:g.id;
  const automatic=a.decision==='workspace-policy';
  requestShape(a,automatic?['decision','policyHash']:['decision','previewDigest'],[],'retention-apply.approval');
  const {digest,...body}=p;
  if(!['retention-filesystem-preview','combined-retention-filesystem-preview'].includes(p.kind) || contractDigest(body)!==digest || !p.complete ||
      p.workspace!==lock.workspace || (!automatic && (a.decision!=='approve' || a.previewDigest!==digest)))fail('retention-apply.approval');
  async function guardPolicy() {
    if(!automatic)return;
    const current=await readRetentionPolicy(lock.workspace);
    if(current.mode!=='automatic' || current.hash!==a.policyHash ||
        (current.policy.schemaVersion===2)!==combined ||
        contractDigest(retentionLimits(current.policy))!==contractDigest(p.retention.policy))fail('retention-apply.policy-drift');
  }
  const options={policy:p.retention.policy,now:p.retention.now,currentRuns:p.currentRuns};
  await assertLockHeld(lock);
  await guardPolicy();
  if(contractDigest(await (combined?scanCombinedRetention:scanRetention)(lock.workspace,options))!==contractDigest(p))fail('retention-apply.drift');
  const selected=p.retention.selected.map(s=>p.groups.find(g=>key(g)===key(s)));
  if(selected.some(g=>!g || g.status!=='journal-completed' || g.protectionReasons.length ||
      (g.type==='cleanup-receipt'?(g.paths.length!==0||g.files.length!==1):g.paths.length!==2)))fail('retention-apply.scope');
  // Neither policy version creates persistent receipts for a no-work pass.
  // Approval and fresh inventory checks above still apply; emit only the result.
  if(selected.length===0) {
    const result={status:'completed',error:null,runId:null,receiptPath:null,receiptCreated:false,
      removedGroups:0,removedFiles:0,reclaimedBytes:0,selectedGroups:0,uncompletedGroups:[],recoverable:false,receiptUpdate:'not-created'};
    try{await report({kind:'cleanup-result',...result});}catch{result.outputError='retention-apply.report';}
    return result;
  }
  const runId=randomUUID(),relative='.pipeline/cleanup/'+runId+'.json',filename=resolveChild(lock.workspace,relative);
  const receipt={schemaVersion:combined?2:1,kind:'retention-result',runId,workspace:lock.workspace,previewDigest:digest,
    policy:p.retention.policy,authorization:a,status:'in-progress',recoverable:false,
    groups:selected.map(g=>({id:g.id,...combined?{type:g.type}:{},paths:g.paths,files:g.files})),removedFiles:[],removedDirectories:[],completedGroups:[],
    currentFile:null,error:null,reclaimedBytes:0};
  // Bound receipt size before even creating its directory; no payload secrets.
  parse(JSON.stringify(receipt),'json');
  let receiptHash=null,created=false;
  const removedFiles=new Set(),removedDirectories=new Set();
  async function save() {
    const bytes=Buffer.from(JSON.stringify(receipt)+'\n');parse(bytes.toString('utf8'),'json');
    await writeCheckedFile(lock,relative,receiptHash,bytes,undefined,async phase=>{
      if(receiptHash===null && phase==='opened')created=true;
    });receiptHash=sha256(bytes);created=true;
  }
  async function checkFile(file) {
    const target=resolveChild(lock.workspace,file.path),info=await lstat(target);
    if(!info.isFile() || info.isSymbolicLink() || info.nlink!==1 || info.size!==file.bytes || info.mtimeMs!==file.mtimeMs ||
        (await readRecord(target)).digest!==file.hash)fail('retention-apply.drift');
  }
  async function guardReferences() {
    await assertLockHeld(lock);
    await guardPolicy();
    let stateHash=null;
    try{stateHash=(await readRecord(resolveChild(lock.workspace,'.pipeline/state.json'))).digest;}
    catch(error){if(error.code!=='record.missing')throw error;}
    if(stateHash!==p.stateFileHash)fail('retention-apply.state-drift');
    for(const base of ['.pipeline/journals','.pipeline/transactions']) {
      const expected=p.groups.flatMap(g=>g.paths).filter(d=>d.startsWith(base+'/') && !removedDirectories.has(d)).map(d=>d.slice(base.length+1)).sort();
      const directory=resolveChild(lock.workspace,base),exists=(await inspectDirectory(directory)).exists;
      const names=exists?(await readdir(directory)).sort():[];
      if(JSON.stringify(names)!==JSON.stringify(expected))fail('retention-apply.inventory-drift');
    }
    // Bound to the inspected records: new references invalidate cleanup. This is
    // a conservative per-file record check, not a claim of linear overall cost.
    for(const group of p.groups)for(const file of group.files)
      if((file.path.endsWith('/recovery.json') || group.type==='cleanup-receipt') && !removedFiles.has(file.path))await checkFile(file);
    if(combined) {
      const base='.pipeline/cleanup',directory=resolveChild(lock.workspace,base);
      const expected=p.groups.filter(g=>g.type==='cleanup-receipt').flatMap(g=>g.files)
        .filter(f=>!removedFiles.has(f.path)).map(f=>f.path.slice(base.length+1));
      if(created)expected.push(runId+'.json');
      const actual=(await inspectDirectory(directory)).exists?await readdir(directory):[];
      if(JSON.stringify(actual.sort())!==JSON.stringify(expected.sort()))fail('retention-apply.inventory-drift');
      if(created&&(await readRecord(filename)).digest!==receiptHash)fail('retention-apply.receipt-drift');
    }
  }
  try {
    await report({kind:'cleanup-location',runId,path:filename,status:'planned'});
    await guardReferences();
    const parent=resolveChild(lock.workspace,'.pipeline/cleanup');
    try{await mkdir(parent);}catch(error){if(error.code!=='EEXIST')throw error;}
    await inspectDirectory(parent);await save();
    await report({kind:'cleanup-location',runId,path:filename,status:'created'});
    for(const group of selected) {
      await boundary('before-group',{id:group.id});await guardReferences();
      for(const directory of group.paths) {
        const expected=group.files.filter(f=>f.path.startsWith(directory+'/')).map(f=>f.path.slice(directory.length+1)).sort();
        if(JSON.stringify((await readdir(resolveChild(lock.workspace,directory))).sort())!==JSON.stringify(expected))fail('retention-apply.inventory-drift');
      }
      for(const file of group.files) {
        receipt.currentFile=file.path;await save();
        await boundary('before-file',{path:file.path});await guardReferences();await checkFile(file);
        await unlink(resolveChild(lock.workspace,file.path));
        removedFiles.add(file.path);receipt.removedFiles.push(file.path);receipt.reclaimedBytes+=file.bytes;
        await boundary('file-removed',{path:file.path});receipt.currentFile=null;await save();
      }
      for(const directory of group.paths) {
        await guardReferences();await inspectDirectory(resolveChild(lock.workspace,directory));
        await rmdir(resolveChild(lock.workspace,directory)); // empty only; never recursive
        removedDirectories.add(directory);receipt.removedDirectories.push(directory);await save();
      }
      receipt.completedGroups.push(key(group));await save();
    }
    await guardReferences();receipt.status='completed';await save();
  }catch(error) {
    receipt.status='failed';receipt.error=error instanceof ContractError?error.code:'retention-apply.io';
    try{if(created)await save();}catch{receipt.receiptUpdate='failed';}
  }
  const result={status:receipt.status,error:receipt.error,runId,receiptPath:filename,receiptCreated:created,
    removedGroups:receipt.completedGroups.length,removedFiles:receipt.removedFiles.length,reclaimedBytes:receipt.reclaimedBytes,
    selectedGroups:selected.length,uncompletedGroups:selected.filter(g=>!receipt.completedGroups.includes(key(g))).map(key),
    recoverable:false,receiptUpdate:receipt.receiptUpdate??'saved'};
  try{await report({kind:'cleanup-result',...result});}catch{result.outputError='retention-apply.report';}
  return result;
}
