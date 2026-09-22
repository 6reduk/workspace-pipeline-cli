import { fail, MAX_INPUT_BYTES } from '../contracts/parse.js';
import { sourceText } from './source.js';
import { skills, agents, mcp } from './native.js';

// Direct, workspace-local delivery. No plugin installation, mutable cache,
// account settings, trust grants or harness invocation.
const capabilities = Object.freeze(['skills', 'agents', 'mcp', 'entry-instructions']);
function render(context) {
  const declaration = context.pipeline.providers.kimi;
  if (!declaration || declaration.requires.some(value => !capabilities.includes(value))) fail('provider.unsupported');
  const requests = [];
  if (declaration.skills !== null) requests.push(...skills(context, 'kimi', declaration.skills));
  if (declaration.agents !== null) requests.push(...agents(context, 'kimi', declaration.agents).requests);
  if (declaration.mcp !== null) requests.push({ owner: 'kimi', path: '.kimi-code/mcp.json',
    kind: 'json-fields', fields: mcp(context, 'kimi', declaration.mcp) });
  // Shared adapter owns AGENTS.md and its provider entry link.
  if (declaration.entryInstructions !== null) {
    const value = sourceText(context, declaration.entryInstructions);
    if (!value.trim() || value.includes('\0') || Buffer.byteLength(value) > MAX_INPUT_BYTES) fail('provider.format');
  }
  return requests;
}
export const kimiAdapter = Object.freeze({ id: 'kimi', version: '1', capabilities,
  async validate(context) { render(context); return { valid: true, runtime: 'not-run' }; },
  async plan(context) { return render(context); },
});
