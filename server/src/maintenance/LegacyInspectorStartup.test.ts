import { spawnSync } from 'node:child_process';
import { delimiter, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('keeps legacy recovery children neutral under the engine check runtime', () => {
  const fixture = fileURLToPath(
    new URL('../../../tests/operations/legacy-inspector-startup.py', import.meta.url)
  );
  const result = spawnSync('python3', ['-B', fixture], {
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, PATH: dirname(process.execPath) + delimiter + process.env.PATH },
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stderr).toContain('Ran 9 tests');
}, 20_000);
