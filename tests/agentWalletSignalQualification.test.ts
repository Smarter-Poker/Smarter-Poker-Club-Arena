import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyChangedPaths } from '../scripts/ci/classify-ci-changes.mjs';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('Player Command native wallet signal qualification', () => {
  it.each([
    'scripts/ci/test-agent-wallet-postgres.py',
    'scripts/ci/fixtures/agent-wallet/setup.sql',
    'scripts/ci/fixtures/agent-wallet/cases.sql',
    'tests/agentWalletSignalQualification.test.ts',
  ])('executes PostgreSQL qualification when %s changes', (path) => {
    expect(classifyChangedPaths([path])).toMatchObject({ server: true, tests: true });
  });

  it('keeps the actual migration qualification in the required accounting job', () => {
    const accounting = read('.github/workflows/ci.yml')
      .split('\n  accounting_postgres:')[1]
      .split('\n  server:')[0];
    expect(accounting).toContain('run: python3 scripts/ci/test-agent-wallet-postgres.py');
    expect(read('scripts/ci/test-agent-wallet-postgres.py')).toContain(
      'query(MIGRATION.read_text())'
    );
  });
});
