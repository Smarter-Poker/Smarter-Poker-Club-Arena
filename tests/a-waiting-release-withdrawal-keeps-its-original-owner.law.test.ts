import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
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
  expect(result.stderr).toContain('Ran 10 tests');
});

it('keeps the revoked off-cycle owner order closed', () => {
  const windows = JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, '../server/release/owner-maintenance-windows.json'),
      'utf8'
    )
  );
  expect(windows).toEqual({ version: 1, windows: [] });
});
