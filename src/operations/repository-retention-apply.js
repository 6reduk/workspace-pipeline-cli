import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {mkdir,unlink,rmdir,lstat} from 'node:fs/promises';
import {scanRepositoryRetention,inspectRepositoryRetentionFiles} from './repository-retention.js';
import {assertLockHeld} from './lock.js';
import {withRecoveryLease,assertRecoveryLeaseHeld} from './recovery-lease.js';
import {writeCheckedFile} from './apply.js';
import {readRecord} from './state.js';
import {contractDigest} from '../contracts/semantic.js';
import {sha256} from '../source/inventory.js';
import {parse,fail} from '../contracts/parse.js';
import {inspectDirectory} from '../workspace/paths.js';

// Caller holds an ordinary workspace lock; the kernel lease also excludes
// recovery writers. Every deletion is an exact inspected file or empty directory.
export async function applyRepositoryRetention(lock,preview,approval,{boundary=async()=>{},report=async()=>{}}={}) {
  await assertLockHeld(lock);
  return withRecoveryLease(lock.workspace,async lease=>{
    const p=parse(JSON.stringify(preview),'json'),{digest,...body}=p;
    if(p.kind!=='repository-retention-preview'||!p.complete||p.workspace!==lock.workspace||contractDigest(body)!==digest||
      contractDigest(approval)!==contractDigest({decision:'approve',previewDigest:digest}))fail('repository-retention.approval');
    const fresh=await scanRepositoryRetention(lock.workspace,{policy:p.retention.policy,now:p.retention.now,currentRuns:p.currentRuns});
    if(contractDigest(fresh)!==contractDigest(p))fail('repository-retention.drift');
    const selected=p.retention.selected.map(s=>p.groups.find(g=>g.id===s.id));
    if(selected.some(g=>!g||g.status!=='completed'||g.protectionReasons.length||g.paths.length!==2))fail('repository-retention.scope');
    if(!selected.length)return {status:'completed',removedGroups:0,removedFiles:0,reclaimedBytes:0,receiptPath:null,recoverable:false};
    const runId=randomUUID(),relative='.pipeline/repository-cleanup/'+runId+'.json',filename=path.join(lock.workspace,relative),directory=path.dirname(filename);
    const receipt={schemaVersion:1,kind:'repository-retention-result',runId,workspace:lock.workspace,previewDigest:digest,
      authorization:approval,policy:p.retention.policy,status:'in-progress',recoverable:false,
      selected:selected.map(g=>({id:g.id,files:g.files.map(f=>({path:f.path,hash:f.hash})),paths:g.paths})),
      removedFiles:[],removedDirectories:[],completedGroups:[],currentFile:null,reclaimedBytes:0,error:null};
    parse(JSON.stringify(receipt),'json');
    let receiptHash=null,created=false,directoryCreated=false;const removed=new Set();
    const save=async()=>{
      await assertRecoveryLeaseHeld(lease);const bytes=Buffer.from(JSON.stringify(receipt)+'\n');
      await writeCheckedFile(lock,relative,receiptHash,bytes,undefined,async phase=>{if(phase==='opened')created=true;});receiptHash=sha256(bytes);created=true;
    };
    const guard=async()=>{
      await assertLockHeld(lock);await assertRecoveryLeaseHeld(lease);
      const actual=await inspectRepositoryRetentionFiles(lock.workspace);
      if(created) {
        if((await readRecord(filename)).digest!==receiptHash)fail('repository-retention.receipt-drift');
        actual.files=actual.files.filter(f=>f.path!==filename);
      }
      if(directoryCreated)actual.directories=actual.directories.filter(d=>d.path!==directory);
      const expected={files:p.inventory.files.filter(f=>!removed.has(f.path)),directories:p.inventory.directories.filter(d=>!removed.has(d.path))};
      if(contractDigest(actual)!==contractDigest(expected))fail('repository-retention.drift');
    };
    try {
      await report({kind:'cleanup-location',runId,path:filename,status:'planned'});await guard();
      directoryCreated=!(await inspectDirectory(directory)).exists;
      if(directoryCreated)await mkdir(directory);
      await save();await report({kind:'cleanup-location',runId,path:filename,status:'created'});
      for(const group of selected) {
        await boundary('before-group',{id:group.id});await guard();
        for(const file of group.files) {
          receipt.currentFile=file.path;await save();await boundary('before-file',{path:file.path});await guard();
          await inspectDirectory(path.dirname(file.path));const info=await lstat(file.path);
          if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||String(info.dev)!==file.dev||String(info.ino)!==file.ino)fail('repository-retention.drift');
          await unlink(file.path);removed.add(file.path);receipt.removedFiles.push(file.path);receipt.reclaimedBytes+=file.bytes;
          await boundary('file-removed',{path:file.path});receipt.currentFile=null;await save();
        }
        for(const dir of [...group.paths].sort((a,b)=>b.length-a.length)) {
          await guard();await inspectDirectory(dir);await rmdir(dir);removed.add(dir);receipt.removedDirectories.push(dir);await save();
        }
        receipt.completedGroups.push(group.id);await save();
      }
      await guard();receipt.status='completed';await save();
    }catch(error){receipt.status='failed';receipt.error=error.code??'repository-retention.io';try{if(created)await save();}catch{receipt.receiptUpdate='failed';}}
    const result={status:receipt.status,error:receipt.error,runId,receiptPath:filename,receiptCreated:created,
      removedGroups:receipt.completedGroups.length,removedFiles:receipt.removedFiles.length,reclaimedBytes:receipt.reclaimedBytes,
      uncompletedGroups:selected.filter(g=>!receipt.completedGroups.includes(g.id)).map(g=>g.id),recoverable:false,receiptUpdate:receipt.receiptUpdate??'saved'};
    try{await report({kind:'cleanup-result',...result});}catch{result.outputError='repository-retention.report';}return result;
  });
}
