import { parseAllDocuments, isMap, isSeq, isScalar, isAlias } from 'yaml';

export class ContractError extends Error {
  constructor(code) { super(code); this.name = 'ContractError'; this.code = code; }
}
export const fail = code => { throw new ContractError(code); };
export const MAX_INPUT_BYTES = 2 * 1024 * 1024;

// Do not expose parser messages: they can contain source values and credentials.
export function parse(text, format = 'yaml') {
  if (typeof text !== 'string' || !['json', 'yaml'].includes(format)) fail('parse.input');
  if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) fail('parse.size');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (format === 'json') {
    try { JSON.parse(text); } catch { fail('parse.syntax'); }
  }
  let docs;
  try {
    docs = parseAllDocuments(text, { version: '1.2', schema: 'core', uniqueKeys: true,
      strict: true, prettyErrors: false, merge: false, logLevel: 'silent' });
  } catch { fail('parse.syntax'); }
  if (docs.length !== 1) fail('parse.documents');
  const doc = docs[0];
  if (doc.errors.length || doc.warnings.length) fail('parse.syntax');
  if (doc.directives.yaml.explicit && doc.directives.yaml.version !== '1.2') fail('parse.version');
  let count = 0;
  function inspect(node, depth) {
    if (++count > 50000 || depth > 64) fail('parse.complexity');
    if (node === null) return;
    if (isAlias(node) || node.anchor) fail('parse.alias');
    if (node.tag) fail('parse.tag');
  }
  function convert(node, depth) {
    inspect(node, depth);
    if (node === null) return null;
    if (isMap(node)) {
      const result = Object.create(null), keys = new Set();
      for (const pair of node.items) {
        inspect(pair.key, depth + 1);
        if (!isScalar(pair.key) || typeof pair.key.value !== 'string') fail('parse.key');
        const key = pair.key.value;
        if (keys.has(key)) fail('parse.duplicate');
        if (['__proto__', 'constructor', 'prototype', '<<'].includes(key)) fail('parse.key');
        keys.add(key);
        result[key] = convert(pair.value, depth + 1);
      }
      return result;
    }
    if (isSeq(node)) return node.items.map(n => convert(n, depth + 1));
    if (!isScalar(node)) fail('parse.type');
    const v = node.value;
    if (typeof v === 'number' && (!Number.isFinite(v) || (Number.isInteger(v) && !Number.isSafeInteger(v)))) fail('parse.number');
    if (v !== null && !['string', 'boolean', 'number'].includes(typeof v)) fail('parse.type');
    return v;
  }
  return convert(doc.contents, 0);
}
