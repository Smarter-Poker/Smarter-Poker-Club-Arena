import { describe, expect, it } from 'vitest';
import {
  REMAINING_VARIANT_MATRIX_JOB_CEILING,
  REMAINING_VARIANT_STRENGTH_CONTRACT,
  REMAINING_VARIANT_STRENGTH_VARIANTS,
  isRemainingVariantHoldoutSeed,
  isRemainingVariantHoldoutSeedOf,
  remainingVariantCellStatistic,
  remainingVariantMoodClockMs,
  remainingVariantStrengthContractDigest,
  remainingVariantStrengthPack,
  remainingVariantStrengthRequiredShards,
  remainingVariantStrengthShardReasons,
  summarizeRemainingVariantStrength,
  type RemainingVariantStrengthShardResult,
} from './RemainingVariantStrengthContract.js';
import {
  PLO4_STRENGTH_CONTRACT,
  Plo4PowerAccumulator,
  isPlo4HoldoutSeed,
  plo4StrengthContractDigest,
} from './Plo4StrengthContract.js';
import {
  OMAHA_VARIANT_STRENGTH_CONTRACT,
  isOmahaVariantHoldoutSeed,
  omahaVariantMoodClockMs,
  omahaVariantStrengthContractDigest,
} from './OmahaVariantStrengthContract.js';
import { PLO4_LEAGUE_SEEDS } from './Plo4PolicyLeague.js';
import { OMAHA_VARIANT_LEAGUE_SEEDS } from './OmahaVariantPolicyLeague.js';
import { REMAINING_VARIANT_LEAGUE_SEEDS } from './RemainingVariantPolicyLeague.js';
import { JOINT_LEAGUE_SEEDS } from './JointPolicyLeague.js';
import { TOURNAMENT_PROMOTION_SEEDS } from './HorseTournamentLeague.js';
import {
  REMAINING_VARIANT_DOMAIN,
  REMAINING_VARIANT_PACKS,
  remainingVariantSeatCap,
  type RemainingPolicyVariant,
} from '../engine/remainingVariants/RemainingVariantPolicyPack.js';
import { getFullRakeConfig, getPlayerCountCaps } from '../config/RakeConfig.js';
import { CASH_MAX_BB, CASH_MIN_BB } from '../config/cashBuyIn.js';
import { maxSeatsForVariant } from '../config/tableSeating.js';

const C = REMAINING_VARIANT_STRENGTH_CONTRACT;
const VARIANTS: RemainingPolicyVariant[] = ['short_deck', 'pineapple', 'flh', 'flo8'];
const FIXED: RemainingPolicyVariant[] = ['flh', 'flo8'];

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
  variant: RemainingPolicyVariant,
  profileId: string,
  seed: number,
  index: number,
  mix: Mix = { win: 1200, loss: 1000 }
): RemainingVariantStrengthShardResult {
  const pack = remainingVariantStrengthPack(variant);
  const p = pack.matrix.profiles.find((x) => x.id === profileId)!;
  const perOffset = pack.matrix.pairsPerShard / p.seats;
  const strata: RemainingVariantStrengthShardResult['strata'] = {};
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
    schema: 'horse-phase12-strength-shard-v1',
    variant,
    contractVersion: C.version,
    contractDigest: remainingVariantStrengthContractDigest(),
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
    illegalCandidates: 2,
    discards: variant === 'pineapple' ? 7 : 0,
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
  variant: RemainingPolicyVariant,
  make: (profileId: string, seed: number, index: number) => RemainingVariantStrengthShardResult = (
    profileId,
    seed,
    index
  ) => shard(variant, profileId, seed, index)
) => remainingVariantStrengthRequiredShards(variant).map((s) => make(s.profileId, s.seed, s.shard));

