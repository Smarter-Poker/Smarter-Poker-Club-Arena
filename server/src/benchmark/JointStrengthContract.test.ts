import { describe, expect, it } from 'vitest';
import {
  JOINT_MATRIX_JOB_CEILING,
  JOINT_STRENGTH_CONTRACT,
  JOINT_STRENGTH_VARIANTS,
  JOINT_STRENGTH_Z99,
  isJointHoldoutSeed,
  isJointHoldoutSeedOf,
  jointCellStatistic,
  jointMoodClockMs,
  jointStrengthContractDigest,
  jointStrengthDomain,
  jointStrengthPack,
  jointStrengthRequiredShards,
  jointStrengthShardReasons,
  summarizeJointStrength,
  type JointStrengthShardResult,
  type JointStrengthVariant,
} from './JointStrengthContract.js';
import {
  PLO4_STRENGTH_CONTRACT,
  Plo4PowerAccumulator,
  isPlo4HoldoutSeed,
} from './Plo4StrengthContract.js';
import {
  OMAHA_VARIANT_STRENGTH_CONTRACT,
  isOmahaVariantHoldoutSeed,
  omahaVariantMoodClockMs,
} from './OmahaVariantStrengthContract.js';
import {
  REMAINING_VARIANT_STRENGTH_CONTRACT,
  isRemainingVariantHoldoutSeed,
  remainingVariantStrengthPack,
} from './RemainingVariantStrengthContract.js';
import { PLO4_LEAGUE_SEEDS } from './Plo4PolicyLeague.js';
import { OMAHA_VARIANT_LEAGUE_SEEDS } from './OmahaVariantPolicyLeague.js';
import { REMAINING_VARIANT_LEAGUE_SEEDS } from './RemainingVariantPolicyLeague.js';
import { JOINT_LEAGUE_SEEDS } from './JointPolicyLeague.js';
import { TOURNAMENT_PROMOTION_SEEDS } from './HorseTournamentLeague.js';
import { KNOWN_VARIANTS, horseVariantRulesFor } from '../engine/VariantRules.js';
import { bettingStructureFor } from '../engine/BettingStructure.js';
import { JOINT_LIVE_DOMAIN } from '../engine/multiway/JointSampleAcquisition.js';
import {
  JOINT_ACTION_PACK,
  JOINT_ACTION_PACK_ROUND1,
} from '../engine/multiway/JointActionModel.js';
import { JOINT_RANGE_PACK } from '../engine/multiway/JointRangeSampler.js';
import { getFullRakeConfig, getPlayerCountCaps } from '../config/RakeConfig.js';
import { CASH_MAX_BB, CASH_MIN_BB } from '../config/cashBuyIn.js';
import { maxSeatsForVariant } from '../config/tableSeating.js';

