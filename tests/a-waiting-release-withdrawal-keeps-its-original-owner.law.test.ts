import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('qualifies exact waiting attempt admission and its original terminal signal boundary', () => {
  const result = spawnSync(
    'python3',
    ['-B', 'tests/operations/waiting-engine-release-withdrawal.test.py'],
    {
      cwd: resolve(import.meta.dirname, '..'),
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      encoding: 'utf8',
      timeout: 15000,
    }
  );
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stderr).toContain('Ran 9 tests');
});
