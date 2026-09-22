import path from 'node:path';
import { fail } from '../contracts/parse.js';
import { absoluteRoot, pathBudget } from './paths.js';
import { planLayout } from './resolve.js';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const overlaps = (a, b) => {
  const left = a.toLowerCase(), right = b.toLowerCase();
  const relative = path.relative(left, right);
  const inside = relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
  if (inside) return true;
  const reverse = path.relative(right, left);
  return reverse === '' || (!path.isAbsolute(reverse) && reverse !== '..' && !reverse.startsWith('..' + path.sep));
};

// Internal pure intent planner, NOT a saved executable preview. No filesystem,
// Git, network, approval or installation state is inspected/changed here.
export function planRepositoryIntents(pipeline, workspace, wrapper, choices, { command, ...layoutOptions } = {}) {
  if (!['init', 'adopt', 'wrap'].includes(command)) fail('repositories.command');
  if (!record(choices)) fail('repositories.choices');
  const layout = planLayout(pipeline, workspace, wrapper, layoutOptions);
  const ids = Object.keys(layout.repositories).sort();
  if (Object.keys(choices).length !== ids.length || ids.some(id => !Object.hasOwn(choices, id)))
    fail('repositories.selection');
  const operations = [], sources = [];
  for (const id of ids) {
    const choice = choices[id];
    if (!record(choice) || !['keep', 'directory', 'init', 'clone', 'move'].includes(choice.action))
      fail('repositories.action');
    const allowed = choice.action === 'move' ? ['action', 'from'] : ['action'];
    if (Object.keys(choice).some(key => !allowed.includes(key))) fail('repositories.fields');
    if (command === 'init' && choice.action === 'move') fail('repositories.move-command');
    const target = layout.repositories[id].path;
    const operation = { repository: id, action: choice.action, target };
    if (choice.action === 'init') operation.initialization = { initialBranch:'main', templates:'disabled' };
    if (choice.action === 'clone') {
      const source = layout.layout.repositories[id].source;
      if (!source) fail('repositories.clone-source');
      // Local path base and ref must be resolved/frozen by the later IO preview.
      operation.source = structuredClone(source);
      operation.clonePolicy = {head:'detached',history:'depth-1',origin:'not-configured',templates:'disabled'};
    }
    if (choice.action === 'move') {
      const from = absoluteRoot(choice.from); pathBudget(from);
      // Do not move a wrapper ancestor, any destination or overlapping sources.
      const relative = path.relative(from.toLowerCase(), layout.wrapper.toLowerCase());
      if (relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)))
        fail('repositories.wrapper-source');
      if (Object.values(layout.repositories).some(repo => overlaps(from, repo.path)) || sources.some(source => overlaps(from, source)))
        fail('repositories.overlap');
      operation.from = from; sources.push(from);
    }
    operations.push(operation);
  }
  return { command: command === 'wrap' ? 'adopt' : command, wrapper: layout.wrapper,
    layout, operations, status: 'intent-only', filesystem: 'not-inspected', executionAuthorized: false };
}
