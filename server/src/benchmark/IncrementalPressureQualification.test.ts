/** Structural fixtures only; never warm histories, consume seeds or execute deals. */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  qualificationPlan,
  validateLockedFeatureAblationPlan,
  FEATURE_ABLATION_REQUIRED_RUNTIME_FILES,
  featureQualificationCanonical,
} from './FeatureAblationQualification.js';
import {
  incrementalComponentCoverage,
  assertIncrementalWorkerFlags,
  assertIncrementalPlanProvenance,
  incrementalQualificationRules,
  authenticateIncrementalPlan,
  TOURNAMENT_RESERVED_HOLDOUT_SEEDS,
} from './IncrementalPressureQualification.js';
import {
  INCREMENTAL_FLAGS,
  incrementalDevelopmentProfiles,
  incrementalDevelopmentSpec,
  type IncrementalTarget,
} from './IncrementalPressureDevelopment.js';
import { PLO4_STRENGTH_CONTRACT } from './Plo4StrengthContract.js';
import {
  runFeatureAblationContract,
  runFeatureAblationDevelopment,
} from './FeatureAblationLeague.js';
const targets = [...Object.keys(INCREMENTAL_FLAGS), 'pressure_package'] as IncrementalTarget[];
const hash = (x: unknown) =>
  createHash('sha256').update(featureQualificationCanonical(x)).digest('hex');
const H = 'a'.repeat(64);
function fixture(target: IncrementalTarget): any {
  const rules = incrementalQualificationRules(target);
  const variants = ['nlh', 'plo4', 'plo5', 'plo6'] as const;
  const profiles = variants.flatMap((v) =>
    incrementalDevelopmentProfiles(target, v)
      .filter((p) => rules.shapes.includes(`${p.seats}:${p.stackBB}`))
      .map((p) => ({ id: p.id, variant: v, seats: p.seats, stackBB: p.stackBB, weight: 1 }))
  );
  const runtimeSourceFiles = Object.fromEntries(
    [
      ...FEATURE_ABLATION_REQUIRED_RUNTIME_FILES,
      'src/benchmark/IncrementalPressureQualification.ts',
      'src/benchmark/IncrementalPressureDevelopment.ts',
    ].map((p) => [p, H])
  );
  return {
    schema: 'horse-incremental-ablation-plan-v2',
    version: 'structural-fixture-never-protected',
    state: 'heldout_locked',
    target,
    dealSampler: 'sha256-profile-seed-index-v1',
    baselineReferenceRevision: 'b'.repeat(40),
    runtimeSourceFiles,
    runtimeSourceDigest: hash(runtimeSourceFiles),
    policyDigests: { fixture: H },
    policyDigestsDigest: hash({ fixture: H }),
    dependencyDigest: H,
    storeInputsDigest: H,
    admissionDigest: H,
    historyDigest: H,
    maxAttempts: 1,
    pooledPublicProfiles: { kind: 'empty_for_local_simulation', bootstrap: null, profiles: 0 },
    flags: rules.flags,
    population: rules.population.id,
    clock: {
      policyDateMs: Date.UTC(2026, 9, 26),
      publicHistoryAvailableAtMs: Date.UTC(2026, 9, 25, 23),
      warmSeed: rules.warmSeed,
    },
    profiles,
    heldoutSeeds: rules.seeds,
    matrix: profiles.flatMap((p) =>
      rules.seeds.map((seed) => ({
        key: `${p.id}-${seed}`,
        profileId: p.id,
        variant: p.variant,
        seed,
        shard: 0,
        firstPair: 0,
        pairs: 576,
      }))
    ),
    interval: PLO4_STRENGTH_CONTRACT.interval,
    thresholds: {
      primaryLowerBoundAboveBb100: 0,
      eachSeedPointEstimateAboveBb100: 0,
      everyCriticalCellLowerBoundAtLeastBb100: -10,
    },
    criticalCells: ['profile', 'relative_position', 'depth'],
    coverage: {
      opportunityDenominator: 'not_measured',
      byProfile: Object.fromEntries(
        profiles.map((p) => [
          p.id,
          {
            candidateHeroDecisionsMinimum: 1,
            referenceHeroDecisionsMinimum: 1,
            acceptedHeroContrastsMinimum: 1,
            evaluationCounterMinimums: Object.fromEntries(
              incrementalComponentCoverage(target, p.seats)
                .filter((c) => c.applicable)
                .map((c) => [c.counter, 1])
            ),
          },
        ])
      ),
    },
  };
}
test('separate schema accepts six structural designs but neither empty registry nor JSON grants execution', async () => {
  for (const target of targets) {
    assert.deepEqual(validateLockedFeatureAblationPlan(fixture(target)), []);
    assert.throws(() => qualificationPlan(target), /plan refused/);
    await assert.rejects(authenticateIncrementalPlan(fixture(target)), /provider unavailable/);
    let called = 0;
    const profile = incrementalDevelopmentProfiles(target, 'plo4')[0];
    const spec = incrementalDevelopmentSpec(target, 'plo4', profile.id, {
      id: 'current-worker-original-observer-controlled-crn-v1',
      decide: () => {
        called++;
        throw Error('must not deal');
      },
    });
    await assert.rejects(
      runFeatureAblationContract(
        spec,
        { seed: 28301109, pairs: 576, startPair: 0, planDigest: H, cellKey: 'unregistered' },
        () => {
          called++;
        }
      ),
      /plan refused/
    );
    assert.equal(called, 0);
  }
  assert.deepEqual(
    JSON.parse(
      readFileSync(new URL('./IncrementalPressureQualificationPlans.json', import.meta.url), 'utf8')
    ),
    {}
  );
});
test('flags, warm seed, physical domain, reserved family and source cannot be substituted', () => {
  for (const mutate of [
    (p: any) => {
      p.flags = { candidate: { v53Pressure: true }, reference: { v53Pressure: false } };
    },
    (p: any) => {
      p.clock.warmSeed = 1;
    },
    (p: any) => {
      p.heldoutSeeds = [1];
    },
    (p: any) => {
      p.population = 'foreign';
    },
    (p: any) => {
      p.profiles[0].id = 'foreign';
    },
    (p: any) => {
      delete p.runtimeSourceFiles['src/benchmark/IncrementalPressureDevelopment.ts'];
      p.runtimeSourceDigest = hash(p.runtimeSourceFiles);
    },
    (p: any) => {
      p.schema = 'horse-feature-ablation-plan-v1';
    },
    (p: any) => {
      p.thresholds.primaryLowerBoundAboveBb100 = -1;
    },
  ]) {
    const p = fixture('pressure_package');
    mutate(p);
    assert.ok(validateLockedFeatureAblationPlan(p).length);
  }
  const p = fixture('river_bluff_checkraise');
  p.profiles[0].seats = 4;
  assert.ok(validateLockedFeatureAblationPlan(p).length);
});
test('generic development refuses tournament reserved seeds without invoking brain', async () => {
  let called = 0;
  const target = 'combo_draw_pressure';
  const profile = incrementalDevelopmentProfiles(target, 'plo4')[0];
  const spec = incrementalDevelopmentSpec(target, 'plo4', profile.id, {
    id: 'no-deal',
    decide: () => {
      called++;
      throw Error('no');
    },
  });
  for (const seed of TOURNAMENT_RESERVED_HOLDOUT_SEEDS)
    await assert.rejects(runFeatureAblationDevelopment(spec, { seed, pairs: 1 }), /never deals/);
  assert.equal(called, 0);
});

