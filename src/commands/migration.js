import {absoluteRoot} from '../workspace/paths.js';
import {fail} from '../contracts/parse.js';
import {prepareLegacyUnityPreview} from '../migrations/legacy-unity-preview.js';
import {prepareLegacyUnityDeactivationResume} from '../migrations/legacy-unity-deactivation-resume.js';
import {prepareLegacyUnityInstallResume} from '../migrations/legacy-unity-install-resume.js';
import {prepareLegacyUnityInstallRecovery} from '../migrations/legacy-unity-install-recovery.js';
import {prepareLegacyUnityCloseoutResume} from '../migrations/legacy-unity-resume.js';
import {prepareLegacyUnityCompensation} from '../migrations/legacy-unity-compensate.js';
import {bindMigrationInstaller,readInstallerIdentity} from '../operations/installer-identity.js';
import {contractDigest} from '../contracts/semantic.js';
import {runMigrationApply} from './migration-apply.js';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

const inspectors={deactivation:prepareLegacyUnityDeactivationResume,installation:prepareLegacyUnityInstallResume,
 recovery:prepareLegacyUnityInstallRecovery,closeout:prepareLegacyUnityCloseoutResume,compensation:prepareLegacyUnityCompensation};
export function parseMigrationCommand(args){
 if(args[1]!=='unity'||!['preview','inspect','apply'].includes(args[2]))fail('cli.arguments');
 const result={command:'migration',action:args[2]},seen=new Set();
 const allowed=result.action==='apply'?['--workspace','--preview','--json']:result.action==='preview'?['--workspace','--manifest','--json']:['--workspace','--recovery','--phase','--json'];
 for(let i=3;i<args.length;i++){
  const flag=args[i];if(!allowed.includes(flag)||seen.has(flag))fail('cli.arguments');seen.add(flag);
  if(flag==='--json')continue;
  const value=args[++i];if(value===undefined||value.startsWith('--'))fail('cli.arguments');
  if(flag==='--workspace')result.workspace=absoluteRoot(value);
  if(flag==='--manifest')result.manifestPath=absoluteRoot(value);
  if(flag==='--recovery')result.recoveryPath=value;
  if(flag==='--phase')result.phase=value;
  if(flag==='--preview')result.previewFile=absoluteRoot(value);
 }
 if(!result.workspace)fail('cli.workspace-required');
 if(result.action==='preview'&&!result.manifestPath)fail('cli.arguments');
 if(result.action==='apply'&&!result.previewFile)fail('cli.arguments');
 if(result.action==='inspect'&&(!Object.hasOwn(inspectors,result.phase??'')||typeof result.recoveryPath!=='string'||
  !/^\.pipeline\/migrations\/[a-f0-9-]{36}\/recovery\.json$/.test(result.recoveryPath)))fail('cli.arguments');
 return result;
}
export async function runMigrationCommand(command,stdout,stderr){
 if(command.action==='apply')return runMigrationApply(command,stdout,stderr);
 await stderr('Migration preview may contain private configuration bytes. Save it locally; do not publish it. Inspect before explicit apply.\n');
 const before=await readInstallerIdentity();
 const result=command.action==='preview'?await prepareLegacyUnityPreview({wrapper:command.workspace,manifestPath:command.manifestPath,network:true,
  tempRoot:await mkdtemp(path.join(tmpdir(),'wpc-migration-prepare-'))}):
  await inspectors[command.phase](command.workspace,command.recoveryPath);
 const bound=await bindMigrationInstaller(result);
 if(contractDigest(before)!==contractDigest(bound.installer))fail('installer.changed');
 await stdout(JSON.stringify(bound)+'\n');return result.status==='blocked'?1:0;
}
