/** Mathematical boundary fixtures only. No cards, worker, public-history game,
 * held-out deal, real qualification registry or production operation exists. */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PLO4_STRENGTH_CONTRACT } from './Plo4StrengthContract.js';
import {
  qualificationPlanDigest,
  validateLockedFeatureAblationPlan,
  validateFeatureAblationCell,
  summarizeFeatureAblationQualification,
  featureQualificationCanonical,
  FEATURE_ABLATION_REQUIRED_RUNTIME_FILES,
} from './FeatureAblationQualification.js';
const H = 'a'.repeat(64),
  S = 'b'.repeat(40),
  hash = (x: unknown) =>
    createHash('sha256').update(featureQualificationCanonical(x)).digest('hex');
function fixture(target: 'plo6_v24' | 'v53_pressure' = 'plo6_v24', pairs = 20736): any {
  const vs = target === 'plo6_v24' ? ['plo6'] : ['nlh', 'plo4', 'plo5', 'plo6'];
  const shapes = [
    [2, 100],
    [4, 100],
    [6, 40],
    [6, 100],
    [6, 200],
  ];
  const profiles = vs.flatMap((variant) =>
    shapes.map(([seats, stackBB]) => ({
      id: `${variant}-${seats}-${stackBB}`,
      variant,
      seats,
      stackBB,
      weight: 1,
    }))
  );
  const seeds =
    target === 'plo6_v24' ? [25304119, 25305233, 25306349] : [25301109, 25302231, 25303347];
  const runtimeSourceFiles = Object.fromEntries(
      FEATURE_ABLATION_REQUIRED_RUNTIME_FILES.map((k) => [k, H])
    ),
    policyDigests = { fixture_only: H };
  const flag = target === 'plo6_v24' ? 'v24PloDefense' : 'v53Pressure';
  return {
    schema: 'horse-feature-ablation-plan-v1',
    version: 'unit-math-fixture-not-production',
    state: 'heldout_locked',
    target,
    dealSampler: 'sha256-profile-seed-index-v1',
    baselineReferenceRevision: S,
    runtimeSourceFiles,
    runtimeSourceDigest: hash(runtimeSourceFiles),
    policyDigests,
    policyDigestsDigest: hash(policyDigests),
    dependencyDigest: H,
    storeInputsDigest: H,
    admissionDigest: H,
    historyDigest: H,
    maxAttempts: 3,
    pooledPublicProfiles: { kind: 'empty_for_local_simulation', bootstrap: null, profiles: 0 },
    flags: { candidate: { [flag]: true }, reference: { [flag]: false } },
    population:
      target === 'plo6_v24' ? 'current_horse_production_styles' : 'v53_pressure_stress_v1',
    clock: {
      policyDateMs: Date.UTC(2026, 9, 26),
      publicHistoryAvailableAtMs: Date.UTC(2026, 9, 25, 23),
      warmSeed: 24307777,
    },
    profiles,
    heldoutSeeds: seeds,
    matrix: profiles.flatMap((p) =>
      seeds.map((seed) => ({
        key: p.id + '-' + seed,
        profileId: p.id,
        variant: p.variant,
        seed,
        shard: 0,
        firstPair: 0,
        pairs,
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
            evaluationCounterMinimums: target === 'v53_pressure' ? { v53_pressure_preflop: 1 } : {},
          },
        ])
      ),
    },
  };
}
function moments(
  n: number,
  negative = false
): { n: number; s1: string; s2: string; s3: string; s4: string } {
  const a = BigInt(negative ? -300 : 100),
    b = BigInt(negative ? -100 : 300),
    half = BigInt(n / 2);
  return {
    n,
    ...Object.fromEntries(
      [1, 2, 3, 4].map((i) => ['s' + i, String((a ** BigInt(i) + b ** BigInt(i)) * half)])
    ),
  } as { n: number; s1: string; s2: string; s3: string; s4: string };
}
function cells(p: any, negativeVariant = ''): any[] {
  return p.matrix.map((c: any) => {
    const profile = p.profiles.find((x: any) => x.id === c.profileId),
      negative = c.variant === negativeVariant,
      sums = moments(c.pairs, negative),
      hero = c.pairs,
      decisions = c.pairs * 4;
    return {
      schema: 'horse-feature-ablation-cell-v1',
      mode: 'contract',
      target: p.target,
      cellKey: c.key,
      sourceSha: S,
      planDigest: qualificationPlanDigest(p),
      policyDigestsDigest: p.policyDigestsDigest,
      dependencyDigest: H,
      storeInputsDigest: H,
      admissionDigest: H,
      historyDigest: H,
      operation: { fixtureOnly: true },
      rawPairsSha256: H,
      rawPairCount: c.pairs,
      execution: {
        workerReceiptSha256: H,
        workerReceiptCount: p.target === 'v53_pressure' ? hero * 2 : decisions,
        sampledWorkerReceipts: [{ fixtureOnly: true }],
      },
      result: {
        schema: 'horse-feature-ablation-shard-v1',
        mode: 'contract',
        experimentId: p.version,
        profileId: c.profileId,
        brainId: 'current-worker-original-observer-controlled-crn-v1',
        populationId: p.population,
        seed: c.seed,
        startPair: 0,
        requestedPairs: c.pairs,
        pairs: c.pairs,
        complete: true,
        candidate: p.flags.candidate,
        reference: p.flags.reference,
        sums,
        strata: Object.fromEntries(
          Array.from({ length: profile.seats }, (_, offset) => [
            offset + '|preflop',
            moments(c.pairs / profile.seats, negative),
          ])
        ),
        positionCounts: Array(profile.seats).fill(c.pairs / profile.seats),
        pairDigest: H,
        candidateNetCents: Number(sums.s1),
        referenceNetCents: 0,
        changedPairs: c.pairs,
        candidateEvaluationFires: {
          hero: { v53_pressure_preflop: hero },
          opponents: {},
        },
        referenceEvaluationFires: { hero: {}, opponents: {} },
        candidatePlanDispositions: { retired: hero },
        referencePlanDispositions: { retired: hero },
        candidateHeroDecisions: hero,
        referenceHeroDecisions: hero,
        candidateHeroActionContrastPairs: c.pairs,
        protocolErrors: 0,
        brainExceptions: 0,
        refusalReason: null,
        decisions,
        illegalActions: 0,
        conservationErrors: 0,
        cardErrors: 0,
        truncatedHands: 0,
        settlementMismatches: 0,
        deductionMismatches: 0,
        pairedReplayMismatches: 0,
        showdownsChecked: 0,
        foldWinsChecked: c.pairs * 2,
        rakeCents: 0,
        bbjCents: 0,
        durationMs: 1,
        promotionEligible: false,
      },
    };
  });
}

