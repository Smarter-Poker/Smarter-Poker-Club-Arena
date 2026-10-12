import { describe, expect, it } from 'vitest';
import {
  OMAHA_VARIANT_MATRIX_JOB_CEILING,
  OMAHA_VARIANT_STRENGTH_CONTRACT,
  OMAHA_VARIANT_STRENGTH_VARIANTS,
  isOmahaVariantHoldoutSeed,
  isOmahaVariantHoldoutSeedOf,
  omahaVariantCellStatistic,
  omahaVariantMoodClockMs,
  omahaVariantStrengthContractDigest,
  omahaVariantStrengthPack,
  omahaVariantStrengthRequiredShards,
  omahaVariantStrengthShardReasons,
  summarizeOmahaVariantStrength,
  type OmahaVariantStrengthShardResult,
} from './OmahaVariantStrengthContract.js';
import {
  PLO4_STRENGTH_CONTRACT,
  Plo4PowerAccumulator,
  isPlo4HoldoutSeed,
  plo4StrengthContractDigest,
} from './Plo4StrengthContract.js';
import { PLO4_LEAGUE_SEEDS } from './Plo4PolicyLeague.js';
import { OMAHA_VARIANT_LEAGUE_SEEDS } from './OmahaVariantPolicyLeague.js';
import { REMAINING_VARIANT_LEAGUE_SEEDS } from './RemainingVariantPolicyLeague.js';
import { JOINT_LEAGUE_SEEDS } from './JointPolicyLeague.js';
import { TOURNAMENT_PROMOTION_SEEDS } from './HorseTournamentLeague.js';
import {
  OMAHA_VARIANT_PACKS,
  type OmahaPolicyVariant,
} from '../engine/omaha/OmahaVariantPolicyPack.js';
import { getFullRakeConfig, getPlayerCountCaps } from '../config/RakeConfig.js';
import { CASH_MAX_BB, CASH_MIN_BB } from '../config/cashBuyIn.js';
import { maxSeatsForVariant } from '../config/tableSeating.js';

const C = OMAHA_VARIANT_STRENGTH_CONTRACT;
const VARIANTS: OmahaPolicyVariant[] = ['plo5', 'plo6', 'plo8'];

/** Exact power sums of a value multiset, built arithmetically (no per-pair loop). */
function sums(parts: [count: number, value: number][]) {
  let n = 0,
    s1 = 0n,
    s2 = 0n,
    s3 = 0n,
    s4 = 0n;
  for (const [count, value] of parts) {
    const c = BigInt(count),
      v = BigInt(value);
    n += count;
    s1 += c * v;
    s2 += c * v * v;
    s3 += c * v * v * v;
    s4 += c * v * v * v * v;
  }
  return { n, s1: String(s1), s2: String(s2), s3: String(s3), s4: String(s4) };
}

