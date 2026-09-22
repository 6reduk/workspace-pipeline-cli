import {readdir,lstat,readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sha256} from '../source/inventory.js';
import {contractDigest} from '../contracts/semantic.js';
import {parse,fail} from '../contracts/parse.js';

const installedRoot=fileURLToPath(new URL('../../',import.meta.url));
// Root override is a trusted test seam, never an argv/source-package option.
export async function readInstallerIdentity(root=installedRoot){
 root=path.resolve(root);const files=[];let total=0;
 const walk=async(relative,depth=0)=>{
  if(depth>32||files.length>=2048)fail('installer.inventory-limit');
  const filename=path.join(root,relative),before=await lstat(filename);
  if(before.isSymbolicLink())fail('installer.inventory-link');
  if(before.isDirectory()){
   const names=(await readdir(filename)).sort();if(names.length>2048)fail('installer.inventory-limit');
   for(const name of names)await walk(relative+'/'+name,depth+1);
  }else{
   if(!before.isFile()||before.size>2*1024*1024||total+before.size>64*1024*1024)fail('installer.inventory-limit');
   const bytes=await readFile(filename),after=await lstat(filename);
   if(!after.isFile()||after.isSymbolicLink()||before.ino!==after.ino||before.dev!==after.dev||
    before.mtimeMs!==after.mtimeMs||before.size!==after.size||bytes.length!==before.size)fail('installer.inventory-drift');
   total+=bytes.length;files.push({path:relative,hash:sha256(bytes)});
  }
 };
 await walk('package.json');await walk('src');await walk('schemas');
 const packageBytes=await readFile(path.join(root,'package.json'));
 if(sha256(packageBytes)!==files.find(f=>f.path==='package.json').hash)fail('installer.inventory-drift');
 const manifest=parse(packageBytes.toString('utf8'),'json');
 if(typeof manifest.name!=='string'||typeof manifest.version!=='string')fail('installer.package');
 const body={schemaVersion:1,kind:'installer-payload-identity',name:manifest.name,version:manifest.version,
  files:files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)};
 return {...body,digest:contractDigest(body)};
}

export async function bindMigrationInstaller(preview,root=installedRoot){
 const installer=await readInstallerIdentity(root);
 const body={schemaVersion:1,kind:'installer-bound-migration-preview',installer,preview};
 const record={...body,digest:contractDigest(body)};
 // Enforce saved-record reader bounds before emitting an unusable preview.
 parse(JSON.stringify(record),'json');return record;
}
export async function verifyMigrationInstaller(record,root=installedRoot){
 const copy=parse(JSON.stringify(record),'json'),{digest,...body}=copy;
 if(copy.kind!=='installer-bound-migration-preview'||copy.schemaVersion!==1||contractDigest(body)!==digest)fail('installer.preview-binding');
 if(contractDigest(await readInstallerIdentity(root))!==contractDigest(copy.installer))fail('installer.changed');
 return copy.preview;
}
