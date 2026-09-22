// Child-process-only overlay, not a launcher or readiness check by itself.
// Callers still validate workspace state and choose the executable.
// This neither grants trust nor disables native plugins.
export const GROK_CLAUDE_PIPELINE_KEYS = Object.freeze([
  'GROK_CLAUDE_SKILLS_ENABLED', 'GROK_CLAUDE_RULES_ENABLED',
  'GROK_CLAUDE_AGENTS_ENABLED', 'GROK_CLAUDE_MCPS_ENABLED',
  'GROK_CLAUDE_HOOKS_ENABLED',
]);
export function grokEnvironment(parent, platform = process.platform) {
  if (!parent || typeof parent !== 'object' || Array.isArray(parent)) throw new TypeError('launch.environment');
  if (!['win32', 'linux', 'darwin'].includes(platform)) throw new TypeError('launch.platform');
  const result = Object.create(null), owned = new Set(GROK_CLAUDE_PIPELINE_KEYS);
  for (const [key, value] of Object.entries(parent)) {
    // Windows spawn must not choose an inherited differently-cased spelling.
    if (owned.has(platform === 'win32' ? key.toUpperCase() : key)) continue;
    if (value !== undefined) result[key] = value;
  }
  for (const key of owned) result[key] = 'false';
  return result;
}
