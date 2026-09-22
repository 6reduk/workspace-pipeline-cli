import { fail, MAX_INPUT_BYTES } from '../contracts/parse.js';
import { sourceText } from './source.js';
import { skills, agents, mcp } from './native.js';

// Direct component rendering only. Compatibility isolation requires the separate
// launch path; installing these files does not certify an ordinary `grok` launch.
const capabilities = Object.freeze(['skills', 'agents', 'mcp', 'entry-instructions']);
function render(context) {
  const declaration = context.pipeline.providers.grok;
  if (!declaration || declaration.requires.some(value => !capabilities.includes(value))) fail('provider.unsupported');
  const requests = [];
  if (declaration.skills !== null) requests.push(...skills(context, 'grok', declaration.skills));
  if (declaration.agents !== null) requests.push(...agents(context, 'grok', declaration.agents).requests);
  if (declaration.mcp !== null) requests.push({ owner: 'grok', path: '.grok/config.toml',
    kind: 'toml-fields', fields: mcp(context, 'grok', declaration.mcp) });
  // The common AGENTS.md owner supplies the provider instruction link.
  if (declaration.entryInstructions !== null) {
    const value = sourceText(context, declaration.entryInstructions);
    if (!value.trim() || value.includes('\0') || Buffer.byteLength(value) > MAX_INPUT_BYTES) fail('provider.format');
  }
  return requests;
}
export const grokAdapter = Object.freeze({ id: 'grok', version: '2', capabilities,
  async validate(context) { render(context); return { valid: true, runtime: 'not-run' }; },
  async plan(context) { return render(context); },
});
