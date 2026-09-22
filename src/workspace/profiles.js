import { validateBundle } from '../contracts/semantic.js';

// Pipeline is the verified manifest of the selected S2 snapshot, not a live ref.
// No filesystem/network lookup or merging is performed at this boundary.
export function selectProfile(pipeline, workspace, adapters) {
  const selected = validateBundle(pipeline, workspace, adapters);
  return structuredClone({ ...selected, profile: workspace.profile ?? null });
}