const C = JOINT_STRENGTH_CONTRACT;
const VARIANTS = JOINT_STRENGTH_VARIANTS as JointStrengthVariant[];
const fixed = (v: JointStrengthVariant) => bettingStructureFor(v) === 'fixed_limit';

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
  /** Per offset: a quarter of pairs at win + shift and a quarter at -loss + shift
   * on `street`, the rest identical (none). */
  win: number;
  loss: number;
  street?: string;
  offsetShift?: (offset: number) => number;
}
/** A contract-mode shard of `variant` whose every offset has the same value mix. */
function shard(
  variant: JointStrengthVariant,
  profileId: string,
  seed: number,
  index: number,
  mix: Mix = { win: 1200, loss: 1000 }
): JointStrengthShardResult {
  const pack = jointStrengthPack(variant);
  const p = pack.matrix.profiles.find((x) => x.id === profileId)!;
  const perOffset = pack.matrix.pairsPerShard / p.seats;
  const strata: JointStrengthShardResult['strata'] = {};
  const quarter = Math.floor(perOffset / 4);
  for (let o = 0; o < p.seats; o++) {
    const shift = mix.offsetShift?.(o) ?? 0;
    strata[`${o}|none`] = sums([[perOffset - 2 * quarter, 0]]);
    strata[`${o}|${mix.street ?? 'flop'}`] = sums([
      [quarter, mix.win + shift],
      [quarter, -mix.loss + shift],
    ]);
  }
  return {
    schema: 'horse-phase13-strength-shard-v1',
    variant,
    contractVersion: C.version,
    contractDigest: jointStrengthContractDigest(),
    packVersion: pack.candidate.packVersion,
    domainVersion: pack.candidate.domainVersion,
    rangePackVersion: pack.candidate.rangePackVersion,
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
    changedPairs: 2 * quarter * p.seats,
    decisions: 1,
    eligible: 3,
    fired: 3,
    changed: 1,
    illegalCandidates: 0,
    earlierPhaseRefusals: 0,
    workBudgetRefusals: 0,
    responseBranchUnavailable: 2,
    insufficientSamples: 0,
    eligibleByBoards: { [p.boards]: 3 },
    discards: variant === 'pineapple' ? 7 : 0,
    illegalActions: 0,
    conservationErrors: 0,
    cardErrors: 0,
    truncatedHands: 0,
    settlementMismatches: 0,
    deductionMismatches: 0,
    pairedReplayMismatches: 0,
    showdownsChecked: 1,
    multiBoardShowdownsChecked: p.boards > 1 ? 1 : 0,
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
      policyClock: 'phase13_evidence_mode_fixed_clock',
      moodClock: 'deal_seed_time_of_day',
    },
    durationMs: 1,
    promotionEligible: false,
  };
}
const fullMatrix = (
  variant: JointStrengthVariant,
  make: (profileId: string, seed: number, index: number) => JointStrengthShardResult = (
    profileId,
    seed,
    index
  ) => shard(variant, profileId, seed, index)
) => jointStrengthRequiredShards(variant).map((s) => make(s.profileId, s.seed, s.shard));

