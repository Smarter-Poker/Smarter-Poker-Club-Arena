import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('journal-owned native engine operation v2', () => {
  for (const file of ['native-operation-v2.test.py', 'native-wiring-v2.test.py']) {
    it(`runs ${file} through the required unit-test gate`, () => {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
      );
      const result = spawnSync('python3', ['-B', resolve('tests/operations', file)], {
        cwd: process.cwd(),
        env,
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain('OK');
    }, 65_000);
  }
});
