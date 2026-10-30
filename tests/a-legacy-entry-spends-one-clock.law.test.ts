import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('a legacy checkpoint spends one absolute entry clock', () => {
  it('executes the maintained queue, physical predicate and native deadline cases', () => {
    const result = spawnSync(
      'python3',
      [join(process.cwd(), 'tests/operations/legacy-entry-clock.py')],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 15_000,
      }
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('Ran 11 tests');
  }, 20_000);
});