interface Mix {
  /** Per offset: a quarter of pairs at win + shift and a quarter at -loss + shift on
   * `street`, half identical (none). */
  win: number;
  loss: number;
  street?: string;
  offsetShift?: (offset: number) => number;
  /** Extra stratum per offset: a quarter of pairs moved to this street with this value. */
  extra?: { street: string; value: number };
}
/** A contract-mode shard of `variant` whose every offset has the same value mix. */
function shard(
  variant: OmahaPolicyVariant,
  profileId: string,
  seed: number,
  index: number,
  mix: Mix = { win: 1200, loss: 1000 }
): OmahaVariantStrengthShardResult {
  const pack = omahaVariantStrengthPack(variant);
  const p = pack.matrix.profiles.find((x) => x.id === profileId)!;
  const perOffset = pack.matrix.pairsPerShard / p.seats;
  const strata: OmahaVariantStrengthShardResult['strata'] = {};
  for (let o = 0; o < p.seats; o++) {
    const shift = mix.offsetShift?.(o) ?? 0;
    const quarter = perOffset / 4;
    if (mix.extra) {
      strata[`${o}|none`] = sums([[perOffset / 4, 0]]);
      strata[`${o}|${mix.street ?? 'flop'}`] = sums([[quarter * 2, -mix.loss + shift]]);
      strata[`${o}|${mix.extra.street}`] = sums([[quarter, mix.extra.value]]);
    } else {
      strata[`${o}|none`] = sums([[perOffset / 2, 0]]);
      strata[`${o}|${mix.street ?? 'flop'}`] = sums([
        [quarter, mix.win + shift],
        [quarter, -mix.loss + shift],
      ]);
    }
  }
  return {
    schema: 'horse-phase11-strength-shard-v1',
    variant,
    contractVersion: C.version,
    contractDigest: omahaVariantStrengthContractDigest(),
    packVersion: pack.candidate.packVersion,
    evidenceMode: 'contract',
    profileId,
    seed,
    shard: index,
    firstPair: index * pack.matrix.pairsPerShard,
    requestedPairs: pack.matrix.pairsPerShard,
    pairs: pack.matrix.pairsPerShard,
    complete: true,
    positionCoverageComplete: true,
    offsetCounts: Array(p.seats).fill(perOffset),
    strata,
    pairDigest: 'd'.repeat(64),
    candidateNetCents: 0,
    referenceNetCents: 0,
    changedPairs: pack.matrix.pairsPerShard / 2,
    decisions: 1,
    eligible: 1,
    changed: 1,
    illegalActions: 0,
    conservationErrors: 0,
    cardErrors: 0,
    truncatedHands: 0,
    settlementMismatches: 0,
    deductionMismatches: 0,
    pairedReplayMismatches: 0,
    showdownsChecked: 1,
    foldWinsChecked: 1,
    lowHalvesChecked: 0,
    totalRake: 0,
    totalBbj: 0,
    nodeCounts: {},
    reasons: {},
    equityWork: {},
    fixedWork: {
      governor: 'off',
      scale: 1,
      policyClock: 'fixed_work_no_wall_clock_branch',
      moodClock: 'deal_seed_time_of_day',
    },
    durationMs: 1,
    promotionEligible: false,
  };
}
const fullMatrix = (
  variant: OmahaPolicyVariant,
  make: (profileId: string, seed: number, index: number) => OmahaVariantStrengthShardResult = (
    profileId,
    seed,
    index
  ) => shard(variant, profileId, seed, index)
) => omahaVariantStrengthRequiredShards(variant).map((s) => make(s.profileId, s.seed, s.shard));