describe('P13.2 joint strength contract object', () => {
  it('is versioned, deeply immutable, and bound by a stable digest', () => {
    expect(C.schema).toBe('horse-phase13-strength-contract');
    expect(C.version).toBe('joint-strength-contract-v1');
    expect(C.phase).toBe('P13.2');
    expect(C.promotionEligible).toBe(false);
    expect(Object.isFrozen(C)).toBe(true);
    expect(Object.isFrozen(C.packs.nlh.matrix.profiles[0])).toBe(true);
    expect(Object.isFrozen(C.packs.flo8.holdout.seeds)).toBe(true);
    expect(() => {
      (
        C.packs.nlh.regressionMargin as { lowerBoundAtLeastBbPer100: number }
      ).lowerBoundAtLeastBbPer100 = -50;
    }).toThrow();
    expect(jointStrengthContractDigest()).toBe(jointStrengthContractDigest());
    expect(jointStrengthContractDigest()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('pins the contract digest, so a silent contract edit fails CI (Phase 10 audit F9)', () => {
    // Round 3 (October 8, 2026): only the candidate response pack identity
    // moved, to joint-action-response-round3-v1; the population, rake model,
    // profiles, held-out seeds, matrix and thresholds are unchanged. The
    // October 6 matrices measured a036e702e7659334a2c531f8bf90fb5e3a852686028fad47f182e486b57bb754.
    expect(jointStrengthContractDigest()).toBe(
      '1d0dd99be2fedd7ec50e502cf4241611818dd30aec794714808888616dc5dd96'
    );
  });

  it('exposes exactly the nine variants of KNOWN_VARIANTS, one domain each', () => {
    expect([...JOINT_STRENGTH_VARIANTS]).toEqual([...KNOWN_VARIANTS]);
    expect(Object.keys(C.packs)).toEqual([...KNOWN_VARIANTS]);
    for (const v of VARIANTS)
      expect(jointStrengthDomain(v)).toBe(`${v}-cash-joint-multiway-after-rake-horse-population`);
    expect(() => jointStrengthPack('stud' as JointStrengthVariant)).toThrow(
      'Unknown Phase 13 strength variant'
    );
  });

  it('uses the Phase 12 z for every interval', () => {
    expect(JOINT_STRENGTH_Z99).toBe(REMAINING_VARIANT_STRENGTH_CONTRACT.interval.z);
    expect(C.interval.z).toBe(JOINT_STRENGTH_Z99);
    expect(C.interval.edgeworthCoverageErrorMax).toBe(
      REMAINING_VARIANT_STRENGTH_CONTRACT.interval.edgeworthCoverageErrorMax
    );
    expect(C.interval.minimumPairsPerProfileInCell).toBe(
      REMAINING_VARIANT_STRENGTH_CONTRACT.interval.minimumPairsPerProfileInCell
    );
  });

  it.each(VARIANTS)(
    '%s: the joint candidate, the off reference, its population and profiles',
    (v) => {
      const pack = jointStrengthPack(v);
      expect(pack.candidate).toMatchObject({
        packVersion: 'joint-action-response-round3-v1',
        domainVersion: 'joint-multiway-round1-v4',
        rangePackVersion: 'joint-public-range-round1-v1',
        comparisonResponseVersion: 'joint-action-response-round1-v2',
        calibratedConfidence: null,
      });
      expect(pack.candidate.packVersion).toBe(JOINT_ACTION_PACK.version);
      expect(pack.candidate.domainVersion).toBe(JOINT_LIVE_DOMAIN.version);
      expect(pack.candidate.rangePackVersion).toBe(JOINT_RANGE_PACK.version);
      expect(pack.candidate.comparisonResponseVersion).toBe(JOINT_ACTION_PACK_ROUND1.version);
      expect(pack.candidate.owner).toContain('phase13Joint "candidate"');
      expect(pack.reference.owner).toContain('phase13Joint "off"');
      // Published rake and BBJ from the engine's own lookup.
      const published = getFullRakeConfig(1, 2, v);
      expect(pack.population.rake.percent).toBe(published.rakePercent);
      expect(pack.population.rake.cap).toBe(published.rakeCap);
      expect(pack.population.rake.playerCountCaps[6]).toEqual(
        getPlayerCountCaps(published.rakeCap, 6)
      );
      expect(pack.population.bbj.enabled).toBe(published.bbjEnabled);
      expect(pack.population.bbj.feeBB).toBe(published.bbjFeeBB);
      expect(pack.population.cashSeatCeiling).toBe(maxSeatsForVariant(v));
      expect(pack.population.buyInBandBB).toEqual([CASH_MIN_BB, CASH_MAX_BB]);
      // Bomb hands are measured at six dealt, where the controller activates
      // every requested board for every variant (never a silent downgrade).
      expect(pack.population.bombPot.boardsActivatedAtSixDealt).toEqual([1, 2, 3]);
      const rules = horseVariantRulesFor(v);
      expect(6 * rules.holeCardsDealt + 15).toBeLessThanOrEqual(rules.deckSize);
      const ceiling = maxSeatsForVariant(v);
      const extra = ceiling > 6 ? ceiling : 4;
      const ids = pack.matrix.profiles.map((p) => p.id);
      expect(ids).toEqual([
        `p13c-${v}-3dealt-100bb`,
        extra > 6 ? `p13c-${v}-${extra}max-100bb` : `p13c-${v}-4dealt-100bb`,
        `p13c-${v}-6max-40bb`,
        `p13c-${v}-6max-100bb`,
        `p13c-${v}-6max-200bb`,
        `p13c-${v}-bomb1-6max-100bb`,
        `p13c-${v}-bomb2-6max-100bb`,
        `p13c-${v}-bomb3-6max-100bb`,
        ...(fixed(v) ? [`p13c-${v}-6max-1000bb`] : []),
      ]);
      for (const p of pack.matrix.profiles) {
        expect(p.variant).toBe(v);
        expect(p.seats).toBeGreaterThanOrEqual(3);
        expect(p.seats).toBeLessThanOrEqual(ceiling);
        expect(p.tableSeats).toBe(Math.max(6, p.seats));
        expect(p.boards).toBe(p.bombBoards ?? 1);
        expect(p.stackBB).toBeLessThanOrEqual(
          fixed(v) ? JOINT_LIVE_DOMAIN.fixedLimitMaxStackBB : JOINT_LIVE_DOMAIN.maxStackBB
        );
        expect(p.pilotSdBB).toBeGreaterThan(0);
        expect(p.pilotMsPerPair).toBeGreaterThan(0);
        expect(p.pilotEligiblePerPair).toBeGreaterThan(0);
        expect(p.shards).toBeGreaterThan(0);
      }
      expect(pack.gatingCells.count).toBe(pack.matrix.profiles.length + 6 + (fixed(v) ? 4 : 3) + 3);
      expect(pack.regressionMargin.lowerBoundAtLeastBbPer100).toBe(fixed(v) ? -4 : -10);
      const excluded = pack.population.excludedFromQualifiedDomain.join(' ');
      expect(excluded).toContain('heads-up single-board hands');
      expect(excluded).toContain(v === 'nlh' ? 'Diamond NLH whole-unit cash' : 'Diamond tables');
    }
  );

  it('holds out three new seeds per variant, disjoint from every seed in the repository', () => {
    const others = [
      ...PLO4_LEAGUE_SEEDS,
      ...PLO4_STRENGTH_CONTRACT.holdout.seeds,
      ...OMAHA_VARIANT_LEAGUE_SEEDS,
      ...(['plo5', 'plo6', 'plo8'] as const).flatMap((v) => [
        ...OMAHA_VARIANT_STRENGTH_CONTRACT.packs[v].holdout.seeds,
      ]),
      ...REMAINING_VARIANT_LEAGUE_SEEDS,
      ...(['short_deck', 'pineapple', 'flh', 'flo8'] as const).flatMap((v) => [
        ...remainingVariantStrengthPack(v).holdout.seeds,
      ]),
      ...JOINT_LEAGUE_SEEDS,
      ...TOURNAMENT_PROMOTION_SEEDS,
    ];
    const all = VARIANTS.flatMap((v) => [...jointStrengthPack(v).holdout.seeds]);
    expect(new Set(all).size).toBe(27);
    VARIANTS.forEach((variant, index) => {
      const pack = jointStrengthPack(variant);
      expect([...pack.holdout.developmentSeeds]).toEqual([...JOINT_LEAGUE_SEEDS]);
      expect([...pack.matrix.seeds]).toEqual([...pack.holdout.seeds]);
      pack.holdout.seeds.forEach((seed, k) => {
        expect(String(seed)).toMatch(new RegExp(`^132${index + 1}${k + 1}\\d{3}$`));
        expect(others).not.toContain(seed);
        expect(isJointHoldoutSeed(seed)).toBe(true);
        expect(isJointHoldoutSeedOf(variant, seed)).toBe(true);
        for (const other of VARIANTS.filter((v) => v !== variant))
          expect(isJointHoldoutSeedOf(other, seed)).toBe(false);
        expect(isPlo4HoldoutSeed(seed)).toBe(false);
        expect(isOmahaVariantHoldoutSeed(seed)).toBe(false);
        expect(isRemainingVariantHoldoutSeed(seed)).toBe(false);
      });
    });
    for (const seed of others) expect(isJointHoldoutSeed(seed)).toBe(false);
    // No held-out deal seed repeats a deal seed any development league or an
    // earlier matrix can deal (first 32 pairs of every other seed; first
    // 4,096 of every held-out seed).
    const deal = (seed: number, i: number) => (seed ^ Math.imul(i + 1, 2654435761)) >>> 0 || 1;
    const dev = new Set(others.flatMap((s) => Array.from({ length: 32 }, (_, i) => deal(s, i))));
    for (const seed of all)
      for (let i = 0; i < 4096; i++) expect(dev.has(deal(seed, i))).toBe(false);
  });

  it('locks every variant matrix with balanced shards, the job ceiling and the hosted budget', () => {
    const keys: string[] = [];
    for (const v of VARIANTS) {
      const pack = jointStrengthPack(v);
      const required = jointStrengthRequiredShards(v);
      keys.push(...required.map((r) => r.key));
      expect(required).toHaveLength(pack.matrix.requiredShards);
      expect(new Set(required.map((r) => r.key)).size).toBe(required.length);
      expect(pack.matrix.requiredShards).toBeLessThanOrEqual(JOINT_MATRIX_JOB_CEILING);
      expect(pack.matrix.pairsPerShard % pack.matrix.rotationBlock).toBe(0);
      expect(pack.matrix.pairsPerShard).toBeGreaterThan(0);
      for (const p of pack.matrix.profiles) {
        expect(pack.matrix.pairsPerShard % (p.seats * p.seats)).toBe(0);
        expect(pack.matrix.pairsPerProfile[p.id]).toBe(p.shards * pack.matrix.pairsPerShard * 3);
      }
      const cells = Object.entries(pack.matrix.plannedGatingCells);
      expect(cells).toHaveLength(pack.gatingCells.count);
      for (const [, plan] of cells) {
        expect(plan.minimumProfilePairs).toBeGreaterThanOrEqual(
          C.interval.minimumPairsPerProfileInCell
        );
        expect(plan.varianceRelativeSeAtPilotKurtosis).toBeLessThan(0.1);
      }
      // Well under the 120-minute job timeout on a hosted runner.
      const budget = C.matrixRules.hostedBudget;
      expect(pack.matrix.hostedEstimate.slowestShardMinutes).toBeLessThanOrEqual(
        budget.maxMinutesPerShard
      );
      expect(pack.matrix.hostedEstimate.jobs).toBe(pack.matrix.requiredShards);
      expect(pack.matrix.hostedEstimate.wallHoursAtMaxParallel).toBeLessThanOrEqual(
        budget.targetWallHours
      );
    }
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps the Phase 12 gates and margins, stated before any run', () => {
    expect(C.thresholds.primary.lowerBoundAboveBbPer100).toBe(0);
    expect(C.thresholds.seedReplication.pointEstimateAboveBbPer100).toBe(0);
    expect(C.thresholds.nonregression.noLimitLowerBoundAtLeastBbPer100).toBe(
      REMAINING_VARIANT_STRENGTH_CONTRACT.thresholds.nonregression.noLimitLowerBoundAtLeastBbPer100
    );
    expect(C.thresholds.nonregression.fixedLimitLowerBoundAtLeastBbPer100).toBe(
      REMAINING_VARIANT_STRENGTH_CONTRACT.thresholds.nonregression
        .fixedLimitLowerBoundAtLeastBbPer100
    );
    expect(C.selectionGuard.gate).toBe(false);
    expect(C.softwareValidity.perShard).toMatchObject({
      illegalCandidates: 0,
      earlierPhaseRefusals: 0,
    });
    expect(C.gatingCells.streetFamilies.gate).toBe(false);
    expect([...C.gatingCells.positions]).toEqual([
      'button',
      'small_blind',
      'big_blind',
      'cutoff',
      'middle',
      'early',
    ]);
  });

  it('names every harness-versus-live difference and its handling', () => {
    const ids = C.liveConditions.differences.map((d) => d.id);
    expect(ids).toEqual([
      'mood',
      'style_modifiers',
      'horsemind_history',
      'policy_clock_and_sampling',
      'response_branch_refusals',
      'second_look',
      'earlier_phases',
      'pineapple_discard',
      'bomb_schedule',
      'field',
    ]);
    for (const d of C.liveConditions.differences) {
      expect(d.live.length).toBeGreaterThan(0);
      expect(d.harness.length).toBeGreaterThan(0);
      expect(d.handling).toMatch(/^(addressed|named limit|design)/);
    }
    expect(C.liveConditions.admissionAlsoRequires[0]).toContain('work_budget');
    expect(jointMoodClockMs(123456789)).toBe(omahaVariantMoodClockMs(123456789));
  });

  it('refuses the tournament objective by name, per variant, outside the cash reasons', () => {
    for (const v of VARIANTS) {
      const pack = jointStrengthPack(v);
      expect(pack.tournament.status).toBe('unavailable dependency');
      if (v === 'pineapple')
        expect([...pack.tournament.refusals]).toEqual([
          'tournament:pineapple_tournament_format_unavailable',
        ]);
      else
        expect([...pack.tournament.refusals]).toEqual([
          `tournament:${v}_joint_whole_tournament_outcome_model_unavailable`,
          `tournament:qualified_${v}_joint_tournament_reference_population_unavailable`,
          `tournament:${v}_joint_tournament_thresholds_not_specified`,
        ]);
      const verdict = summarizeJointStrength(v, fullMatrix(v));
      expect(verdict.tournament.reasons).toEqual(pack.tournament.refusals);
      expect(verdict.reasons.some((r) => r.startsWith('tournament:'))).toBe(false);
    }
  });
});

describe('P13.2 interval and per-variant verdict', () => {
  it('computes the stratified mean, standard error and 99% interval exactly as stated', () => {
    const acc = new Plo4PowerAccumulator();
    for (const v of [100, -100, 300, -100]) acc.add(v);
    const stat = jointCellStatistic('x', [
      { profileId: 'a', weight: 1, n: acc.n, s1: acc.s1, s2: acc.s2, s3: acc.s3 },
    ]);
    // mean 50 cents = 0.25 BB = 25 bb/100; s^2 = (n S2 - S1^2) / (n (n - 1))
    // = (4 * 120000 - 200^2) / 12 cents^2; se = sqrt(s^2 / n).
    expect(stat.meanBbPer100).toBeCloseTo(25, 10);
    const se = Math.sqrt((4 * 120000 - 200 * 200) / 12 / 4);
    expect(stat.standardErrorBbPer100).toBeCloseTo((se / 200) * 100, 10);
    expect(stat.confidence99BbPer100[0]).toBeCloseTo(
      25 - JOINT_STRENGTH_Z99 * ((se / 200) * 100),
      10
    );
    expect(stat.intervalTrusted).toBe(false); // four pairs, far below the floor
  });

  it.each(VARIANTS)('%s: a winning valid matrix qualifies on every gating cell', (v) => {
    const verdict = summarizeJointStrength(v, fullMatrix(v));
    expect(verdict.reasons).toEqual([]);
    expect(verdict.qualified).toBe(true);
    expect(verdict.shardsUsed).toBe(jointStrengthPack(v).matrix.requiredShards);
    expect(verdict.cash.gatingCells).toBe(jointStrengthPack(v).gatingCells.count);
    expect(verdict.cash.boardCounts.map((c) => c.cell)).toEqual([
      'boards:1',
      'boards:2',
      'boards:3',
    ]);
    expect(verdict.selectionGuard).toMatchObject({ gate: false, illegalCandidates: 0 });
    expect(verdict.diagnostics.responseBranchUnavailable).toBe(2 * verdict.shardsUsed);
    expect(verdict.promotionEligible).toBe(false);
  });

  it('fails the primary gate and seed replication by name', () => {
    const v: JointStrengthVariant = 'plo4';
    const seeds = jointStrengthPack(v).holdout.seeds;
    const losing = summarizeJointStrength(
      v,
      fullMatrix(v, (p, s, i) => shard(v, p, s, i, { win: 1000, loss: 1000 }))
    );
    expect(losing.reasons).toContain('cash:primary:lower_bound_not_above_zero');
    for (const seed of seeds)
      expect(losing.reasons).toContain(`cash:seed:${seed}:point_estimate_not_above_zero`);
    const oneSeed = summarizeJointStrength(
      v,
      fullMatrix(v, (p, s, i) =>
        shard(v, p, s, i, s === seeds[1] ? { win: 800, loss: 1000 } : { win: 1200, loss: 1000 })
      )
    );
    expect(oneSeed.reasons).toContain(`cash:seed:${seeds[1]}:point_estimate_not_above_zero`);
    expect(oneSeed.qualified).toBe(false);
  });

  it('fails nonregression for a losing position and a losing board count even when the pool wins', () => {
    const v: JointStrengthVariant = 'nlh';
    // Offset 2 (big blind at every table size) loses heavily.
    const position = summarizeJointStrength(
      v,
      fullMatrix(v, (p, s, i) =>
        shard(v, p, s, i, { win: 1600, loss: 600, offsetShift: (o) => (o === 2 ? -6000 : 0) })
      )
    );
    expect(position.reasons).toContain('cash:position:big_blind:regression_margin_exceeded');
    expect(position.cash.primary!.confidence99BbPer100[0]).toBeLessThan(
      position.cash.positions.find((c) => c.cell === 'position:button')!.confidence99BbPer100[0]
    );
    // The three-board bomb hand loses; its profile and its board count fail.
    const boards = summarizeJointStrength(
      v,
      fullMatrix(v, (p, s, i) =>
        shard(v, p, s, i, p.includes('bomb3') ? { win: 0, loss: 8000 } : { win: 1600, loss: 600 })
      )
    );
    expect(boards.reasons).toEqual(
      expect.arrayContaining([
        `cash:profile:p13c-nlh-bomb3-6max-100bb:regression_margin_exceeded`,
        'cash:boards:3:regression_margin_exceeded',
      ])
    );
    expect(boards.reasons).not.toContain('cash:boards:2:regression_margin_exceeded');
  });

  it('holds a fixed-limit variant to its own margin, including legacy depth', () => {
    const v: JointStrengthVariant = 'flo8';
    const verdict = summarizeJointStrength(
      v,
      fullMatrix(v, (p, s, i) =>
        shard(v, p, s, i, p.endsWith('1000bb') ? { win: 0, loss: 3000 } : { win: 1600, loss: 600 })
      )
    );
    expect(verdict.cash.regressionMarginBbPer100).toBe(-4);
    expect(verdict.reasons).toEqual(
      expect.arrayContaining([
        'cash:profile:p13c-flo8-6max-1000bb:regression_margin_exceeded',
        'cash:depth:legacy_deep:regression_margin_exceeded',
      ])
    );
  });

  it('reports street families as diagnostics that never gate, however far one falls', () => {
    const v: JointStrengthVariant = 'flh';
    const verdict = summarizeJointStrength(
      v,
      fullMatrix(v, (p, s, i) => shard(v, p, s, i, { win: 1200, loss: 1000, street: 'river' }))
    );
    expect(verdict.qualified).toBe(true);
    expect(verdict.streetFamiliesDiagnostic.gate).toBe(false);
    const river = verdict.streetFamiliesDiagnostic.families.find((f) => f.cell === 'street:river')!;
    expect(river.gate).toBe(false);
    expect(river.divergingPairs).toBeGreaterThan(0);
    const total =
      verdict.streetFamiliesDiagnostic.families.reduce((s, f) => s + f.meanBbPer100, 0) +
      verdict.streetFamiliesDiagnostic.noDivergenceContributionBbPer100!;
    expect(total).toBeCloseTo(verdict.cash.primary!.meanBbPer100, 9);
  });

  it('does not trust an interval whose estimator is too skewed for the normal approximation', () => {
    const acc = new Plo4PowerAccumulator();
    const g = { profileId: 'a', weight: 1, n: 20_000, s1: 0n, s2: 0n, s3: 0n };
    // 19,990 pairs at 0 and 10 at a huge win: extreme skew.
    for (let i = 0; i < 10; i++) acc.add(5_000_000);
    g.s1 = acc.s1;
    g.s2 = acc.s2;
    g.s3 = acc.s3;
    const stat = jointCellStatistic('skew', [g]);
    expect(stat.edgeworthCoverageError).toBeGreaterThan(C.interval.edgeworthCoverageErrorMax);
    expect(stat.intervalTrusted).toBe(false);
  });

  it('refuses a missing, duplicate, invalid or foreign shard, and another variant never enters', () => {
    const v: JointStrengthVariant = 'pineapple';
    const matrix = fullMatrix(v);
    const [first, second] = jointStrengthRequiredShards(v);
    const missing = summarizeJointStrength(v, matrix.slice(1));
    expect(missing.reasons).toContain(`${first.key}:missing_shard`);
    const dup = summarizeJointStrength(v, [...matrix, matrix[1]]);
    expect(dup.reasons).toContain(`${second.key}:duplicate_shard`);
    // A complete, valid matrix of another variant gives no cell at all here.
    const foreign = summarizeJointStrength('short_deck', fullMatrix(v));
    expect(foreign.shardsUsed).toBe(0);
    expect(foreign.reasons).toContain('cash:no_shard_results');
    expect(foreign.reasons.some((r) => r.endsWith(':variant_mismatch'))).toBe(true);
    // Invalid shards are refused by name.
    const bad = (patch: Partial<JointStrengthShardResult>) =>
      jointStrengthShardReasons(v, { ...matrix[0], ...patch });
    expect(bad({ evidenceMode: 'development' })).toContain(`${first.key}:not_contract_mode`);
    expect(bad({ contractDigest: '0'.repeat(64) })).toContain(
      `${first.key}:contract_digest_mismatch`
    );
    expect(bad({ packVersion: 'joint-action-response-round1-v2' })).toContain(
      `${first.key}:pack_version_mismatch`
    );
    expect(bad({ domainVersion: 'joint-multiway-round1-v3' })).toContain(
      `${first.key}:domain_version_mismatch`
    );
    expect(bad({ rangePackVersion: 'x' })).toContain(`${first.key}:range_pack_version_mismatch`);
    expect(bad({ seed: JOINT_LEAGUE_SEEDS[0] })).toEqual(
      expect.arrayContaining([expect.stringMatching(/:not_holdout_seed$/)])
    );
    expect(bad({ complete: false })).toContain(`${first.key}:incomplete`);
    expect(bad({ settlementMismatches: 1 })).toContain(`${first.key}:settlementMismatches`);
    // The guard refusals are validity failures under this contract.
    expect(bad({ illegalCandidates: 1 })).toEqual([`${first.key}:illegalCandidates`]);
    expect(bad({ earlierPhaseRefusals: 2 })).toEqual([`${first.key}:earlierPhaseRefusals`]);
    expect(bad({ illegalCandidates: undefined as unknown as number })).toContain(
      `${first.key}:illegalCandidates_unrecorded`
    );
    // The diagnostics must be recorded, but never gate.
    expect(
      bad({ workBudgetRefusals: 40, responseBranchUnavailable: 9, insufficientSamples: 3 })
    ).toEqual([]);
    expect(bad({ workBudgetRefusals: -1 })).toContain(`${first.key}:workBudgetRefusals_unrecorded`);
    expect(bad({ fixedWork: { ...matrix[0].fixedWork, scale: 0.5 as 1 } })).toContain(
      `${first.key}:fixed_work_not_proven`
    );
    expect(bad({ promotionEligible: true as false })).toContain(
      `${first.key}:shard_claims_promotion`
    );
    expect(
      jointStrengthShardReasons('nlh', {
        ...shard(
          'nlh',
          jointStrengthRequiredShards('nlh')[0].profileId,
          jointStrengthPack('nlh').holdout.seeds[0],
          0
        ),
        discards: 1,
      })
    ).toEqual([`${jointStrengthRequiredShards('nlh')[0].key}:discards_outside_pineapple`]);
    // One invalid shard keeps a winning matrix from qualifying.
    const one = summarizeJointStrength(v, [
      { ...matrix[0], illegalCandidates: 1 },
      ...matrix.slice(1),
    ]);
    expect(one.qualified).toBe(false);
    expect(one.reasons).toEqual([`${first.key}:illegalCandidates`]);
  });

  it('refuses an identical trace with a nonzero difference and an unbalanced shard', () => {
    const v: JointStrengthVariant = 'nlh';
    const s = fullMatrix(v)[0];
    const key = jointStrengthRequiredShards(v)[0].key;
    const replay = { ...s, strata: { ...s.strata, '0|none': sums([[s.strata['0|none'].n, 3]]) } };
    expect(jointStrengthShardReasons(v, replay)).toContain(`${key}:paired_replay_mismatch`);
    const unbalanced = { ...s, offsetCounts: [...s.offsetCounts.slice(1), s.offsetCounts[0] + 1] };
    expect(jointStrengthShardReasons(v, unbalanced)).toContain(
      `${key}:position_coverage_unbalanced`
    );
    const stray = { ...s, strata: { ...s.strata, '9|flop': sums([[1, 0]]) } };
    expect(jointStrengthShardReasons(v, stray)).toEqual(
      expect.arrayContaining([`${key}:unknown_stratum:9|flop`, `${key}:strata_pair_count_mismatch`])
    );
  });
});
