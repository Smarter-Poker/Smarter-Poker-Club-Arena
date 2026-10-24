import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('the fee redemption runs with the maintained Data Console qualification', () => {
  it('retains the native before/after regression in the required accounting path', () => {
    const runner = readFileSync('scripts/ci/test-data-console-postgres-contracts.sh', 'utf8');
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    const native = readFileSync('scripts/ci/test-player-fee-redemption.sh', 'utf8');
    expect(ci).toContain('run: npm run test:data:postgres');
    expect(runner).toContain('bash "$repo/scripts/ci/test-player-fee-redemption.sh"');
    expect(runner).toContain('FEE_REDEMPTION_SCRATCH="$DATA_CONSOLE_PG_SCRATCH_PARENT"');
    expect(native).toContain('fee-redemption-source-functions.sql');
    expect(native).toContain('fee-redemption-assert.sql');
    expect(native).toContain('regression unexpectedly passed before the migration');
  });
});
