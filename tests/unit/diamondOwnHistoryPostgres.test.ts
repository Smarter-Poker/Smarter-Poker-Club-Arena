import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('admits automatic Diamond members through the actual own-hand RPC without opening another player or chip club', () => {
  const output = execFileSync('python3', ['scripts/ci/test-diamond-own-history-postgres.py'], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    timeout: 90_000,
  });
  expect(output).toContain('native Diamond own-history checks passed');
}, 95_000);