test('predeclaration requires original provider, protected merge and strict pre-run time', () => {
  const commit = 'b'.repeat(40),
    operation = {
      id: 42,
      path: '.github/workflows/horse-feature-ablation-qualification.yml',
      event: 'workflow_dispatch',
      head_branch: 'main',
      head_sha: 'c'.repeat(40),
      created_at: '2026-10-27T18:00:00Z',
    };
  const prs = [
    {
      merge_commit_sha: commit,
      merged_at: '2026-10-27T17:00:00Z',
      base: { ref: 'main', repo: { full_name: 'Smarter-Poker/Smarter-Poker-Club-Arena' } },
    },
  ];
  assert.equal(assertIncrementalPlanProvenance(operation, prs, commit, '42'), operation);
  for (const changed of [
    { ...operation, id: 43 },
    { ...operation, created_at: '2026-10-27T17:00:00Z' },
    { ...operation, event: 'pull_request' },
    { ...operation, head_sha: null },
  ])
    assert.throws(() => assertIncrementalPlanProvenance(changed, prs, commit, '42'));
  assert.throws(() => assertIncrementalPlanProvenance(operation, [], commit, '42'));
  assert.throws(() =>
    assertIncrementalPlanProvenance(
      operation,
      [{ ...prs[0], base: { ref: 'main', repo: { full_name: 'foreign' } } }],
      commit,
      '42'
    )
  );
});

test('actual worker flags require exactly the declared arm, including all five package flags', () => {
  for (const target of targets) {
    const rules = incrementalQualificationRules(target);
    assertIncrementalWorkerFlags(target, rules.flags.candidate);
    assertIncrementalWorkerFlags(target, rules.flags.reference);
    assert.throws(() => assertIncrementalWorkerFlags(target, {}));
    assert.throws(() =>
      assertIncrementalWorkerFlags(target, { ...rules.flags.candidate, v53Pressure: true })
    );
  }
  assert.throws(() =>
    assertIncrementalWorkerFlags('pressure_package', {
      ...incrementalQualificationRules('pressure_package').flags.candidate,
      riverBluffCheckRaise: false,
    })
  );
});

test('each applicable component needs its own registered positive counter, never a pooled rescue', () => {
  const p = fixture('pressure_package');
  for (const profile of p.profiles) {
    const c = p.coverage.byProfile[profile.id].evaluationCounterMinimums;
    assert.equal(Object.hasOwn(c, 'river_bluff_checkraise_selected'), profile.seats === 2);
  }
  const profile = p.profiles[0];
  p.coverage.byProfile[profile.id].evaluationCounterMinimums = {};
  assert.ok(
    validateLockedFeatureAblationPlan(p).some((x) =>
      x.startsWith('incremental_component_coverage:')
    )
  );
  p.coverage.byProfile[profile.id].evaluationCounterMinimums = { foreign: 1 };
  assert.ok(
    validateLockedFeatureAblationPlan(p).some((x) =>
      x.startsWith('incremental_component_coverage:')
    )
  );
});
