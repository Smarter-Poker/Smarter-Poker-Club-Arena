import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('keeps authoritative rolling-hour eligibility inside the existing owner minute', () => {
  const result = spawnSync(
    'python3',
    ['-B', resolve('tests/operations/recovery-rolling-eligibility.py')],
    {
      encoding: 'utf8',
      timeout: 30_000,
    }
  );
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stderr).toContain('Ran 9 tests');
}, 35_000);