describe('P11.2 Phase 11 strength contract object', () => {
  it('is versioned, deeply immutable, and bound by a stable digest', () => {
    expect(C.schema).toBe('horse-phase11-strength-contract');
    expect(C.version).toBe('omaha-variant-strength-contract-v1');
    expect(C.phase).toBe('P11.2');
    expect(omahaVariantStrengthContractDigest()).toMatch(/^[0-9a-f]{64}$/);
    expect(omahaVariantStrengthContractDigest()).toBe(omahaVariantStrengthContractDigest());
    expect(Object.isFrozen(C)).toBe(true);
    expect(Object.isFrozen(C.packs.plo8.matrix.profiles[4])).toBe(true);
    expect(Object.isFrozen(C.liveConditions.differences[0])).toBe(true);
    expect(() => {
      (
        C.thresholds.nonregression as { lowerBoundAtLeastBbPer100: number }
      ).lowerBoundAtLeastBbPer100 = -100;
    }).toThrow();
    expect(C.promotionEligible).toBe(false);
  });

  it('pins the contract digest, so a silent contract edit fails CI (Phase 10 audit F9)', () => {
    // A deliberate contract change must update this pin and say why. Anything
    // the contract reads (pack versions, the published rake rows, the buy-in
    // band, the seat law) moves it too, which fails closed: evidence made
    // under the old digest is then refused by name. Round 3 (2026-10-08)
    // moved it only through the three pack versions (round3-v2); every term
    // of the locked matrices is unchanged (was 0e58a56a...0326).
    expect(omahaVariantStrengthContractDigest()).toBe(
      '5b93ae20962ff79798b998f437ed43d2bd224a64995d86e34ed63d7bb22057fc'
    );
  });

  it('leaves the Phase 10 contract and its pinned digest untouched', () => {
    expect(plo4StrengthContractDigest()).toBe(
      '83ab185b2a2df72876b73d61ece6ea8c2f03f364ce252deecbfcde392ae5f838'
    );
  });

  it.each(VARIANTS)('%s: one pack, its own candidate, population and profiles', (variant) => {
    const pack = omahaVariantStrengthPack(variant);
    const published = getFullRakeConfig(1, 2, variant);
    expect(pack.variant).toBe(variant);
    expect(pack.candidate.packVersion).toBe(OMAHA_VARIANT_PACKS[variant].version);
    expect(pack.candidate.calibratedConfidence).toBeNull();
    expect(pack.candidate.owner).toContain('phase11Omaha "candidate"');
    expect(pack.reference.owner).toContain('phase11Omaha "off"');
    expect(pack.candidate.splitPot).toBe(variant === 'plo8');
    expect(pack.population.rake.percent).toBe(published.rakePercent);
    expect(pack.population.rake.cap).toBe(published.rakeCap);
    expect(pack.population.rake.playerCountCaps[6]).toEqual(
      getPlayerCountCaps(published.rakeCap, 6)
    );
    expect(pack.population.bbj.enabled).toBe(published.bbjEnabled);
    expect(pack.population.bbj.feeBB).toBe(published.bbjFeeBB);
    // PLO6 is not covered by the jackpot: its row drops nothing.
    expect(pack.population.bbj.enabled).toBe(variant !== 'plo6');
    expect(pack.population.cashSeatCeiling).toBe(maxSeatsForVariant(variant));
    expect(pack.population.tableSeats).toBe(6);
    expect(pack.population.tableSeatsReason).toContain('six-handed and locked');
    expect(pack.population.buyInBandBB).toEqual([CASH_MIN_BB, CASH_MAX_BB]);
    expect(pack.matrix.profiles.map((p) => p.id)).toEqual([
      `p11c-${variant}-6max-2dealt-100bb`,
      `p11c-${variant}-6max-4dealt-100bb`,
      `p11c-${variant}-6max-40bb`,
      `p11c-${variant}-6max-100bb`,
      `p11c-${variant}-6max-200bb`,
    ]);
    expect(pack.matrix.profiles.map((p) => [p.seats, p.stackBB, p.depthBand])).toEqual([
      [2, 100, 'standard'],
      [4, 100, 'standard'],
      [6, CASH_MIN_BB, 'short'],
      [6, 100, 'standard'],
      [6, CASH_MAX_BB, 'deep'],
    ]);
    for (const p of pack.matrix.profiles) {
      expect(p.variant).toBe(variant);
      expect(p.tableSeats).toBe(6);
      expect(p.seats).toBeLessThanOrEqual(pack.population.cashSeatCeiling);
      expect(p.pilotSdBB).toBeGreaterThan(0);
      expect(p.pilotMsPerPair).toBeGreaterThan(0);
    }
  });

  it('holds out three new seeds per pack, disjoint from every seed in the repository', () => {
    const others = [
      ...PLO4_LEAGUE_SEEDS,
      ...PLO4_STRENGTH_CONTRACT.holdout.seeds,
      ...OMAHA_VARIANT_LEAGUE_SEEDS,
      ...REMAINING_VARIANT_LEAGUE_SEEDS,
      ...JOINT_LEAGUE_SEEDS,
      ...TOURNAMENT_PROMOTION_SEEDS,
    ];
    const all = VARIANTS.flatMap((v) => [...omahaVariantStrengthPack(v).holdout.seeds]);
    expect(new Set(all).size).toBe(9);
    for (const variant of VARIANTS) {
      const pack = omahaVariantStrengthPack(variant);
      expect([...pack.holdout.developmentSeeds]).toEqual([...OMAHA_VARIANT_LEAGUE_SEEDS]);
      expect([...pack.matrix.seeds]).toEqual([...pack.holdout.seeds]);
      for (const seed of pack.holdout.seeds) {
        expect(others).not.toContain(seed);
        expect(isOmahaVariantHoldoutSeed(seed)).toBe(true);
        expect(isOmahaVariantHoldoutSeedOf(variant, seed)).toBe(true);
        for (const other of VARIANTS.filter((v) => v !== variant))
          expect(isOmahaVariantHoldoutSeedOf(other, seed)).toBe(false);
        expect(isPlo4HoldoutSeed(seed)).toBe(false);
      }
    }
    for (const seed of others) expect(isOmahaVariantHoldoutSeed(seed)).toBe(false);
    // No held-out deal seed repeats a deal seed any development league or the
    // Phase 10 matrix can deal (first 32 pairs of a development seed, the
    // development league maximum; first 4,096 of every held-out seed).
    const deal = (seed: number, i: number) => (seed ^ Math.imul(i + 1, 2654435761)) >>> 0 || 1;
    const dev = new Set(others.flatMap((s) => Array.from({ length: 32 }, (_, i) => deal(s, i))));
    for (const seed of all)
      for (let i = 0; i < 4096; i++) expect(dev.has(deal(seed, i))).toBe(false);
  });

  it('locks every pack matrix with balanced shards and planned gating cells inside the margin', () => {
    for (const variant of VARIANTS) {
      const pack = omahaVariantStrengthPack(variant);
      const required = omahaVariantStrengthRequiredShards(variant);
      expect(required).toHaveLength(pack.matrix.requiredShards);
      expect(new Set(required.map((r) => r.key)).size).toBe(required.length);
      expect(pack.matrix.requiredShards).toBeLessThanOrEqual(OMAHA_VARIANT_MATRIX_JOB_CEILING);
      expect(pack.matrix.pairsPerShard % 576).toBe(0);
      for (const p of pack.matrix.profiles) {
        expect(pack.matrix.pairsPerShard % (p.seats * p.seats)).toBe(0);
        expect(pack.matrix.pairsPerProfile[p.id]).toBe(p.shards * pack.matrix.pairsPerShard * 3);
      }
      const cells = Object.entries(pack.matrix.plannedGatingCells);
      expect(cells).toHaveLength(14);
      for (const [, plan] of cells) {
        expect(plan.halfWidthBbPer100).toBeLessThanOrEqual(
          C.matrixRules.plannedHalfWidthMaxBbPer100
        );
        expect(plan.minimumProfilePairs).toBeGreaterThanOrEqual(
          C.interval.minimumPairsPerProfileInCell
        );
        expect(plan.varianceRelativeSeAtPilotKurtosis).toBeLessThan(0.1);
      }
      // Within the hosted budget, except where the job ceiling forbids it (PLO6, named).
      const slowest = Math.max(...pack.matrix.profiles.map((p) => p.pilotMsPerPair));
      const minutes = (2.5 * slowest * pack.matrix.pairsPerShard) / 60000;
      if (variant === 'plo6') expect(minutes).toBeLessThan(30);
      else expect(minutes).toBeLessThanOrEqual(25);
    }
    // Shard keys never collide across packs: every profile id names its variant.
    const keys = VARIANTS.flatMap((v) => omahaVariantStrengthRequiredShards(v).map((r) => r.key));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps the Phase 10 thresholds with their reasons and gates exactly 14 cells per pack', () => {
    expect(C.thresholds.primary.lowerBoundAboveBbPer100).toBe(0);
    expect(C.thresholds.seedReplication.pointEstimateAboveBbPer100).toBe(0);
    expect(C.thresholds.nonregression.lowerBoundAtLeastBbPer100).toBe(-10);
    expect(C.interval.edgeworthCoverageErrorMax).toBe(0.001);
    expect(C.interval.minimumPairsPerProfileInCell).toBe(10_000);
    expect(C.interval.z).toBe(2.5758293035489004);
    expect(C.gatingCells.count).toBe(14);
    expect(C.gatingCells.streetFamilies.gate).toBe(false);
    expect(C.gatingCells.streetFamilies.whyNotAGate).toContain('cannot fail');
    expect(C.notStrengthGates).toEqual(
      expect.arrayContaining(['atlas coordinate count', 'changed proposal count'])
    );
  });

  it('names every harness-versus-live difference and its handling, with mood addressed', () => {
    const ids = C.liveConditions.differences.map((d) => d.id);
    expect(ids).toEqual([
      'mood',
      'style_modifiers',
      'horsemind_history',
      'policy_clock',
      'second_look',
      'field',
    ]);
    expect(C.liveConditions.differences[0].handling).toBe('addressed');
    for (const d of C.liveConditions.differences.slice(1))
      expect(d.handling).toMatch(/^(named limit|design)/);
    expect(C.liveConditions.admissionAlsoRequires[0]).toContain('natural completion-share');
    // The clock spreads over a day and depends on the deal seed only.
    const hours = new Set(
      Array.from({ length: 2000 }, (_, i) =>
        Math.floor(omahaVariantMoodClockMs((i * 2654435761) >>> 0) / 3_600_000)
      )
    );
    expect(hours.size).toBe(24);
    expect(omahaVariantMoodClockMs(86_401)).toBe(1000);
  });

  it('refuses the tournament objective by name, per pack, outside the cash reasons', () => {
    for (const variant of VARIANTS) {
      const pack = omahaVariantStrengthPack(variant);
      expect(pack.tournament.status).toBe('unavailable dependency');
      expect(pack.tournament.refusals).toEqual([
        `tournament:${variant}_whole_tournament_outcome_model_unavailable`,
        `tournament:qualified_${variant}_tournament_reference_population_unavailable`,
        `tournament:${variant}_tournament_thresholds_not_specified`,
      ]);
      const verdict = summarizeOmahaVariantStrength(variant, fullMatrix(variant));
      expect(verdict.qualified).toBe(true);
      expect(verdict.reasons).toEqual([]);
      expect(verdict.tournament).toEqual({
        status: 'unavailable dependency',
        qualified: false,
        reasons: pack.tournament.refusals,
      });
      expect(verdict.reasons.some((r) => r.startsWith('tournament:'))).toBe(false);
    }
  });
});