test('development and changed original gates cannot become locked authority', () => {
  const p = fixture();
  assert.deepEqual(validateLockedFeatureAblationPlan(p), []);
  assert.ok(
    validateLockedFeatureAblationPlan({
      ...p,
      pooledPublicProfiles: { kind: 'live_cached', profiles: 1 },
    }).includes('controlled_public_pool_input')
  );
  assert.ok(validateLockedFeatureAblationPlan({ ...p, state: 'development' }).length);
  assert.ok(
    validateLockedFeatureAblationPlan({
      ...p,
      interval: { ...p.interval, minimumPairsPerProfileInCell: 1 },
    }).includes('statistical_gate_changed')
  );
});
test('original 99-percent statistic clears only the complete trusted mathematical fixture', () => {
  const p = fixture(),
    rows = cells(p);
  assert.deepEqual(validateFeatureAblationCell(p, p.matrix[0], rows[0]), []);
  const s = summarizeFeatureAblationQualification(p, rows);
  assert.equal(s.qualified, true);
  assert.equal(s.activationAllowed, false);
  const v: any = s.byVariant.plo6;
  assert.equal(v.primary.intervalTrusted, true);
  assert.equal(v.criticalCells.length, 14);
  assert.ok(v.criticalCells.every((c: any) => c.minimumProfilePairs >= 10000));
});
test('a positive NLH fixture cannot conceal negative PLO6 in V53', () => {
  const p = fixture('v53_pressure'),
    s = summarizeFeatureAblationQualification(p, cells(p, 'plo6'));
  assert.equal(s.qualified, false);
  assert.equal((s.byVariant.nlh as any).qualified, true);
  assert.equal((s.byVariant.plo6 as any).qualified, false);
  assert.equal(s.opportunityDenominator, 'not_measured');
});
test('small mandatory position cells and missing matrix members remain unqualified', () => {
  const p = fixture('plo6_v24', 5760),
    s = summarizeFeatureAblationQualification(p, cells(p));
  assert.equal(s.qualified, false);
  assert.match(s.reasons.join(), /critical_nonregression_unproven/);
  const full = fixture();
  assert.equal(summarizeFeatureAblationQualification(full, cells(full).slice(1)).qualified, false);
});
test('development relabels, integrity failures, missing accepted-hero coverage and wrong FAST counts refuse', () => {
  const p = fixture(),
    rows = cells(p);
  rows[0].result.schema = 'horse-feature-ablation-development-v1';
  assert.equal(summarizeFeatureAblationQualification(p, rows).qualified, false);
  const legal = cells(p);
  legal[0].result.protocolErrors = 1;
  assert.equal(summarizeFeatureAblationQualification(p, legal).qualified, false);
  const inert = cells(p);
  inert.forEach((x) => (x.result.candidateHeroActionContrastPairs = 0));
  assert.equal(summarizeFeatureAblationQualification(p, inert).qualified, false);
  const bad = cells(p);
  bad[0].execution.workerReceiptCount = 1;
  assert.equal(summarizeFeatureAblationQualification(p, bad).qualified, false);
});

