// Presentation boundary only: internal command results and saved JSON contracts
// remain unchanged. Never infer success from the shape of a rendered result.
export const safeTerminalText = value => String(value).replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const safe = safeTerminalText;
const privateKey = /bytes|base64|content|secret|token|password/i;

export function formatResult(value) {
  if (value && typeof value.ready === 'boolean' && Array.isArray(value.diagnostics)) {
    const lines = ['Workspace Pipeline — doctor', '',
      `Workspace: ${safe(value.workspace ?? '(not reported)')}`,
      `Status: ${value.ready ? 'READY' : 'NOT READY'} (${safe(value.status ?? 'unknown')})`];
    if (value.pipeline) lines.push(`Pipeline: ${safe(value.pipeline.id)} @ ${safe(value.pipeline.version)}`,
      `Providers: ${value.pipeline.providers.map(safe).join(', ')}`);
    for (const key of ['configuration', 'transactionEvidence']) if (value[key] !== undefined) lines.push(`${key}: ${safe(value[key])}`);
    if(value.compatibility)lines.push(`Grok / Claude compatibility: ${safe(value.compatibility.status)}`,
      ...(value.compatibility.path?[`User config: ${safe(value.compatibility.path)}`]:[]),
      ...(value.compatibility.blockers??[]).map(b=>`  - ${safe(b)}`),
      `Native compatibility inspection: ${safe(value.compatibility.native?.status??'not-run')}.`,
      'Native discovery is not model/agent/MCP execution certification.');
    lines.push('', `Diagnostics: ${value.diagnostics.length}`);
    for (const item of value.diagnostics) lines.push(`  - ${safe(item.code)}${item.subject ? ': ' + safe(item.subject) : ''}${item.pointer ? ' ' + safe(item.pointer) : ''}`);
    lines.push('', 'Runtime / model-visible skills / MCP: not verified by doctor.',
      'Full report: repeat with --json.');
    return lines.join('\n') + '\n';
  }
  const lines = ['Workspace Pipeline', ''];
  function render(node, indent = '', depth = 0) {
    if (node === null || typeof node !== 'object') { lines.push(indent + safe(node)); return; }
    if (depth > 5) { lines.push(indent + '(details omitted; use --json)'); return; }
    const entries = Object.entries(node);
    for (const [key, item] of entries.slice(0, 40)) {
      const label = indent + safe(key) + ':';
      if (privateKey.test(key)) lines.push(label + ' (private payload; use --json)');
      else if (item !== null && typeof item === 'object') { lines.push(label); render(item, indent + '  ', depth + 1); }
      else { const text=safe(item); lines.push(label + ' ' + (text.length>500?text.slice(0,500)+' (truncated; use --json)':text)); }
    }
    if (entries.length > 40) lines.push(indent + `(${entries.length - 40} more entries; use --json)`);
  }
  render(value);
  lines.push('', 'For complete machine output or a saved apply preview, repeat with --json.',
    'This display is not an apply preview. JSON may contain private configuration.');
  return lines.join('\n') + '\n';
}

export function outputWriter(write, json) {
  if (json) return write;
  return text => {
    let value;
    try { value = JSON.parse(text); } catch { return write(text); }
    return write(formatResult(value));
  };
}
