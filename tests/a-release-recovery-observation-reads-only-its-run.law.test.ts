import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('existing release recovery evidence stays a fixed read', () => {
  it('executes the native exact-run, filesystem, export and transport refusal fixtures', () => {
    const root = resolve(__dirname, '..');
    const result = spawnSync('python3', ['-B', 'tests/operations/release-recovery-read.test.py'], {
      cwd: root,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      encoding: 'utf8',
      timeout: 15000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/Ran 57 tests/);
  });
});