describe('P12.2 Phase 12 strength contract object', () => {
  it('is versioned, deeply immutable, and bound by a stable digest', () => {
    expect(C.schema).toBe('horse-phase12-strength-contract');
    expect(C.version).toBe('remaining-variant-strength-contract-v1');
    expect(C.phase).toBe('P12.2');
    expect(remainingVariantStrengthContractDigest()).toMatch(/^[0-9a-f]{64}$/);
    expect(remainingVariantStrengthContractDigest()).toBe(remainingVariantStrengthContractDigest());
    expect(Object.isFrozen(C)).toBe(true);
    expect(Object.isFrozen(C.packs.flo8.matrix.profiles[6])).toBe(true);
    expect(Object.isFrozen(C.liveConditions.differences[0])).toBe(true);
    expect(() => {
      (
        C.packs.flh.regressionMargin as { lowerBoundAtLeastBbPer100: number }
      ).lowerBoundAtLeastBbPer100 = -100;
    }).toThrow();
    expect(C.promotionEligible).toBe(false);
  });

  it('pins the contract digest, so a silent contract edit fails CI (Phase 10 audit F9)', () => {
    // A deliberate contract change must update this pin and say why. Anything
    // the contract reads (pack versions, the published rake rows, the buy-in
    // band, the seat law, the pack domain) moves it too, which fails closed:
    // evidence made under the old digest is then refused by name.
    // Round 3 (docs/horse-brain-phase12-round3-2026-10-08.md): moved only by
    // the four pack versions (round1 to round3); every profile, seed, pair
    // count, margin and threshold is the locked round-1 value. The round-1
    // digest was d85d7569c31a1cd583a2397c2f598e448859ff66b417ba8e549ba00bcc6e19f1.
    expect(remainingVariantStrengthContractDigest()).toBe(
      'fafbba8dc23ebc59b5aadf78fdcc47cd6f504baf9bcd10b07970ad7fbea501c0'
    );
  });

  it('leaves the Phase 10 and Phase 11 contracts and their pinned digests untouched', () => {
    expect(plo4StrengthContractDigest()).toBe(
      'ebdbdbb48336c0425df735fa073a4a28ef4884c199a69006e27909a6bc2b6384'
    );
    expect(omahaVariantStrengthContractDigest()).toBe(
      '0e58a56ab8d123e32d474f23f154e4026a9a2f1a6119b06e449b2a3039c10326'
    );
  });

  it.each(VARIANTS)('%s: one pack, its own candidate, population and profiles', (variant) => {
    const pack = remainingVariantStrengthPack(variant);
    const published = getFullRakeConfig(1, 2, variant);
    const ceiling = remainingVariantSeatCap(variant, 'cash');
    const fixed = FIXED.includes(variant);
    expect(pack.variant).toBe(variant);
    expect(pack.structure).toBe(fixed ? 'fixed_limit' : 'no_limit');
    expect(pack.candidate.packVersion).toBe(REMAINING_VARIANT_PACKS[variant].version);
    expect(pack.candidate.calibratedConfidence).toBeNull();
    expect(pack.candidate.owner).toContain('phase12Remaining "candidate"');
    expect(pack.candidate.owner).toContain('illegal_candidate guard');
    expect(pack.reference.owner).toContain('phase12Remaining "off"');
    expect(pack.candidate.splitLow).toBe(variant === 'flo8');
    expect(pack.candidate.discard).toContain(variant === 'pineapple' ? 'not a betting' : 'none');
    expect(pack.population.rake.percent).toBe(published.rakePercent);
    expect(pack.population.rake.cap).toBe(published.rakeCap);
    expect(pack.population.rake.playerCountCaps[6]).toEqual(
      getPlayerCountCaps(published.rakeCap, 6)
    );
    expect(
      pack.population.rake.playerCountCaps[
        ceiling as keyof typeof pack.population.rake.playerCountCaps
      ]
    ).toEqual(getPlayerCountCaps(published.rakeCap, ceiling));
    expect(pack.population.bbj.enabled).toBe(published.bbjEnabled);
    expect(pack.population.bbj.feeBB).toBe(published.bbjFeeBB);
    // Short Deck is not covered by the jackpot: its row drops nothing.
    expect(pack.population.bbj.enabled).toBe(variant !== 'short_deck');
    expect(pack.population.cashSeatCeiling).toBe(maxSeatsForVariant(variant));
    expect(ceiling).toBe(variant === 'flo8' ? 8 : 9);
    expect([...pack.population.tableSeats]).toEqual([6, ceiling]);
    expect(pack.population.buyInBandBB).toEqual([CASH_MIN_BB, CASH_MAX_BB]);
    const ids = [
      `p12c-${variant}-6max-2dealt-100bb`,
      `p12c-${variant}-6max-4dealt-100bb`,
      `p12c-${variant}-6max-40bb`,
      `p12c-${variant}-6max-100bb`,
      `p12c-${variant}-6max-200bb`,
      `p12c-${variant}-${ceiling}max-100bb`,
      ...(fixed ? [`p12c-${variant}-6max-1000bb`] : []),
    ];
    expect(pack.matrix.profiles.map((p) => p.id)).toEqual(ids);
    expect(
      pack.matrix.profiles.map((p) => [p.seats, p.tableSeats, p.stackBB, p.depthBand])
    ).toEqual([
      [2, 6, 100, 'standard'],
      [4, 6, 100, 'standard'],
      [6, 6, CASH_MIN_BB, 'short'],
      [6, 6, 100, 'standard'],
      [6, 6, CASH_MAX_BB, 'deep'],
      [ceiling, ceiling, 100, 'standard'],
      ...(fixed ? [[6, 6, REMAINING_VARIANT_DOMAIN.fixedLimitMaxStackBB, 'legacy_deep']] : []),
    ]);
    for (const p of pack.matrix.profiles) {
      expect(p.variant).toBe(variant);
      expect(p.seats).toBeLessThanOrEqual(pack.population.cashSeatCeiling);
      expect(p.stackBB).toBeLessThanOrEqual(
        fixed ? REMAINING_VARIANT_DOMAIN.fixedLimitMaxStackBB : REMAINING_VARIANT_DOMAIN.maxStackBB
      );
      expect(p.pilotSdBB).toBeGreaterThan(0);
      expect(p.pilotMsPerPair).toBeGreaterThan(0);
    }
    expect(pack.gatingCells.count).toBe(fixed ? 17 : 15);
    expect([...pack.gatingCells.depthBands]).toEqual(
      fixed ? ['short', 'standard', 'deep', 'legacy_deep'] : ['short', 'standard', 'deep']
    );
  });

  it('holds out three new seeds per pack, disjoint from every seed in the repository', () => {
    const others = [
      ...PLO4_LEAGUE_SEEDS,
      ...PLO4_STRENGTH_CONTRACT.holdout.seeds,
      ...OMAHA_VARIANT_LEAGUE_SEEDS,
      ...(['plo5', 'plo6', 'plo8'] as const).flatMap((v) => [
        ...OMAHA_VARIANT_STRENGTH_CONTRACT.packs[v].holdout.seeds,
      ]),
      ...REMAINING_VARIANT_LEAGUE_SEEDS,
      ...JOINT_LEAGUE_SEEDS,
      ...TOURNAMENT_PROMOTION_SEEDS,
    ];
    const all = VARIANTS.flatMap((v) => [...remainingVariantStrengthPack(v).holdout.seeds]);
    expect(new Set(all).size).toBe(12);
    const prefixes = { short_deck: '122', pineapple: '123', flh: '124', flo8: '125' };
    for (const variant of VARIANTS) {
      const pack = remainingVariantStrengthPack(variant);
      expect([...pack.holdout.developmentSeeds]).toEqual([...REMAINING_VARIANT_LEAGUE_SEEDS]);
      expect([...pack.matrix.seeds]).toEqual([...pack.holdout.seeds]);
      for (const seed of pack.holdout.seeds) {
        expect(String(seed)).toMatch(new RegExp(`^${prefixes[variant]}\\d{5}$`));
        expect(others).not.toContain(seed);
        expect(isRemainingVariantHoldoutSeed(seed)).toBe(true);
        expect(isRemainingVariantHoldoutSeedOf(variant, seed)).toBe(true);
        for (const other of VARIANTS.filter((v) => v !== variant))
          expect(isRemainingVariantHoldoutSeedOf(other, seed)).toBe(false);
        expect(isPlo4HoldoutSeed(seed)).toBe(false);
        expect(isOmahaVariantHoldoutSeed(seed)).toBe(false);
      }
    }
    for (const seed of others) expect(isRemainingVariantHoldoutSeed(seed)).toBe(false);
    // No held-out deal seed repeats a deal seed any development league or an
    // earlier matrix can deal (first 32 pairs of a development seed, the
    // development league maximum; first 4,096 of every held-out seed).
    const deal = (seed: number, i: number) => (seed ^ Math.imul(i + 1, 2654435761)) >>> 0 || 1;
    const dev = new Set(others.flatMap((s) => Array.from({ length: 32 }, (_, i) => deal(s, i))));
    for (const seed of all)
      for (let i = 0; i < 4096; i++) expect(dev.has(deal(seed, i))).toBe(false);
  });

  it('locks every pack matrix with balanced shards and planned gating cells inside the margin', () => {
    for (const variant of VARIANTS) {
      const pack = remainingVariantStrengthPack(variant);
      const required = remainingVariantStrengthRequiredShards(variant);
      expect(required).toHaveLength(pack.matrix.requiredShards);
      expect(new Set(required.map((r) => r.key)).size).toBe(required.length);
      expect(pack.matrix.requiredShards).toBeLessThanOrEqual(REMAINING_VARIANT_MATRIX_JOB_CEILING);
      expect(pack.matrix.rotationBlock).toBe(variant === 'flo8' ? 576 : 1296);
      expect(pack.matrix.pairsPerShard % pack.matrix.rotationBlock).toBe(0);
      for (const p of pack.matrix.profiles) {
        expect(pack.matrix.pairsPerShard % (p.seats * p.seats)).toBe(0);
        expect(pack.matrix.pairsPerProfile[p.id]).toBe(p.shards * pack.matrix.pairsPerShard * 3);
      }
      const cells = Object.entries(pack.matrix.plannedGatingCells);
      expect(cells).toHaveLength(pack.gatingCells.count);
      for (const [, plan] of cells) {
        expect(plan.halfWidthBbPer100).toBeLessThanOrEqual(
          pack.regressionMargin.plannedHalfWidthMaxBbPer100
        );
        expect(plan.minimumProfilePairs).toBeGreaterThanOrEqual(
          C.interval.minimumPairsPerProfileInCell
        );
        expect(plan.varianceRelativeSeAtPilotKurtosis).toBeLessThan(0.1);
      }
      // Under the 120-minute job timeout with room to spare at 2.5 x the pilot time.
      const slowest = Math.max(...pack.matrix.profiles.map((p) => p.pilotMsPerPair));
      expect((2.5 * slowest * pack.matrix.pairsPerShard) / 60000).toBeLessThan(60);
    }
    // Shard keys never collide across packs: every profile id names its variant.
    const keys = VARIANTS.flatMap((v) =>
      remainingVariantStrengthRequiredShards(v).map((r) => r.key)
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps the Phase 10 gates, with a fixed-limit margin stated before any run', () => {
    expect(C.thresholds.primary.lowerBoundAboveBbPer100).toBe(0);
    expect(C.thresholds.seedReplication.pointEstimateAboveBbPer100).toBe(0);
    expect(C.thresholds.nonregression.noLimitLowerBoundAtLeastBbPer100).toBe(-10);
    expect(C.thresholds.nonregression.fixedLimitLowerBoundAtLeastBbPer100).toBe(-4);
    for (const variant of VARIANTS) {
      const margin = remainingVariantStrengthPack(variant).regressionMargin;
      const fixed = FIXED.includes(variant);
      expect(margin.lowerBoundAtLeastBbPer100).toBe(fixed ? -4 : -10);
      expect(margin.plannedHalfWidthMaxBbPer100).toBe(fixed ? 3.4 : 8.5);
      expect(margin.reason).toContain(fixed ? 'two big bets' : 'one 100 BB buy-in');
    }
    expect(C.interval.edgeworthCoverageErrorMax).toBe(0.001);
    expect(C.interval.minimumPairsPerProfileInCell).toBe(10_000);
    expect(C.interval.z).toBe(2.5758293035489004);
    expect(C.gatingCells.streetFamilies.gate).toBe(false);
    expect(C.gatingCells.streetFamilies.whyNotAGate).toContain('cannot fail');
    expect(C.selectionGuard.gate).toBe(false);
    expect(C.notStrengthGates).toEqual(
      expect.arrayContaining([
        'atlas coordinate count',
        'changed proposal count',
        'illegal candidate count',
      ])
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
      'pineapple_discard',
      'field',
    ]);
    expect(C.liveConditions.differences[0].handling).toBe('addressed');
    for (const d of C.liveConditions.differences.slice(1))
      expect(d.handling).toMatch(/^(named limit|design)/);
    expect(C.liveConditions.admissionAlsoRequires[0]).toContain('natural completion-share');
    // The clock spreads over a day, depends on the deal seed only, and is the
    // clock the shared league computes for a moodClock profile.
    const draws = Array.from({ length: 2000 }, (_, i) => (i * 2654435761) >>> 0);
    expect(
      new Set(draws.map((s) => Math.floor(remainingVariantMoodClockMs(s) / 3_600_000))).size
    ).toBe(24);
    for (const s of draws) expect(remainingVariantMoodClockMs(s)).toBe(omahaVariantMoodClockMs(s));
    expect(remainingVariantMoodClockMs(86_401)).toBe(1000);
  });

  it('refuses the tournament objective by name, per pack, outside the cash reasons', () => {
    for (const variant of VARIANTS) {
      const pack = remainingVariantStrengthPack(variant);
      expect(pack.tournament.status).toBe('unavailable dependency');
      expect([...pack.tournament.refusals]).toEqual(
        variant === 'pineapple'
          ? ['tournament:pineapple_tournament_format_unavailable']
          : [
              `tournament:${variant}_whole_tournament_outcome_model_unavailable`,
              `tournament:qualified_${variant}_tournament_reference_population_unavailable`,
              `tournament:${variant}_tournament_thresholds_not_specified`,
            ]
      );
      const verdict = summarizeRemainingVariantStrength(variant, fullMatrix(variant));
      expect(verdict.qualified).toBe(true);
      expect(verdict.reasons).toEqual([]);
      expect(verdict.tournament).toEqual({
        status: 'unavailable dependency',
        qualified: false,
        reasons: pack.tournament.refusals,
      });
      expect(verdict.reasons.some((r) => r.startsWith('tournament:'))).toBe(false);
    }
    expect(remainingVariantSeatCap('pineapple', 'tournament')).toBe(0);
  });
});

