import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('explicit active release observation', () => {
  it('qualifies native exact-owner files, bounded reads and sanitized exports', () => {
    const result = spawnSync('python3', ['-B', 'tests/operations/active-release-read.test.py'], {
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      encoding: 'utf8',
      timeout: 15000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('Ran 16 tests');
  });
});