test('heads-up big-blind losses cannot be pooled with multiway small-blind gains', () => {
  const p = fixture(),
    rows = cells(p);
  for (const row of rows) {
    const profile = p.profiles.find((x: any) => x.id === row.result.profileId);
    const strata = Object.fromEntries(
      Array.from({ length: profile.seats }, (_, offset) => {
        const bigBlind = profile.seats === 2 ? offset === 1 : offset === 2;
        const m = moments(row.result.pairs / profile.seats, bigBlind);
        if (!bigBlind)
          for (const power of [1, 2, 3, 4] as const)
            m[`s${power}`] = String(BigInt(m[`s${power}`]) * 10n ** BigInt(power));
        return [`${offset}|preflop`, m];
      })
    );
    row.result.strata = strata;
    row.result.sums = Object.fromEntries(
      ['n', 's1', 's2', 's3', 's4'].map((k) => [
        k,
        k === 'n'
          ? row.result.pairs
          : String(Object.values(strata).reduce((a: any, m: any) => a + BigInt(m[k]), 0n)),
      ])
    );
    row.result.candidateNetCents = Number(row.result.sums.s1);
  }
  // The old raw offset-1 average is favorable because four multiway SBs hide HU BB.
  assert.ok(
    rows.reduce(
      (a, row) => a + Number(row.result.strata['1|preflop'].s1) / row.result.strata['1|preflop'].n,
      0
    ) > 0
  );
  const s = summarizeFeatureAblationQualification(p, rows),
    v: any = s.byVariant.plo6;
  assert.equal(s.qualified, false);
  const bb = v.criticalCells.find((c: any) => c.cell === 'plo6:relative_position:big_blind');
  const sb = v.criticalCells.find((c: any) => c.cell === 'plo6:relative_position:small_blind');
  assert.ok(bb.confidence99BbPer100[0] < -10);
  assert.ok(sb.confidence99BbPer100[0] > 0);
});

test('positive seed points need no extra seed diagnostic interval gate', () => {
  const p = fixture('plo6_v24', 34560);
  for (const cell of p.matrix) if (cell.seed === p.heldoutSeeds[0]) cell.pairs = 5760;
  const summary = summarizeFeatureAblationQualification(p, cells(p));
  const v: any = summary.byVariant.plo6;
  assert.equal(v.seeds[0].intervalTrusted, false);
  assert.ok(v.seeds.every((x: any) => Number.isFinite(x.meanBbPer100) && x.meanBbPer100 > 0));
  assert.equal(v.primary.intervalTrusted, true);
  assert.ok(v.criticalCells.every((x: any) => x.intervalTrusted));
  assert.equal(summary.qualified, true);
});

// Native decision dependencies are exact maintained entries, never an open path prefix.
test('source closure admits the registered public215 kernel and refuses arbitrary native sources', () => {
  const p = fixture();
  for (const path of ['native/public_hist215_wtl.cc', 'scripts/build-public-hist215-native.mjs'])
    p.runtimeSourceFiles[path] = H;
  p.runtimeSourceDigest = hash(p.runtimeSourceFiles);
  assert.deepEqual(validateLockedFeatureAblationPlan(p), []);
  p.runtimeSourceFiles['native/unregistered.cc'] = H;
  p.runtimeSourceDigest = hash(p.runtimeSourceFiles);
  assert.ok(validateLockedFeatureAblationPlan(p).includes('runtime_source_closure'));
});
