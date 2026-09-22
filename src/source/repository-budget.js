import { fail } from '../contracts/parse.js';

export const REPOSITORY_TRANSPORT_LIMITS = Object.freeze({
  packLimit: 100 * 1024 * 1024 * 1024,
  gitMs: 30 * 60 * 1000,
  acquisitionMs: 2 * 60 * 60 * 1000
});

export function repositoryBudget(options = {}) {
  const result = {};
  for (const [key, maximum] of Object.entries(REPOSITORY_TRANSPORT_LIMITS)) {
    const value = options[key] ?? maximum;
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) fail('repository-source.' + key + '-limit');
    result[key] = value;
  }
  if (result.gitMs > result.acquisitionMs) fail('repository-source.time-limits');
  return result;
}
