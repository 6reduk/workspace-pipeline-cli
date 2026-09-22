import {fail} from '../contracts/parse.js';

export const MAX_CONTINUATION_DEPTH=32;
const recoveryPath=/^\.pipeline\/transactions\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/recovery\.json$/;

export function assertContinuationCapacity(depth) {
  if(!Number.isSafeInteger(depth) || depth<0 || depth>=MAX_CONTINUATION_DEPTH)fail('reconciliation.depth');
}

// One guard per traversal. Reject before opening the next record; package data
// cannot change this limit or supply an alternative identity for the same path.
export function createLineageGuard() {
  const seen=new Set();
  return Object.freeze({visit(path) {
    if(typeof path!=='string' || !recoveryPath.test(path))fail('reconciliation.lineage');
    if(seen.has(path))fail('reconciliation.cycle');
    assertContinuationCapacity(seen.size);
    seen.add(path);
  }});
}
