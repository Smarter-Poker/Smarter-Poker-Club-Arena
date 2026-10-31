import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('qualifies immutable preparation and pre-install admission without runtime writes', () => {
  const result = spawnSync('python3', ['-B', 'tests/operations/engine-activation-floor.test.py'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    encoding: 'utf8',
    timeout: 90000,
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stderr).toContain('Ran 23 tests');
}, 95000);
