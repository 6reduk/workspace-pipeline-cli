import path from 'node:path';
import {readRecord} from '../operations/state.js';
import {verifyMigrationInstaller} from '../operations/installer-identity.js';
import {beginLegacyUnityMigration} from '../migrations/legacy-unity-begin.js';
import {applyLegacyUnityDeactivationResume} from '../migrations/legacy-unity-deactivation-resume-apply.js';
import {applyLegacyUnityInstallResume} from '../migrations/legacy-unity-install-resume.js';
import {applyLegacyUnityInstallRecovery} from '../migrations/legacy-unity-install-recovery.js';
import {applyLegacyUnityCloseoutResume} from '../migrations/legacy-unity-resume-apply.js';
import {applyLegacyUnityCompensation} from '../migrations/legacy-unity-compensate.js';
import {fail} from '../contracts/parse.js';

const writers={
 'legacy-unity-deactivation-resume-preview':applyLegacyUnityDeactivationResume,
 'legacy-unity-install-resume-preview':applyLegacyUnityInstallResume,
 'legacy-unity-install-recovery-preview':applyLegacyUnityInstallRecovery,
 'legacy-unity-closeout-preview':applyLegacyUnityCloseoutResume,
 'legacy-unity-compensation-preview':applyLegacyUnityCompensation
};
export async function runMigrationApply(command,stdout,stderr){
 const envelope=(await readRecord(command.previewFile)).value;
 const preview=await verifyMigrationInstaller(envelope);
 if(!preview||preview.workspace!==command.workspace||typeof preview.digest!=='string')fail('migration.preview-binding');
 if(preview.kind!=='legacy-unity-preview'&&!Object.hasOwn(writers,preview.kind))fail('migration.preview-binding');
 const approval={decision:'approve',previewDigest:preview.digest};
 await stderr('Applying the exact saved migration preview. Stop harness sessions and config editors. No automatic rollback.\n');
 let result;
 if(preview.kind==='legacy-unity-preview'){
  const begun=await beginLegacyUnityMigration(preview,approval,command.workspace);
  try{
   await stderr(JSON.stringify({recovery:path.resolve(command.workspace,begun.recoveryPath),
    logs:path.resolve(command.workspace,path.dirname(begun.recoveryPath))})+'\n');
   await verifyMigrationInstaller(envelope);
   const phase=await begun.deactivate();
   if(phase.outcome!=='completed')result={...phase,recoveryPath:begun.recoveryPath};
   else{
    await verifyMigrationInstaller(envelope);
    const installed=await begun.install();
    if(installed.installationStatus!=='ready')result={...installed,migrationRecoveryPath:begun.recoveryPath};
    else{
     await verifyMigrationInstaller(envelope);
     result={...await begun.finalize(),migrationRecoveryPath:begun.recoveryPath};
    }
   }
  }finally{await begun.lock.release();}
 }else{
  await stderr(JSON.stringify({recovery:path.resolve(command.workspace,preview.recoveryPath),
   logs:path.resolve(command.workspace,path.dirname(preview.recoveryPath))})+'\n');
  await verifyMigrationInstaller(envelope);
  result=await writers[preview.kind](preview,approval,command.workspace);
 }
 await stdout(JSON.stringify(result)+'\n');
 return ['completed','legacy-restored'].includes(result.status)?0:1;
}
