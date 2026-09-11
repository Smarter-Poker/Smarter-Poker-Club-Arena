import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('reconciles legacy sealed failures through the native parser, seal, lock and durable cleanup', () => {
  const result = spawnSync(
    'python3',
    [join(process.cwd(), 'tests/engine-legacy-sealed-reconciliation.test.py')],
    { encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024 }
  );
  expect(result.error, `${result.stdout}\n${result.stderr}`).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}, 25_000);
