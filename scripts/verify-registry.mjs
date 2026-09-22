import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Retry only post-publication propagation (404), never publication itself.
export async function verifyRegistry(version, integrity, {
  fetchImpl = fetch, sleep = delay, attempts = 18, interval = 10000,
  log = console.log,
} = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Invalid release version');
  const url = `https://registry.npmjs.org/@6reduk%2fworkspace-pipeline/${version}`;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(10000) });
    if (response.status === 200) {
      const metadata = await response.json();
      if (metadata.name !== '@6reduk/workspace-pipeline' || metadata.version !== version
        || metadata.dist?.integrity !== integrity) throw Error('Registry identity/integrity mismatch');
      log(`Registry integrity verified: ${version}`);
      return;
    }
    await response.body?.cancel();
    if (response.status !== 404) throw Error(`Registry HTTP ${response.status}; refusing retry`);
    if (attempt < attempts) {
      log(`Version not visible yet (${attempt}/${attempts}); waiting ${interval}ms`);
      await sleep(interval);
    }
  }
  throw Error(`Registry version ${version} unavailable after ${attempts} attempts`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = process.argv[2];
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw Error('Invalid release version');
  const bytes = readFileSync(`6reduk-workspace-pipeline-${version}.tgz`);
  await verifyRegistry(version, `sha512-${createHash('sha512').update(bytes).digest('base64')}`);
}
