import {checkEntries,LIMITS,cap,utf8,sha256} from './inventory.js';
import {parse,fail} from '../contracts/parse.js';
import {contractDigest} from '../contracts/semantic.js';
import {compileDesiredManifest} from '../contracts/desired-state.js';
import {materializeDesiredFiles} from '../desired-state/inventory.js';

// Git already identifies the immutable tree and blobs. V2 computes its source
// inventory instead of requiring a second hand-maintained installation plan.
export async function verifyDesiredPackage(entries,readBlob) {
  checkEntries(entries);
  const manifests=entries.filter(e=>['pipeline.json','pipeline.yaml','pipeline.yml'].includes(e.path));
  if(manifests.length!==1)fail('source.manifest');
  cap(manifests[0].size,LIMITS.manifest,'source.metadata-size');
  const files=new Map();
  for(const entry of entries) {
    const bytes=await readBlob(entry);
    if(!Buffer.isBuffer(bytes)||bytes.length!==entry.size)fail('source.blob-size');
    if(bytes.subarray(0,200).toString('ascii').startsWith('version https://git-lfs.github.com/spec/v1'))fail('source.lfs');
    files.set(entry.path,bytes);
  }
  const manifestPath=manifests[0].path;
  const manifest=parse(utf8(files.get(manifestPath)),manifestPath.endsWith('.json')?'json':'yaml');
  // Compile each delivery separately: different alternatives may intentionally
  // serve the same provider; selecting both later still rejects collisions.
  if(!manifest.adapters || typeof manifest.adapters!=='object')fail('desired.schema');
  const serialized=JSON.stringify(manifest);
  for(const id of Object.keys(manifest.adapters))
    materializeDesiredFiles(compileDesiredManifest(serialized,{selected:[id]}),files);
  if(!Object.keys(manifest.adapters).length)fail('desired.schema');
  const fileHashes=Object.fromEntries([...files].map(([name,bytes])=>[name,sha256(bytes)]));
  const digest=contractDigest(fileHashes);
  return {manifest,manifestPath,files,fileHashes,digest,inventoryDigest:digest};
}
