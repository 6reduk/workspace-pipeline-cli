import { CAPABILITIES } from '../../src/providers/interface.js';
// S1 contract double only: no harness lookup, I/O, MCP or native plugin behaviour.
export const providerDouble = id => Object.freeze({
  id, version: 'test-double-1', capabilities: [...CAPABILITIES],
  validate: () => ({ runtime: 'not-run' }),
  plan: () => []
});
