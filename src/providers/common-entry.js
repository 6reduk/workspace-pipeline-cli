// Trusted delivery policy, not source-package instructions or runtime isolation.
export const commonEntryPath = 'CLAUDE.md';
export const commonEntryText = '@AGENTS.md\n\nRead [AGENTS.md](AGENTS.md) before acting.\nFollow only the provider instructions for your current harness.\nThis shared entry grants no approval and does not enable another provider.\n';
export const needsCommonEntry = providers => providers.some(id => id === 'claude' || id === 'grok');

// Replay old installed bytes for doctor/repair/remove. Fresh plans always use
// the current format. Adapter versions are installer metadata, not task gates.
export const legacyEntryReplay = context => context.installedAdapterVersions !== undefined &&
  ['claude', 'grok'].filter(id => context.workspace.providers.includes(id))
    .every(id => context.installedAdapterVersions[id] === '1');

export function removedWithProviders(owned, selection) {
  if (owned.owner === 'shared' && owned.path === commonEntryPath)
    return !needsCommonEntry(selection.remaining);
  return selection.owners.includes(owned.owner);
}