describe('P12.2 interval and per-pack verdict', () => {
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
    const stat = remainingVariantCellStatistic('t', [group('x', a), group('y', b)]);
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
    '%s qualifies only on all its gating cells, reports the guard, and names every failure',
    (variant) => {
      const pack = remainingVariantStrengthPack(variant);
      const pass = summarizeRemainingVariantStrength(variant, fullMatrix(variant));
      expect(pass.qualified).toBe(true);
      expect(pass.cash.gatingCells).toBe(pack.gatingCells.count);
      expect(pass.cash.regressionMarginBbPer100).toBe(
        pack.regressionMargin.lowerBoundAtLeastBbPer100
      );
      expect(pass.cash.positions.map((p) => p.cell)).toEqual([
        'position:button',
        'position:small_blind',
        'position:big_blind',
        'position:cutoff',
        'position:middle',
        'position:early',
      ]);
      expect(pass.domain).toBe(`${variant}-cash-single-board-after-rake-horse-population`);
      expect(pass.shardsUsed).toBe(pack.matrix.requiredShards);
      // Reported beside changed, never gated.
      expect(pass.selectionGuard).toEqual({
        gate: false,
        illegalCandidates: 2 * pack.matrix.requiredShards,
        changed: pack.matrix.requiredShards,
      });
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
    const variant = 'short_deck';
    const seeds = remainingVariantStrengthPack(variant).holdout.seeds;
    const verdict = summarizeRemainingVariantStrength(
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
    const variant = 'pineapple';
    const pack = remainingVariantStrengthPack(variant);
    const verdict = summarizeRemainingVariantStrength(
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

  it('holds a fixed-limit pack to its own margin: a loss the no-limit margin would pass fails', () => {
    // The seat-ceiling profile wins 10.00 on a quarter of pairs and loses
    // 10.28 on another quarter: -3.5 bb/100 there, whose 99% lower bound at
    // the planned size lies inside -10 but outside -4.
    const variant = 'flh';
    const ceilingId = `p12c-${variant}-9max-100bb`;
    const make = (profileId: string, seed: number, index: number) =>
      shard(variant, profileId, seed, index, {
        win: profileId === ceilingId ? 1000 : 1200,
        loss: profileId === ceilingId ? 1028 : 1000,
      });
    const verdict = summarizeRemainingVariantStrength(variant, fullMatrix(variant, make));
    const cell = verdict.cash.profiles.find((c) => c.cell === `profile:${ceilingId}`)!;
    expect(cell.confidence99BbPer100[0]).toBeLessThan(-4);
    expect(cell.confidence99BbPer100[0]).toBeGreaterThan(-10);
    expect(verdict.reasons).toContain(`cash:profile:${ceilingId}:regression_margin_exceeded`);
    expect(verdict.qualified).toBe(false);
  });

  it('fails a profile and a depth band whose domain loses, by name, including legacy depth', () => {
    const variant = 'flo8';
    const legacy = `p12c-${variant}-6max-1000bb`;
    const verdict = summarizeRemainingVariantStrength(
      variant,
      fullMatrix(variant, (profileId, seed, index) =>
        shard(variant, profileId, seed, index, {
          win: profileId === legacy ? 400 : 1200,
          loss: 1000,
        })
      )
    );
    expect(verdict.reasons).toEqual(
      expect.arrayContaining([
        `cash:profile:${legacy}:regression_margin_exceeded`,
        'cash:depth:legacy_deep:regression_margin_exceeded',
      ])
    );
  });

  it('reports street families as diagnostics that never gate, however far one falls', () => {
    // Per offset: a quarter identical, half lose 30.00 on the flop, a quarter
    // win 124.00 on the turn. The flop contribution is far below the margin,
    // yet every gating cell passes, so the pack qualifies.
    const variant = 'short_deck';
    const verdict = summarizeRemainingVariantStrength(
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
    const variant = 'flo8';
    const seed0 = remainingVariantStrengthPack(variant).holdout.seeds[0];
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
    const verdict = summarizeRemainingVariantStrength(variant, fullMatrix(variant, skewed));
    expect(verdict.reasons).toContain('cash:primary:interval_not_trusted');
  });

  it('refuses a missing, duplicate, invalid or foreign shard, and another pack never enters', () => {
    const variant = 'short_deck';
    const required = remainingVariantStrengthRequiredShards(variant);
    const shards = fullMatrix(variant);
    const dropped = summarizeRemainingVariantStrength(variant, shards.slice(1));
    expect(dropped.reasons).toContain(`${required[0].key}:missing_shard`);
    const duplicated = summarizeRemainingVariantStrength(variant, [...shards, shards[0]]);
    expect(duplicated.reasons).toContain(`${required[0].key}:duplicate_shard`);
    // A complete, valid Pineapple matrix certifies nothing for Short Deck.
    const foreign = summarizeRemainingVariantStrength(variant, fullMatrix('pineapple'));
    expect(foreign.qualified).toBe(false);
    expect(foreign.shardsUsed).toBe(0);
    expect(foreign.cash.primary).toBeNull();
    const pineKey = remainingVariantStrengthRequiredShards('pineapple')[0].key;
    expect(foreign.reasons).toEqual(
      expect.arrayContaining([
        `${pineKey}:variant_mismatch`,
        `${pineKey}:unknown_profile`,
        `${pineKey}:not_holdout_seed`,
        `${pineKey}:unexpected_shard`,
        `${required[0].key}:missing_shard`,
        'cash:no_shard_results',
      ])
    );
    const k = (i: number) => required[i].key;
    const broken = fullMatrix(variant);
    broken[3] = { ...broken[3], illegalActions: 1, settlementMismatches: 2 };
    broken[4] = { ...broken[4], evidenceMode: 'development' };
    broken[5] = { ...broken[5], contractDigest: '0'.repeat(64) };
    broken[6] = { ...broken[6], packVersion: 'short-deck-round0' };
    broken[7] = {
      ...broken[7],
      fixedWork: { ...broken[7].fixedWork, moodClock: undefined as never },
    };
    broken[8] = { ...broken[8], variant: 'flh' };
    broken[9] = { ...broken[9], illegalCandidates: undefined as never };
    broken[10] = { ...broken[10], discards: 3 };
    broken[11] = { ...broken[11], schema: 'horse-phase11-strength-shard-v1' as never };
    const verdict = summarizeRemainingVariantStrength(variant, broken);
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
        `${k(9)}:illegalCandidates_unrecorded`,
        `${k(10)}:discards_outside_pineapple`,
        `${k(11)}:schema_mismatch`,
      ])
    );
  });

  it('refuses an identical trace with a nonzero difference and an unbalanced shard', () => {
    const variant = 'flh';
    const pack = remainingVariantStrengthPack(variant);
    const id = `p12c-${variant}-6max-2dealt-100bb`;
    const s = shard(variant, id, pack.holdout.seeds[0], 0);
    const key = `${id}-${pack.holdout.seeds[0]}-s0`;
    const bad = {
      ...s,
      strata: { ...s.strata, '0|none': { ...s.strata['0|none'], s1: '5', s2: '25' } },
    };
    expect(remainingVariantStrengthShardReasons(variant, bad)).toContain(
      `${key}:paired_replay_mismatch`
    );
    const unbalanced = { ...s, offsetCounts: [s.offsetCounts[0] + 1, s.offsetCounts[1] - 1] };
    expect(remainingVariantStrengthShardReasons(variant, unbalanced)).toContain(
      `${key}:position_coverage_unbalanced`
    );
  });

  it('exposes the four packs and nothing else', () => {
    expect([...REMAINING_VARIANT_STRENGTH_VARIANTS]).toEqual(VARIANTS);
    expect(Object.keys(C.packs)).toEqual(VARIANTS);
    expect(() => remainingVariantStrengthPack('plo4' as RemainingPolicyVariant)).toThrow(
      'Unknown Phase 12 strength variant'
    );
  });
});
