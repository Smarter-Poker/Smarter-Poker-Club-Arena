// Native qualification inputs: read-scoped-billing-endpoints.py, production-integrity-audit.yml.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('explicit billing endpoint observation', () => {
  it('runs the real parser and native admission, sanitization and identity refusals', () => {
    const result = spawnSync('python3', ['-B', 'tests/operations/billing-endpoint-read.test.py'], {
      cwd: resolve(__dirname, '..'),
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      encoding: 'utf8',
      timeout: 15000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/Ran 10 tests/);
  });
});
