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
  expect(windows.version).toBe(1);
  // The withdrawn river order stays withdrawn. A later explicit owner order
  // for a different assignment is separately bounded and qualified by the
  // maintenance-window tests; it does not revive that revoked authority.
  expect(windows.windows.some((w: { id: string }) => w.id === '2026-10-23-river-nuts-v2')).toBe(
    false
  );
  expect(
    windows.windows.some(
      (w: { contains: string }) => w.contains === '6416f795ba314647f381856f1dd645be48920f22'
    )
  ).toBe(false);
});
