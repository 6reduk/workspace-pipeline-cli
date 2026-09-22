import { fail } from '../contracts/parse.js';

export const RESERVED = Object.freeze(['.pipeline', '.codex', '.claude', '.kimi-code',
  '.grok', '.agents', '.git', '.mcp.json', 'AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md', 'GROK.md', 'workspace.yaml']);
export function assertUnreserved(relative) {
  if (RESERVED.some(name => name.toLowerCase() === relative.split('/')[0].toLowerCase())) fail('layout.reserved');
}
export function overlaps(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}
