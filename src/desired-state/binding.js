import {fail,parse} from '../contracts/parse.js';
import {validateStructure} from '../contracts/validate.js';
import {contractDigest,validateLayoutReferences} from '../contracts/semantic.js';
import {sha256} from '../source/inventory.js';

// Provenance of an acquired Git package, not a signature or a pin on project rules.
export function validateDesiredBinding(value) {
  const binding=parse(JSON.stringify(value),'json');
  if(!binding || Object.keys(binding).sort().join(',')!=='commit,digest,layout,source' ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(binding.commit) ||
      !/^sha256:[a-f0-9]{64}$/.test(binding.digest))fail('desired.binding-invalid');
  validateStructure('workspace',{schemaVersion:1,pipeline:binding.source,providers:['codex'],layout:binding.layout});
  validateLayoutReferences(binding.layout);
  return binding;
}

export function bindDesiredSource(value,source) {
  if(value===undefined)return undefined; // Internal fixtures/older records may lack Git provenance.
  const binding=validateDesiredBinding(value);
  const actual=contractDigest(Object.fromEntries([...source].map(([name,bytes])=>[name,sha256(bytes)])));
  if(actual!==binding.digest)fail('desired.binding-source-mismatch');
  return binding;
}
