import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
it('normal, F06 and legacy release certificates retain the existing weekly owner', () => {
  const result = spawnSync(
    'python3',
    [resolve('scripts/ci/test-weekly-payout-release-priority.py')],
    {
      encoding: 'utf8',
      timeout: 20000,
      env: { ...process.env, RUNNER_TEMP: process.env.RUNNER_TEMP || process.env.TMPDIR },
    }
  );
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
