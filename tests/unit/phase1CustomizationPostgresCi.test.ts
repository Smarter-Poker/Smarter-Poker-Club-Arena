import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { classifyChangedPaths } from '../../scripts/ci/classify-ci-changes.mjs';

const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));

describe('Phase 1 customization PostgreSQL qualification is protected CI input', () => {
  it.each([
    'scripts/ci/test-phase1-customization-postgres.py',
    'scripts/ci/final-table-cleanup-batches.mjs',
    'scripts/ci/final-table-cleanup-batches.test.mjs',
    'scripts/ci/fixtures/phase1-customization/bootstrap.sql',
    'scripts/ci/fixtures/phase1-customization/post-apply-invariants.sql',
    'scripts/ci/schema-manifest.d/phase-one-customization.json',
    'scripts/ci/schema-manifest.d/final-table-cleanup.json',
    'supabase/migrations/20261005230204_the_final_table_cleanup_advances_in_bounded_transactions.sql',
    'supabase/migrations/20261005230230_the_final_table_cleanup_seals_its_completed_transition.sql',
    'scripts/ci/phase1-customization-cutover-v1.json',
    'scripts/ci/seal-phase1-customization-cutover.mjs',
    'supabase/migrations/20261005111453_phase_one_customization_ownership_face_decks_and_avatar_styl.sql',
    'supabase/migrations/20261005111523_short_formats_never_reach_final_table.sql',
  ])('routes %s through accounting and source tests', (changedPath) => {
    expect(classifyChangedPaths([changedPath])).toMatchObject({ server: true, tests: true });
  });

  it('runs the native harness once on PostgreSQL 17 shard 1', () => {
    const step = ci.jobs.accounting_postgres.steps.find(
      (candidate: { name?: string }) =>
        candidate.name === 'Phase 1 customization ownership and cutover remain atomic'
    );
    expect(step).toMatchObject({
      if: 'matrix.shard == 1',
      env: {
        PG_BIN: '/usr/lib/postgresql/17/bin',
        PHASE1_PG_WORK_ROOT: '${{ runner.temp }}',
      },
      run: 'node --test scripts/ci/final-table-cleanup-batches.test.mjs\npython3 scripts/ci/test-phase1-customization-postgres.py\n',
    });
    expect(step?.['continue-on-error']).toBeUndefined();
  });
});
