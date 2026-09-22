import path from 'node:path';
import { fail } from '../contracts/parse.js';
import { portablePath } from '../contracts/semantic.js';
import { selectProfile } from './profiles.js';
import { assertUnreserved, overlaps } from './reserved.js';
import { absoluteRoot, pathBudget, resolveChild, inspectDirectory } from './paths.js';

// Pure path map. missing/existing Git repos and provider discovery are not certified.
export function planLayout(pipeline, workspace, wrapper, { adapters, managedPaths = [] } = {}) {
  const selected = selectProfile(pipeline, workspace, adapters);
  const root = absoluteRoot(wrapper); pathBudget(root);
  const { layout } = selected, repositories = {}, projectRoots = {}, warnings = [];
  for (const target of managedPaths) portablePath(target);
  const entries = Object.entries(layout.repositories).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const spellings = new Map();
  const registerSpelling = relative => {
    const parts = relative.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/'), key = prefix.toLowerCase();
      if (spellings.has(key) && spellings.get(key) !== prefix) fail('layout.case-alias');
      spellings.set(key, prefix);
    }
  };
  for (const target of managedPaths) registerSpelling(target);
  for (const [id, repo] of entries) {
    assertUnreserved(repo.path);
    registerSpelling(repo.path);
    if (Object.values(repositories).some(r => overlaps(r.relative, repo.path)) ||
      managedPaths.some(target => overlaps(target, repo.path))) fail('layout.overlap');
    repositories[id] = { relative: repo.path, path: resolveChild(root, repo.path), role: repo.role };
    if (repo.role === 'documentation' && layout.documentation.repository !== id)
      warnings.push({ code: 'layout.unused-documentation-role', repository: id });
  }
  const reference = ref => {
    const relative = path.posix.join(layout.repositories[ref.repository].path, ref.path);
    portablePath(relative);
    registerSpelling(relative);
    return { repository: ref.repository, relative, path: resolveChild(root, relative) };
  };
  const documentation = reference(layout.documentation);
  for (const id of Object.keys(layout.projectRoots ?? {}).sort()) projectRoots[id] = reference(layout.projectRoots[id]);
  return { ...selected, wrapper: root, repositories, documentation, projectRoots, warnings, filesystem: 'not-inspected', runtime: 'not-run' };
}
export async function resolveLayout(pipeline, workspace, wrapper, options) {
  const result = planLayout(pipeline, workspace, wrapper, options);
  // No mkdir/clone/move even for a not-yet-created wrapper. Existing ancestors
  // are inspected; missing paths remain planned paths, never readiness PASS.
  const observations = {};
  const targets = [result.wrapper, ...Object.values(result.repositories).map(r => r.path),
    result.documentation.path, ...Object.values(result.projectRoots).map(r => r.path)];
  for (const target of new Set(targets)) observations[target] = await inspectDirectory(target);
  return { ...result, filesystem: 'inspected', observations };
}
