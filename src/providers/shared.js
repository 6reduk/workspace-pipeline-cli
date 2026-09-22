import { renderEntry, portablePath } from '../contracts/semantic.js';
import { fail } from '../contracts/parse.js';
import { sourceText, snapshotResourcePath, snapshotFilePath } from './source.js';
import { commonEntryPath, commonEntryText, needsCommonEntry, legacyEntryReplay } from './common-entry.js';

// Common entry has one owner, regardless of the number of selected providers.
// Ownership/conflict/approval policy remains in the ordinary planner, not here.
export const sharedAdapter = Object.freeze({
  async plan(context) {
    const selection = context.layout.agentsDocument;
    let body;
    if (selection.mode === 'source') body = sourceText(context, selection.path);
    else if (selection.mode === 'default') body = '# Workspace instructions\n\n' +
      'Start harness sessions from this wrapper. Read the selected repository instructions before making changes.\n' +
      'Read documentation from its overview toward the relevant detailed artifacts; do not scan every document by default.\n' +
      'Do not infer approval, runtime readiness or task completion from installation metadata.\n';
    else fail('entry.input');
    body = renderEntry(body, context.layout.layout);
    const lines = ['\n\n## Workspace routing\n',
      'Paths below are relative to this wrapper, not to the shell working directory.'];
    for (const [id, repo] of Object.entries(context.layout.repositories).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      portablePath(repo.relative);
      lines.push(`- Repository \`${id}\`: \`${repo.relative}\` (${repo.role}).`);
    }
    portablePath(context.layout.documentation.relative);
    lines.push(`- Project documentation: \`${context.layout.documentation.relative}\`.`);
    for (const [id, root] of Object.entries(context.layout.projectRoots).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      portablePath(root.relative);
      lines.push(`- Project root \`${id}\`: \`${root.relative}\`.`);
    }
    lines.push(`- Pipeline resources: \`${snapshotResourcePath(context)}\`.`,
      'The snapshot identifier locates installed resources; it does not pin project documents or grant task approval.');
    // Keep common entry stable when one installed provider is removed. These are
    // available source routes, not a claim that all providers are enabled.
    for (const id of Object.keys(context.pipeline.providers ?? {}).sort()) {
      const entry = context.pipeline.providers[id].entryInstructions;
      if (entry !== null) lines.push(`If using ${id}, read its [provider instructions](<${snapshotFilePath(context, entry)}>) before acting. This link does not enable that provider.`);
    }
    const bytes = Buffer.from(body + lines.join('\n') + '\n', 'utf8');
    if (bytes.length > 2 * 1024 * 1024) fail('entry.input');
    const requests = [{ path: 'AGENTS.md', owner: 'shared', kind: 'file', bytes }];
    const bundle = Object.values(context.layout.bundles ?? {})[0];
    if (bundle) {
      const entry = renderEntry(sourceText(context, bundle.entry.source), context.layout.layout);
      if (!entry.trim() || entry.includes('\0')) fail('entry.input');
      requests.push({ path: bundle.entry.target, owner: 'shared', kind: 'file', bytes: Buffer.from(entry) });
    } else if (needsCommonEntry(context.layout.providers ?? context.workspace.providers) && !legacyEntryReplay(context))
      requests.push({ path: commonEntryPath, owner: 'shared', kind: 'file', bytes: Buffer.from(commonEntryText) });
    return requests;
  }
});
