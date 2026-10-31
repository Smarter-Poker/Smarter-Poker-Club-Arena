import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { classifyChangedPaths } from '../../scripts/ci/classify-ci-changes.mjs';

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('durable original continuation qualification remains connected', () => {
  it.each([
    'scripts/ci/test-hand-continuation.py',
    'scripts/ci/fixtures/hand-continuation/retain_shared_lane_qualification.py',
    'scripts/ci/fixtures/hand-continuation/build-retain-shared-lane.py',
    'supabase/migrations/20261029231647_retained_original_hands_share_their_tournament_table_lane.sql',
    'scripts/ci/played_clock_floor_cases.py',
    'scripts/ci/build-played-level-recovery-migration.py',
    'scripts/ci/fixtures/played-clock-floor/opening.sql',
    'scripts/ci/fixtures/played-clock-floor/abort-preimage.json',
    'scripts/ci/probes/hand-continuation-native.sql',
    'scripts/ci/fixtures/hand-continuation/financial-preimages.json',
    'scripts/ci/fixtures/hand-continuation/disposition.spec',
    'scripts/ci/fixtures/hand-continuation/frozen_attestation_qualification.py',
    'supabase/migrations/20261029093051_attest_frozen_original_hand_continuation_custody.sql',
    'scripts/ci/schema-manifest.d/hand-continuation.json',
    'supabase/migrations/20261028233353_durable_private_hand_continuation.sql',
  ])('executes required accounting for changes to %s', (path) => {
    expect(classifyChangedPaths([path])).toMatchObject({ server: true, tests: true });
  });

  it('runs the local real PostgreSQL owner in required accounting shard three', () => {
    const workflow = parse(read('.github/workflows/ci.yml'));
    const steps = workflow.jobs.accounting_postgres.steps.filter((step: { run?: string }) =>
      step.run?.includes('scripts/ci/test-hand-continuation.py')
    );
    expect(steps).toHaveLength(1);
    expect(steps[0].if).toBe('matrix.shard == 3');
    expect(steps[0]['continue-on-error']).toBeUndefined();
    expect(steps[0].run).toContain('--socket-root "$RUNNER_TEMP"');
    expect(steps[0].env.PG_ISOLATION_TESTER).toContain('isolationtester');
  });

  it('runs and source-binds the played-level floor in the same required native lane', () => {
    const runner = read('scripts/ci/test-hand-continuation.py');
    expect(runner).toContain(
      "module(ROOT/'scripts/ci/played_clock_floor_cases.py','played_clock_floor').qualify(e,ROOT,hand)"
    );
    expect(runner).toContain("ROOT/'scripts/ci/fixtures/played-clock-floor'");
    expect(runner).toContain("Path('scripts/ci/build-played-level-recovery-migration.py')");
    expect(runner).toContain(
      "Path('supabase/migrations/20261029004521_keep_generation_recovery_at_the_highest_genuinely_played_lev.sql')"
    );
  });

  it('keeps the captured current financial owner bodies exact', () => {
    const captures = JSON.parse(
      read('scripts/ci/fixtures/hand-continuation/financial-preimages.json')
    );
    expect(captures).toHaveLength(4);
    for (const row of captures) {
      const body = /AS (\$[A-Za-z_0-9]*\$)([\s\S]*?)\1/.exec(row.definition)?.[2];
      expect(body).toBeDefined();
      expect(createHash('md5').update(body!).digest('hex')).toBe(row.body_md5);
      expect(row.owner).toBe('postgres');
      expect(row.proacl).toBe(
        row.signature.startsWith('fn_ca_settle_hand_stacks_absolute(')
          ? '{postgres=X/postgres}'
          : '{postgres=X/postgres,service_role=X/postgres}'
      );
    }
  });

  it('executes and source-binds the frozen read-only custody door in the same native owner', () => {
    const runner = read('scripts/ci/test-hand-continuation.py');
    expect(runner).toContain(
      "module(ROOT/DATA/'frozen_attestation_qualification.py','frozen_original_attestation').qualify(e,ROOT,hand,db)"
    );
    expect(runner).toContain(
      "Path('supabase/migrations/20261029093051_attest_frozen_original_hand_continuation_custody.sql')"
    );
  });
  it('qualifies exact authorized chairs through the existing real funding owner', () => {
    const runner = read('scripts/ci/test-hand-continuation.py');
    const funding = read(
      'scripts/ci/fixtures/hand-continuation/chip_funded_addon_qualification.py'
    );
    const chairs = read('scripts/ci/fixtures/hand-continuation/chair_admission_qualification.py');
    expect(runner).toContain(
      "Path('supabase/migrations/20261029170914_original_claim_attests_exact_authorized_chairs.sql')"
    );
    expect(funding).toContain(
      "module(root/'scripts/ci/fixtures/hand-continuation/chair_admission_qualification.py','chair_admission').qualify("
    );
    expect(chairs).toContain('chair-old-response-regression');
    expect(chairs).toContain('chair-reverse-exact-owner');
    expect(chairs).toContain('chair-identity');
    expect(chairs).toContain('stale-generation');
    expect(chairs).toContain('duplicate-roster');
    expect(chairs).toContain('terminal+final');
  });
  it('runs the original save shared-lane regression through the existing PostgreSQL owner', () => {
    const runner = read('scripts/ci/test-hand-continuation.py');
    expect(runner).toContain(
      "module(ROOT/DATA/'retain_shared_lane_qualification.py','retain_shared_lane').qualify(e,ROOT,hand,db)"
    );
    const native = read(
      'scripts/ci/fixtures/hand-continuation/retain_shared_lane_qualification.py'
    );
    for (const evidence of [
      'retain-old-sibling-projection-blocks',
      'retain-new-sibling-projection-progress',
      'retain-blocks-terminal',
      'retain-full-original-financial-boundaries',
      'same-table',
      'lease',
    ]) {
      expect(native).toContain(evidence);
    }
    expect(runner).toContain(
      "Path('supabase/migrations/20261029231647_retained_original_hands_share_their_tournament_table_lane.sql')"
    );
  });
});
