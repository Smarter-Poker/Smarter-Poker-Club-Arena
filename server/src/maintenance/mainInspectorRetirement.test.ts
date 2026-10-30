import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

it('qualifies MAIN Inspector transport, kernel ownership and durable operation claim in isolation', () => {
  const root = resolve('..');
  const native = spawnSync(
    process.execPath,
    [
      '--test',
      'tests/operations/retire-owned-main-inspector.test.mjs',
      'tests/operations/main-inspector-socket-qualification.test.mjs',
    ],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 20000,
      maxBuffer: 131072,
    }
  );
  expect(native.error?.message ?? null, native.stderr).toBeNull();
  expect(native.status, native.stdout + native.stderr).toBe(0);
  if (process.platform === 'linux') expect(native.stdout).toMatch(/# skipped 0\b/);
  const host = spawnSync(
    'python3',
    ['-B', 'tests/operations/main-inspector-retirement-host.test.py'],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 131072,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    }
  );
  expect(host.error?.message ?? null, host.stderr).toBeNull();
  expect(host.status, host.stdout + host.stderr).toBe(0);
}, 40000);
