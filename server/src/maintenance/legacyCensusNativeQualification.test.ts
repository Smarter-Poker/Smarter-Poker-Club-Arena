import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

// The existing required Linux server shards must execute the production runtime.
// macOS prechecks cannot substitute their native timing for this qualification.
it.skipIf(process.platform !== 'linux')(
  'qualifies retained-owner census identities, interruption safety and loaded production runtime',
  () => {
    const run = spawnSync(process.execPath, ['tests/operations/legacy-census-container.mjs'], {
      cwd: resolve('..'),
      encoding: 'utf8',
      timeout: 215000,
      killSignal: 'SIGKILL',
      maxBuffer: 524288,
    });
    expect(run.error?.message ?? null, run.stderr).toBeNull();
    expect(run.signal, run.stderr).toBeNull();
    expect(run.status, run.stderr).toBe(0);
    const receipt = JSON.parse(run.stdout.trim());
    expect(receipt).toMatchObject({
      ok: true,
      nativeVersion: 'v22.23.2',
      platform: 'linux',
      image: 'node:22-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5',
    });
    expect(Object.keys(receipt.results).sort()).toEqual(['interruption', 'loaded', 'projection']);
  },
  225000
);
