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
    // The standing rake share (20261025030629) replaces the October 24 cron,
    // proven against the recorded out-of-band state in the same database.
    expect(native).toContain('20261024223153_woowoo_half_earned_rake_credited_to_kingfish.sql');
    expect(native).toContain('*_a_standing_rake_share_replaces_the_woowoo_cron.sql');
    expect(native).toContain('rake-share-out-of-band.sql');
    expect(native).toContain('rake-share-lag.sql');
    expect(native).toContain('rake-share-assert.sql');
    expect(native).toContain('rake share regression unexpectedly passed before the migration');
  });
});
