import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { fail } from './parse.js';

const names = ['common', 'pipeline', 'workspace', 'inventory', 'state', 'operation'];
// Reviewed schemas use required inside not/oneOf and inherit types from parents.
const ajv = new Ajv2020({ strict: true, strictTypes: false, strictRequired: false, allErrors: false,
  ownProperties: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
for (const name of names) {
  const schema = JSON.parse(readFileSync(new URL('../../schemas/' + name + '.schema.json', import.meta.url), 'utf8'));
  ajv.addSchema(schema, name + '.schema.json');
}
// common is a reference library, not a document schema with root constraints.
const validators = new Map(names.filter(name => name !== 'common')
  .map(name => [name, ajv.getSchema(name + '.schema.json')]));
export function validateStructure(kind, value) {
  const validator = validators.get(kind);
  if (!validator) fail('schema.kind');
  if (!validator(value)) fail('schema.invalid');
  return value;
}