describe('P11.2 interval and per-pack verdict', () => {
  it('computes the stratified mean, standard error and 99% interval exactly as stated', () => {
    const a = new Plo4PowerAccumulator();
    const b = new Plo4PowerAccumulator();
    const xs = [100, -40, 0, 0, 260, -80];
    const ys = [10, 30, -20, 0];
    xs.forEach((x) => a.add(x));
    ys.forEach((y) => b.add(y));
    const group = (id: string, acc: Plo4PowerAccumulator) => {
      const j = acc.toJSON();
      return {
        profileId: id,
        weight: 0.5,
        n: j.n,
        s1: BigInt(j.s1),
        s2: BigInt(j.s2),
        s3: BigInt(j.s3),
      };
    };
    const stat = omahaVariantCellStatistic('t', [group('x', a), group('y', b)]);
    const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
    const variance = (v: number[]) =>
      v.reduce((s, x) => s + (x - mean(v)) ** 2, 0) / (v.length - 1);
    const t = 0.5 * mean(xs) + 0.5 * mean(ys);
    const se = Math.sqrt(0.25 * (variance(xs) / xs.length) + 0.25 * (variance(ys) / ys.length));
    expect(stat.meanBbPer100).toBeCloseTo(t / 2, 10);
    expect(stat.standardErrorBbPer100).toBeCloseTo(se / 2, 10);
    expect(stat.confidence99BbPer100[0]).toBeCloseTo((t - 2.5758293035489004 * se) / 2, 10);
    expect(stat.intervalTrusted).toBe(false);
  });

  it.each(VARIANTS)(
    '%s qualifies only on all 14 gating cells, and names every failure',
    (variant) => {
      const pass = summarizeOmahaVariantStrength(variant, fullMatrix(variant));
      expect(pass.qualified).toBe(true);
      expect(pass.cash.gatingCells).toBe(14);
      expect(pass.cash.positions.map((p) => p.cell)).toEqual([
        'position:button',
        'position:small_blind',
        'position:big_blind',
        'position:cutoff',
        'position:middle',
        'position:early',
      ]);
      expect(pass.domain).toBe(`${variant}-cash-single-board-after-rake-horse-population`);
      expect(pass.shardsUsed).toBe(omahaVariantStrengthPack(variant).matrix.requiredShards);
      expect(pass.promotionEligible).toBe(false);
      // The street contributions and the no-divergence pairs sum to the primary.
      const sum = pass.streetFamiliesDiagnostic.families.reduce((s, c) => s + c.meanBbPer100, 0);
      expect(sum + pass.streetFamiliesDiagnostic.noDivergenceContributionBbPer100!).toBeCloseTo(
        pass.cash.primary!.meanBbPer100,
        8
      );
    }
  );

  it('fails the primary gate and seed replication by name', () => {
    const variant = 'plo5';
    const seeds = omahaVariantStrengthPack(variant).holdout.seeds;
    const verdict = summarizeOmahaVariantStrength(
      variant,
      fullMatrix(variant, (profileId, seed, index) =>
        shard(variant, profileId, seed, index, {
          win: 1000,
          loss: seed === seeds[1] ? 1100 : 1000,
        })
      )
    );
    expect(verdict.qualified).toBe(false);
    expect(verdict.reasons).toContain('cash:primary:lower_bound_not_above_zero');
    expect(verdict.reasons).toContain(`cash:seed:${seeds[1]}:point_estimate_not_above_zero`);
  });

  it('fails nonregression for a losing position even when the pool wins', () => {
    const variant = 'plo6';
    const pack = omahaVariantStrengthPack(variant);
    const verdict = summarizeOmahaVariantStrength(
      variant,
      fullMatrix(variant, (profileId, seed, index) => {
        const seats = pack.matrix.profiles.find((p) => p.id === profileId)!.seats;
        const bb = seats === 2 ? 1 : 2;
        return shard(variant, profileId, seed, index, {
          win: 1200,
          loss: 1000,
          offsetShift: (o) => (o === bb ? -300 : 0),
        });
      })
    );
    expect(verdict.qualified).toBe(false);
    expect(verdict.reasons).toContain('cash:position:big_blind:regression_margin_exceeded');
    expect(verdict.cash.primary!.confidence99BbPer100[0]).toBeGreaterThan(0);
  });

  it('fails a profile and a depth band whose domain loses, by name', () => {
    const variant = 'plo8';
    const deep = `p11c-${variant}-6max-200bb`;
    const verdict = summarizeOmahaVariantStrength(
      variant,
      fullMatrix(variant, (profileId, seed, index) =>
        shard(variant, profileId, seed, index, {
          win: profileId === deep ? 400 : 1200,
          loss: 1000,
        })
      )
    );
    expect(verdict.reasons).toEqual(
      expect.arrayContaining([
        `cash:profile:${deep}:regression_margin_exceeded`,
        'cash:depth:deep:regression_margin_exceeded',
      ])
    );
  });

  it('reports street families as diagnostics that never gate, however far one falls', () => {
    // Per offset: a quarter identical, half lose 30.00 on the flop, a quarter
    // win 124.00 on the turn. The flop contribution is far below -10 bb/100,
    // yet every gating cell passes, so the pack qualifies.
    const variant = 'plo5';
    const verdict = summarizeOmahaVariantStrength(
      variant,
      fullMatrix(variant, (profileId, seed, index) =>
        shard(variant, profileId, seed, index, {
          win: 0,
          loss: 3000,
          street: 'flop',
          extra: { street: 'turn', value: 12400 },
        })
      )
    );
    const flop = verdict.streetFamiliesDiagnostic.families.find((f) => f.cell === 'street:flop')!;
    expect(flop.gate).toBe(false);
    expect(flop.confidence99BbPer100[1]).toBeLessThan(-10);
    expect(flop.divergingPairs).toBeGreaterThan(0);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.qualified).toBe(true);
  });

  it('does not trust an interval whose estimator is too skewed for the normal approximation', () => {
    const variant = 'plo8';
    const seed0 = omahaVariantStrengthPack(variant).holdout.seeds[0];
    const skewed = (profileId: string, seed: number, index: number) => {
      const s = shard(variant, profileId, seed, index, { win: 0, loss: 0 });
      for (const k of Object.keys(s.strata).filter((k) => k.endsWith('|flop'))) {
        const n = s.strata[k].n;
        const big = index === 0 && seed === seed0 && k === '0|flop';
        s.strata[k] = sums(
          big
            ? [
                [n - 1, 0],
                [1, 30_000_000],
              ]
            : [[n, 0]]
        );
      }
      return s;
    };
    const verdict = summarizeOmahaVariantStrength(variant, fullMatrix(variant, skewed));
    expect(verdict.reasons).toContain('cash:primary:interval_not_trusted');
  });

  it('refuses a missing, duplicate, invalid or foreign shard, and another pack never enters', () => {
    const variant = 'plo5';
    const required = omahaVariantStrengthRequiredShards(variant);
    const shards = fullMatrix(variant);
    const dropped = summarizeOmahaVariantStrength(variant, shards.slice(1));
    expect(dropped.reasons).toContain(`${required[0].key}:missing_shard`);
    const duplicated = summarizeOmahaVariantStrength(variant, [...shards, shards[0]]);
    expect(duplicated.reasons).toContain(`${required[0].key}:duplicate_shard`);
    // A complete, valid PLO6 matrix certifies nothing for PLO5.
    const plo6 = fullMatrix('plo6');
    const foreign = summarizeOmahaVariantStrength(variant, plo6);
    expect(foreign.qualified).toBe(false);
    expect(foreign.shardsUsed).toBe(0);
    expect(foreign.cash.primary).toBeNull();
    const plo6Key = omahaVariantStrengthRequiredShards('plo6')[0].key;
    expect(foreign.reasons).toEqual(
      expect.arrayContaining([
        `${plo6Key}:variant_mismatch`,
        `${plo6Key}:unknown_profile`,
        `${plo6Key}:not_holdout_seed`,
        `${plo6Key}:unexpected_shard`,
        `${required[0].key}:missing_shard`,
        'cash:no_shard_results',
      ])
    );
    const k = (i: number) => required[i].key;
    const broken = fullMatrix(variant);
    broken[3] = { ...broken[3], illegalActions: 1, settlementMismatches: 2 };
    broken[4] = { ...broken[4], evidenceMode: 'development' };
    broken[5] = { ...broken[5], contractDigest: '0'.repeat(64) };
    broken[6] = { ...broken[6], packVersion: 'plo5-high-round0' };
    broken[7] = {
      ...broken[7],
      fixedWork: { ...broken[7].fixedWork, moodClock: undefined as never },
    };
    broken[8] = { ...broken[8], variant: 'plo8' };
    const verdict = summarizeOmahaVariantStrength(variant, broken);
    expect(verdict.qualified).toBe(false);
    expect(verdict.reasons).toEqual(
      expect.arrayContaining([
        `${k(3)}:illegalActions`,
        `${k(3)}:settlementMismatches`,
        `${k(4)}:not_contract_mode`,
        `${k(5)}:contract_digest_mismatch`,
        `${k(6)}:pack_version_mismatch`,
        `${k(7)}:fixed_work_not_proven`,
        `${k(8)}:variant_mismatch`,
      ])
    );
  });

  it('refuses an identical trace with a nonzero difference and an unbalanced shard', () => {
    const variant = 'plo6';
    const pack = omahaVariantStrengthPack(variant);
    const s = shard(variant, `p11c-${variant}-6max-2dealt-100bb`, pack.holdout.seeds[0], 0);
    const key = `p11c-${variant}-6max-2dealt-100bb-${pack.holdout.seeds[0]}-s0`;
    const bad = {
      ...s,
      strata: { ...s.strata, '0|none': { ...s.strata['0|none'], s1: '5', s2: '25' } },
    };
    expect(omahaVariantStrengthShardReasons(variant, bad)).toContain(
      `${key}:paired_replay_mismatch`
    );
    const unbalanced = { ...s, offsetCounts: [s.offsetCounts[0] + 1, s.offsetCounts[1] - 1] };
    expect(omahaVariantStrengthShardReasons(variant, unbalanced)).toContain(
      `${key}:position_coverage_unbalanced`
    );
  });

  it('exposes the three packs and nothing else', () => {
    expect([...OMAHA_VARIANT_STRENGTH_VARIANTS]).toEqual(VARIANTS);
    expect(Object.keys(C.packs)).toEqual(VARIANTS);
    expect(() => omahaVariantStrengthPack('plo4' as OmahaPolicyVariant)).toThrow(
      'Unknown Phase 11 strength variant'
    );
  });
});
