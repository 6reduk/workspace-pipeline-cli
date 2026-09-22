import { fail } from '../contracts/parse.js';

// Declarative membership only. Native formats and destination roots stay in
// trusted compiled adapters; packages cannot provide executable adapters.
export function resolveProviders(pipeline, workspace) {
  const assigned = new Set();
  for (const bundle of Object.values(pipeline.bundles ?? {})) {
    for (const id of bundle.providers) {
      if (!Object.hasOwn(pipeline.providers, id)) fail('bundle.provider-absent');
      if (assigned.has(id)) fail('bundle.overlap');
      assigned.add(id);
    }
  }
  const providers = new Set(workspace.providers ?? []), bundles = {};
  for (const key of workspace.bundles ?? []) {
    const bundle = Object.hasOwn(pipeline.bundles??{},key) ? pipeline.bundles[key] : undefined;
    if (!bundle) fail('bundle.absent');
    for (const id of bundle.providers) {
      if (providers.has(id)) fail('bundle.selection-overlap');
      providers.add(id);
    }
    bundles[key] = structuredClone(bundle);
  }
  // A selected standalone member of a declared bundle would create a second
  // lifecycle for the same entry. Old sources without bundles still work.
  if ((workspace.providers ?? []).some(id => assigned.has(id))) fail('bundle.select-bundle');
  return { providers: [...providers].sort(), ...(Object.keys(bundles).length ? { bundles } : {}) };
}

export function installedSelection(active) {
  const members = new Set(Object.values(active.bundles ?? {}).flatMap(b => b.providers));
  return { providers: active.providers.filter(id => !members.has(id)),
    ...(active.bundles ? { bundles: Object.keys(active.bundles).sort() } : {}) };
}

export function validateInstalledBundles(active) {
  const seen = new Set();
  for (const bundle of Object.values(active.bundles ?? {})) for (const id of bundle.providers) {
    if (seen.has(id) || !active.providers.includes(id)) fail('bundle.state-membership');
    seen.add(id);
  }
}
