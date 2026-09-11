import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('imports and constructs the pure runtime in native Node with production imports and external writes refused', () => {
  const probe = fileURLToPath(new URL('./testing/pureImportProbe.mjs', import.meta.url));
  const child = spawnSync(process.execPath, ['--import', 'tsx', probe], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH, EQUITY_GOVERNOR: 'off', NODE_NO_WARNINGS: '1' },
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(child.status, child.stderr || child.error?.message).toBe(0);
  expect(JSON.parse(child.stdout)).toMatchObject({
    externalEffects: 0,
    serviceRolePresent: false,
    vitestPresent: false,
  });
});
