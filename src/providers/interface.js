import { fail } from '../contracts/parse.js';

export const CAPABILITIES = Object.freeze(['skills', 'agents', 'mcp', 'entry-instructions', 'compatibility-isolation']);
export const COMPONENTS = Object.freeze({ skills: 'skills', agents: 'agents', mcp: 'mcp', entryInstructions: 'entry-instructions' });
export function requiredCapabilities(declaration) {
  const required = new Set(declaration.requires);
  let components = 0;
  for (const [field, capability] of Object.entries(COMPONENTS)) {
    if (declaration[field] !== null) { required.add(capability); components++; }
    else if (required.has(capability)) fail('provider.required-null');
  }
  if (components === 0) fail('provider.empty');
  return [...required].sort();
}
// Trusted CLI adapters only. Never dynamically import code from a pipeline package.
export function assertAdapter(adapter, id, declaration) {
  if (!adapter || adapter.id !== id || typeof adapter.version !== 'string' || !adapter.version ||
      !Array.isArray(adapter.capabilities) ||
      adapter.capabilities.some(c => !CAPABILITIES.includes(c)) ||
      new Set(adapter.capabilities).size !== adapter.capabilities.length ||
      typeof adapter.validate !== 'function' || typeof adapter.plan !== 'function') fail('provider.interface');
  for (const c of requiredCapabilities(declaration))
    if (!adapter.capabilities.includes(c)) fail('provider.unsupported');
  return adapter;
}
