/**
 * P11.2 PLO5 / PLO6 / PLO8 STRENGTH QUALIFICATION CONTRACT (Horse Brain Phase 11)
 *
 * The one immutable, versioned statement of what a strength run of each Phase
 * 11 pack must measure and what it must show before that pack can be called
 * qualified. It is locked by the merge that introduces it: no held-out run may
 * precede that merge, and a run, an assembly or a verdict made against any
 * other contract (a different digest) is refused by name.
 *
 * Three packs, three separate qualifications. `packs.plo5`, `packs.plo6` and
 * `packs.plo8` each carry their own population, held-out seeds, matrix and
 * pilot. The verdict `summarizeOmahaVariantStrength(variant, shards)` reads one
 * pack's shards only and refuses any shard of another pack, so a pass for one
 * pack never certifies another.
 *
 * It mirrors the Phase 10 machinery (Plo4StrengthContract.ts) but reads none of
 * that contract's constants: every number below is this contract's own, and
 * the statistic and verdict functions are parametrized by this object. Two
 * Phase 10 limits are handled here instead of inherited (see
 * `gatingCells.streetFamilies` and `liveConditions`):
 *
 *  (a) the four street-family cells could not fail at the -10 bb/100 margin
 *      (14 of 18 Phase 10 cells were effective). Here street families are
 *      reported as diagnostics only; the 14 gating cells per pack are the five
 *      profiles, six positions and three depth bands, all effective;
 *  (b) the harness differed from live play in six ways. Mood is now on in
 *      both arms on a deterministic decision clock; every other difference is
 *      named with its handling, and P11.3 admission must also see natural
 *      completion-share evidence (`liveConditions.admissionAlsoRequires`).
 *
 * TOURNAMENT (prize and bounty): refused by name for every pack, exactly as
 * Phase 10 refused PLO4. Nothing here is a calibrated solver claim.
 */
import { createHash } from 'node:crypto';
import {
  OMAHA_VARIANT_DOMAIN,
  OMAHA_VARIANT_PACKS,
  type OmahaPolicyVariant,
} from '../engine/omaha/OmahaVariantPolicyPack.js';
import { positionForOffset, type Plo4Position } from '../engine/plo4/Plo4PolicyPack.js';
import { getFullRakeConfig, getPlayerCountCaps } from '../config/RakeConfig.js';
import { CASH_MAX_BB, CASH_MIN_BB } from '../config/cashBuyIn.js';
import { maxSeatsForVariant } from '../config/tableSeating.js';
// Pure functions and the style roster only. Plo4PowerAccumulator is exact
// integer arithmetic, and the seat-style function and roster describe the
// production horse population, which is the same for every Omaha variant. No
// PLO4 contract constant (seeds, thresholds, matrix, interval) is read.
import {
  PRODUCTION_HORSE_STYLES,
  Plo4PowerAccumulator,
  plo4StrengthSeatStyle,
  type Plo4PowerSums,
} from './Plo4StrengthContract.js';

type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;
function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

export const OMAHA_VARIANT_STRENGTH_VARIANTS: readonly OmahaPolicyVariant[] = Object.freeze([
  'plo5',
  'plo6',
  'plo8',
]);
export function isOmahaVariantStrengthVariant(value: unknown): value is OmahaPolicyVariant {
  return (OMAHA_VARIANT_STRENGTH_VARIANTS as readonly unknown[]).includes(value);
}

/** The league's chip unit: SB 1, BB 2, amounts in chip dollars with cents. */
export const OMAHA_VARIANT_STRENGTH_BB = 2;
const STAKE = { smallBlind: 1, bigBlind: OMAHA_VARIANT_STRENGTH_BB } as const;
/** Every profile is a six-max table (see `population.tableSeatsReason`). */
const TABLE_SEATS = 6;

/** The live decision clock replacement (liveConditions, mood): a deterministic
 * time of day derived from the deal seed, identical in both arms of a pair.
 * HorseLogic's v9 mood is moodOf(user_id, decisionTimeMs), keyed on the hour,
 * so this spreads every seat's mood over the 24 hours of a day. */
export function omahaVariantMoodClockMs(dealSeed: number): number {
  return (dealSeed % 86_400) * 1000;
}

export { PRODUCTION_HORSE_STYLES };
/** The same production style roster and per-seat draw as Phase 10: uniform
 * over the five production styles by deal seed and seat, hero included,
 * identical in the candidate and reference arms. */
export const omahaVariantStrengthSeatStyle = plo4StrengthSeatStyle;

export type OmahaVariantDepthBand = 'short' | 'standard' | 'deep';
export interface OmahaVariantStrengthProfile {
  id: string;
  variant: OmahaPolicyVariant;
  /** Dealt seats; every seat is occupied and dealt. */
  seats: number;
  /** The table's max_players, which gates the player-count cap ladder. */
  tableSeats: number;
  stackBB: number;
  depthBand: OmahaVariantDepthBand;
  /** Shards per held-out seed (each pairsPerShard pairs of this pack). */
  shards: number;
  /** Design pilot paired-difference standard deviation, BB per hand (dispersion
   * only; used to size `shards`). */
  pilotSdBB: number;
  /** Design pilot wall time per pair (candidate and reference hand), ms. */
  pilotMsPerPair: number;
  /** Design pilot kurtosis of the paired difference (m4 / m2^2). */
  pilotKurtosis: number;
}

/** Design pilot, per pack and profile: [paired-difference SD in BB per hand,
 * ms per pair, kurtosis]. Development seed 11101101 (OMAHA_VARIANT_LEAGUE_SEEDS[0]),
 * 576 pairs per profile, runOmahaVariantStrengthShard development mode, shard
 * 0, in this repository's Linux container (Intel Xeon at 2.10GHz, 2 vCPU,
 * shared with another agent's test run, one pilot process at a time). Never a
 * held-out seed and never a mean. Every validity counter was 0 and all 5,760
 * pilot hands of each pack (17,280 in all) were independently settled. The logs are
 * docs/evidence/phase11/pilot-<variant>.json. */
const PILOT: Record<OmahaPolicyVariant, Record<string, readonly [number, number, number]>> = {
  plo5: {
    '2dealt': [6.53, 11.6, 102],
    '4dealt': [13.27, 38, 39.2],
    '40bb': [9.79, 49.4, 14.2],
    '100bb': [16.99, 54.2, 27],
    '200bb': [21.73, 58, 52.3],
  },
  plo6: {
    '2dealt': [10.04, 14.2, 69.8],
    '4dealt': [12.56, 43.1, 34.3],
    '40bb': [9.82, 54.4, 31.6],
    '100bb': [16.62, 60.1, 70.5],
    '200bb': [22.62, 66, 85.4],
  },
  plo8: {
    '2dealt': [5.8, 10.7, 165.5],
    '4dealt': [8.98, 33.6, 71.7],
    '40bb': [7.02, 48.3, 28.8],
    '100bb': [11.08, 55.9, 58.6],
    '200bb': [14.08, 59.9, 120.4],
  },
};
/** Shards per held-out seed, per pack, in profile order (2-dealt, 4-dealt,
 * 40 BB, 100 BB, 200 BB): the smallest total shard count (then the least
 * runner time) for which every gating cell's planned 99% half-width is at most
 * 8.5 bb/100 at 1.2 times the pilot deviations, found by exhaustive search
 * over the per-profile counts (docs/evidence/phase11/p11-2-sizing.py.txt). */
const SHARDS: Record<OmahaPolicyVariant, readonly [number, number, number, number, number]> = {
  plo5: [2, 8, 16, 25, 30],
  plo6: [5, 7, 16, 24, 29],
  plo8: [2, 4, 9, 11, 12],
};
/** 576 is a multiple of every profile's seats squared (4, 16, 36), so each
 * shard of a whole number of 576-pair blocks visits every (hero seat, button)
 * pair the same number of times: exact, balanced position coverage per shard. */
const ROTATION_BLOCK = 576;
/** Rotation blocks per shard, per pack. The rule is the largest whole number
 * that keeps the slowest profile's shard under about 25 minutes on a
 * GitHub-hosted runner at 2.5 times the pilot time per pair (Phase 10's budget
 * rule): 17 for PLO5 (58.0 ms, about 23.7 minutes) and PLO8 (59.9 ms, about
 * 24.4 minutes). For PLO6 the rule gives 15 (66.0 ms), but at 15, 16 or 17
 * blocks the pack needs 291, 270 or 258 jobs, and a GitHub Actions matrix runs
 * at most 256 jobs per workflow run; 18 blocks is the smallest that fits (243
 * jobs, about 28.5 minutes per slowest shard, still far inside the 120-minute
 * job timeout). */
const SHARD_BLOCKS: Record<OmahaPolicyVariant, number> = { plo5: 17, plo6: 18, plo8: 17 };
/** GitHub Actions runs at most this many jobs from one matrix (one dispatch). */
export const OMAHA_VARIANT_MATRIX_JOB_CEILING = 256;

/** Held-out seeds. Never used by any test, development league, pilot or tuning
 * run. Disjoint from every seed in the repository (PLO4 development and
 * held-out, OMAHA_VARIANT_LEAGUE_SEEDS, the Phase 8, 12 and 13 league seeds),
 * from each other and across packs. runOmahaPolicyLeague and runPlo4StrengthShard
 * refuse them, and only runOmahaVariantStrengthShard in contract mode, for its
 * own pack, accepts them. */
const HOLDOUT: Record<OmahaPolicyVariant, readonly [number, number, number]> = {
  plo5: [11201117, 11202239, 11203351],
  plo6: [11211121, 11212243, 11213363],
  plo8: [11221127, 11222251, 11223373],
};
/** The Phase 11 development league seeds (OMAHA_VARIANT_LEAGUE_SEEDS). */
const DEVELOPMENT_SEEDS = [11101101, 11102203, 11103307];

/** Phi^-1(0.995): the two-sided 99% normal quantile. */
const Z99 = 2.5758293035489004;
/** Planning rule for every gating cell: 99% half-width at most this, at
 * PLANNING_SD_FACTOR times the pilot deviations (Phase 10's rule, unchanged). */
const PLANNED_HALF_WIDTH_MAX = 8.5;
const PLANNING_SD_FACTOR = 1.2;
const MINIMUM_PAIRS_PER_PROFILE_IN_CELL = 10_000;

const POSITIONS: Plo4Position[] = [
  'button',
  'small_blind',
  'big_blind',
  'cutoff',
  'middle',
  'early',
];
const DEPTH_BANDS: OmahaVariantDepthBand[] = ['short', 'standard', 'deep'];

function profilesFor(variant: OmahaPolicyVariant): OmahaVariantStrengthProfile[] {
  const pilot = PILOT[variant];
  const shards = SHARDS[variant];
  const p = (
    suffix: string,
    key: string,
    seats: number,
    stackBB: number,
    depthBand: OmahaVariantDepthBand,
    index: number
  ): OmahaVariantStrengthProfile => ({
    id: `p11c-${variant}-6max-${suffix}`,
    variant,
    seats,
    tableSeats: TABLE_SEATS,
    stackBB,
    depthBand,
    shards: shards[index],
    pilotSdBB: pilot[key][0],
    pilotMsPerPair: pilot[key][1],
    pilotKurtosis: pilot[key][2],
  });
  return [
    p('2dealt-100bb', '2dealt', 2, 100, 'standard', 0),
    p('4dealt-100bb', '4dealt', 4, 100, 'standard', 1),
    p('40bb', '40bb', 6, CASH_MIN_BB, 'short', 2),
    p('100bb', '100bb', 6, 100, 'standard', 3),
    p('200bb', '200bb', 6, CASH_MAX_BB, 'deep', 4),
  ];
}

/** Members, and pairs per member, of each gating cell for a profile set. */
function gatingCellPlan(profiles: readonly OmahaVariantStrengthProfile[], pairsPerShard: number) {
  const seeds = 3;
  const pairsOf = (p: OmahaVariantStrengthProfile) => p.shards * pairsPerShard * seeds;
  const cells: { cell: string; members: { p: OmahaVariantStrengthProfile; n: number }[] }[] = [];
  for (const p of profiles)
    cells.push({ cell: `profile:${p.id}`, members: [{ p, n: pairsOf(p) }] });
  for (const position of POSITIONS) {
    const members = profiles
      .map((p) => {
        const offsets = Array.from({ length: p.seats }, (_, o) => o).filter(
          (o) => positionForOffset(o, p.seats) === position
        ).length;
        return { p, n: (pairsOf(p) * offsets) / p.seats };
      })
      .filter((m) => m.n > 0);
    cells.push({ cell: `position:${position}`, members });
  }
  for (const band of DEPTH_BANDS)
    cells.push({
      cell: `depth:${band}`,
      members: profiles.filter((p) => p.depthBand === band).map((p) => ({ p, n: pairsOf(p) })),
    });
  return cells;
}
/** Planned 99% half-width (bb/100) of each gating cell at PLANNING_SD_FACTOR
 * times the pilot deviations, the smallest per-profile pair count in it, and
 * the largest relative standard error of a member's variance estimate at its
 * pilot kurtosis, sqrt((kurtosis - 1) / n) (the assumption behind
 * interval.minimumPairsPerProfileInCell is that this stays under 0.1). */
export function omahaVariantPlannedHalfWidths(
  profiles: readonly OmahaVariantStrengthProfile[],
  pairsPerShard: number
) {
  return Object.fromEntries(
    gatingCellPlan(profiles, pairsPerShard).map(({ cell, members }) => {
      const w = 1 / members.length;
      const variance = members.reduce(
        (s, m) => s + (w * w * (PLANNING_SD_FACTOR * m.p.pilotSdBB) ** 2) / m.n,
        0
      );
      // BB per hand to bb/100.
      const halfWidth = Z99 * Math.sqrt(variance) * 100;
      return [
        cell,
        {
          halfWidthBbPer100: Math.round(halfWidth * 100) / 100,
          minimumProfilePairs: Math.min(...members.map((m) => m.n)),
          varianceRelativeSeAtPilotKurtosis:
            Math.round(
              Math.max(...members.map((m) => Math.sqrt((m.p.pilotKurtosis - 1) / m.n))) * 1000
            ) / 1000,
        },
      ];
    })
  );
}

const tournamentRefusals = (variant: OmahaPolicyVariant) => [
  `tournament:${variant}_whole_tournament_outcome_model_unavailable`,
  `tournament:qualified_${variant}_tournament_reference_population_unavailable`,
  `tournament:${variant}_tournament_thresholds_not_specified`,
];

function packSection(variant: OmahaPolicyVariant) {
  const pack = OMAHA_VARIANT_PACKS[variant];
  const published = getFullRakeConfig(STAKE.smallBlind, STAKE.bigBlind, variant);
  const profiles = profilesFor(variant);
  const pairsPerShard = ROTATION_BLOCK * SHARD_BLOCKS[variant];
  const seeds = HOLDOUT[variant];
  return {
    variant,
    domain: `${variant}-cash-single-board-after-rake-horse-population`,
    candidate: {
      owner: `HorseLogic.decide with phase11Omaha "candidate" (OmahaVariantLivePolicy over ${pack.version})`,
      packVersion: pack.version,
      packSource: OMAHA_VARIANT_DOMAIN.source,
      calibratedConfidence: OMAHA_VARIANT_DOMAIN.calibratedConfidence,
      splitPot: pack.splitPot,
      holes: pack.holes,
    },
    reference: {
      owner: 'HorseLogic.decide with phase11Omaha "off"',
      claim:
        'the action live tables execute today (Phase 11 runs in shadow, so live play takes the off action), under the harness conditions in liveConditions; not an external solver',
    },
    population: {
      variant,
      stake: STAKE,
      rake: {
        source: `getFullRakeConfig(1, 2, "${variant}") and getPlayerCountCaps(cap, 6), server/src/config/RakeConfig.ts, as ServerTableEngineBase builds a cash hand`,
        percent: published.rakePercent,
        cap: published.rakeCap,
        noFlopNoDrop: true,
        playerCountCaps: { [TABLE_SEATS]: getPlayerCountCaps(published.rakeCap, TABLE_SEATS) },
      },
      bbj: {
        source: `getFullRakeConfig(1, 2, "${variant}").bbjEnabled, bbjFeeBB and rules (a variant the jackpot does not cover drops nothing)`,
        enabled: published.bbjEnabled,
        feeBB: published.bbjFeeBB,
        minPotBB: published.rules.minPotBB,
        minPlayersDealt: published.rules.minPlayersDealt,
      },
      buyInBandBB: [CASH_MIN_BB, CASH_MAX_BB],
      cashSeatCeiling: maxSeatsForVariant(variant),
      tableSeats: TABLE_SEATS,
      tableSeatsReason:
        'every production Omaha cash game is six-handed and locked: fn_cash_game_create enforces six seats for every new cash game (supabase/migrations/20260905034937_gate_7_every_cash_table_is_a_game.sql), and no seven- or eight-seat Omaha cash table has opened since 2026-09-08 (docs/horse-brain-phase9-completion-2026-10-03.md, G5: 0 of 493); the variant cash ceiling (PLO5 7, PLO6 6, PLO8 8) is a legal maximum no production table uses',
      styles: PRODUCTION_HORSE_STYLES,
      styleRule:
        'omahaVariantStrengthSeatStyle(dealSeed, seat) (the Phase 10 production-style draw): uniform over the five production styles for every seat, hero included, identical in both arms',
      opponents:
        'HorseLogic.decide seats at the evaluated source with the production style mix, every one with phase11Omaha off, under the harness conditions in liveConditions',
      humanPopulation:
        'unavailable dependency (qualified human reference and independent holdout are P14-D); the cash qualification is scoped to the Horse population',
      excludedFromQualifiedDomain: [
        'antes and straddles (no profile)',
        'tables above six seats (no production Omaha table since 2026-09-08), three or five dealt, and stakes other than the published 1/2 row',
        'depth outside the 40 to 200 BB cash buy-in band',
        'bomb pots, multi-board and run-it-twice (Phase 13 boundaries)',
        'every tournament format (refused in tournament)',
      ],
    },
    tournament: {
      id: 'tournament_prize_bounty',
      status: 'unavailable dependency',
      objectiveOwner: 'HorseTournamentUtility.evaluateTournamentUtilityDetailed (Phase 7)',
      requiredOutcomeModel:
        'paired whole tournaments to realized prize and bounty share of the funded pool (HorseTournamentLeague.realizedTournamentReturn), the Phase 8 contract shape',
      refusals: tournamentRefusals(variant),
      why: `HorseTournamentLeague deals NLH only; the ${variant} league tournament profile measures single-hand chip EV, which is not a prize objective; no source-qualified ${variant} tournament structure population exists; NLH tournament thresholds are not borrowed`,
    },
    holdout: {
      seeds,
      developmentSeeds: DEVELOPMENT_SEEDS,
      dealSeedRule:
        '(seed ^ Math.imul(pairIndex + 1, 2654435761)) >>> 0 || 1, as runOmahaPolicyLeague',
      seatingRule: 'plo4LeagueSeating(pairIndex, seats)',
    },
    matrix: {
      profiles,
      seeds,
      rotationBlock: ROTATION_BLOCK,
      pairsPerShard,
      pairsPerProfile: Object.fromEntries(
        profiles.map((p) => [p.id, p.shards * pairsPerShard * seeds.length])
      ),
      requiredShards: profiles.reduce((n, p) => n + p.shards, 0) * seeds.length,
      plannedGatingCells: omahaVariantPlannedHalfWidths(profiles, pairsPerShard),
      runner: `server/src/scripts/omahaVariantStrengthEvaluate.ts --variant=${variant} --output=<dir> --profile=<id> --seed=<s> --shard=<k> --contract`,
    },
  };
}

export const OMAHA_VARIANT_STRENGTH_CONTRACT = deepFreeze({
  schema: 'horse-phase11-strength-contract',
  version: 'omaha-variant-strength-contract-v1',
  phase: 'P11.2',
  locked:
    'by the merge of the pull request that introduced this file; the matrix of a pack is dispatched only against a commit on main that contains it, and no held-out hand is dealt before',
  independence:
    'each pack (plo5, plo6, plo8) is qualified on its own matrix, seeds and verdict; a pass for one pack never certifies another, and a shard of one pack is refused by name in another pack verdict',
  objectives: {
    cash: {
      id: 'cash_after_rake',
      status: 'measured',
      metric:
        'paired difference of the hero seat net chips per hand (final stack minus starting stack) after the engine rake and BBJ drop, candidate minus reference, reported in bb/100',
      excluded:
        'BBJ jackpot awards (paid by the database from the external pool after the hand, not in hand settlement)',
      verdict:
        'summarizeOmahaVariantStrength(variant, shards), server/src/benchmark/OmahaVariantStrengthContract.ts',
    },
    tournament:
      'refused by name per pack (packs.<variant>.tournament), never in the top-level verdict reasons',
  },
  packs: {
    plo5: packSection('plo5'),
    plo6: packSection('plo6'),
    plo8: packSection('plo8'),
  },
  matrixRules: {
    shardRule: 'shard k plays pair indices [k * pairsPerShard, (k + 1) * pairsPerShard)',
    designPilot:
      'per pack: development seed 11101101, 576 pairs per profile, runOmahaVariantStrengthShard development mode, shard 0; recorded paired-difference standard deviation and time per pair only (never a mean, never a held-out seed); logs docs/evidence/phase11/pilot-<variant>.json',
    sizingRule: `shards per profile chosen so every gating cell's planned 99% half-width is at most ${PLANNED_HALF_WIDTH_MAX} bb/100 at ${PLANNING_SD_FACTOR} times the pilot deviations, with at least ${MINIMUM_PAIRS_PER_PROFILE_IN_CELL} pairs per profile in every gating cell; pairsPerShard = 576 x k, k the largest whole number keeping the slowest profile under about 25 minutes per shard on a GitHub-hosted runner at 2.5 times the pilot time per pair`,
    jobCeiling: `a pack's requiredShards is at most ${OMAHA_VARIANT_MATRIX_JOB_CEILING}, the GitHub Actions limit on jobs from one matrix; it overrides the 25-minute budget where both cannot hold (PLO6, see the pack's pairsPerShard)`,
    kurtosisCheck:
      'every gating cell member has sqrt((pilot kurtosis - 1) / planned pairs) under 0.1 (matrix.plannedGatingCells), so the 10,000-pair floor assumption holds at the planned sizes even where the pilot kurtosis exceeds 100 (PLO8 2-dealt 165.5, 200 BB 120.4)',
    plannedHalfWidthMaxBbPer100: PLANNED_HALF_WIDTH_MAX,
    planningSdFactor: PLANNING_SD_FACTOR,
    hostedBudget: { minutesPerShard: 25, pilotTimeFactor: 2.5 },
  },
  statistic: {
    unit: 'chip cents per paired hand (exact integers); bb/100 = mean cents / (BB * 100) * 100',
    pairing:
      'one deal seed per pair: identical cards, hero seat, button, seat styles and decision clock in both arms; candidate arm then reference arm',
    strata:
      'profile x seed x dealer-relative hero offset x divergence street, exact integer power sums n, S1..S4',
    divergence:
      'street of the first action at which the two arms differ (none, preflop, flop, turn, river); identical action traces with a nonzero difference count as a paired replay mismatch',
    estimator:
      'stratified mean: equal weight per profile among the profiles in a cell, pairs pooled within a profile across seeds and shards',
  },
  interval: {
    method:
      'two-sided 99% normal (Wald) interval on the stratified mean: T +/- z * sqrt(sum w_p^2 s_p^2 / n_p), z = Phi^-1(0.995), s_p^2 the unbiased within-profile variance',
    z: Z99,
    // Validity of the normal approximation (Phase 10's guard, kept): the
    // first Edgeworth term of a one-sided bound's coverage error is
    // |k|(2z^2 + 1)phi(z)/6, k the skewness of the estimator itself. Capping it
    // at 0.001 keeps the one-sided 0.5% error rate below 0.6%. A cell that
    // fails it carries no claim (refused, never relaxed).
    edgeworthCoverageErrorMax: 0.001,
    // The variance estimate's relative standard error is about
    // sqrt((kurtosis - 1) / n): under 10% for kurtosis up to 100 at n = 10,000.
    // Fewer pairs in any profile of a gating cell and the interval is not
    // trusted. Every gating cell is planned well above this floor.
    minimumPairsPerProfileInCell: MINIMUM_PAIRS_PER_PROFILE_IN_CELL,
  },
  thresholds: {
    primary: {
      gate: "cash_after_rake 99% lower bound > 0 bb/100, the pack's five profiles pooled with equal weight",
      lowerBoundAboveBbPer100: 0,
      // Zero is break-even after the house's take: any positive value means the
      // horse keeps more money than the reference against the same population
      // at the published rake and BBJ drop. The lower end of a two-sided 99%
      // interval bounds a false promotion at 0.5%. No positive effect-size
      // floor is set because no calibrated cost of switching exists in source.
      // Phase 10's reasoning, which does not depend on the variant.
    },
    seedReplication: {
      gate: 'each held-out seed block of the pack: pooled stratified point estimate > 0 bb/100',
      pointEstimateAboveBbPer100: 0,
      // Three independent replication blocks fixed in advance. Requiring each
      // to point the same way keeps the improvement from resting on one block;
      // a zero true effect passes all three with probability 1/8 on top of the
      // primary bound. Phase 10's reasoning, unchanged.
    },
    nonregression: {
      gate: 'every gating cell 99% lower bound >= -10 bb/100',
      lowerBoundAtLeastBbPer100: -10,
      // 10 bb/100 is one 100 BB buy-in per 1,000 hands, about the size of a
      // whole winning edge in big-bet Omaha cash (PLO4, PLO5, PLO6 and PLO8
      // alike). A domain that may lose more than that against the reference
      // can turn a break-even reference into a clear loser there, whatever the
      // pooled result. The shard counts plan every gating cell's 99% half-width
      // at or below 8.5 bb/100 (1.2 times the pilot deviations), so a cell that
      // truly breaks even can show it. Each cell is tested at 99% with no
      // multiplicity relief: all must pass (intersection-union). Phase 10's
      // number and reasoning; no new number is introduced.
    },
  },
  gatingCells: {
    count: 14,
    profiles: 'the five profiles of the pack',
    positions: POSITIONS,
    positionRule:
      'positionForOffset(offset, seats), the pack position names; heads-up offset 0 is button',
    depthBands: DEPTH_BANDS,
    effective:
      'every gating cell holds only pairs of its own domain (no zero padding), so its estimate is the domain mean; its 99% lower bound sits below the true domain mean with probability 99.5%, so a true domain loss of 10 bb/100 or more fails the gate with at least that probability, and at the planned half-widths (at most 8.5 bb/100) a domain that truly breaks even can pass',
    streetFamilies: {
      gate: false,
      families: ['preflop', 'flop', 'turn', 'river'],
      reported:
        'diagnostic only: each family as its contribution to the pooled bb/100 (zero for pairs that diverged elsewhere), with the share of pairs diverging there; the four contributions and the no-divergence pairs sum exactly to the primary estimate',
      whyNotAGate:
        'a contribution cell is diluted by every pair that did not diverge on its street, so a breach of -10 bb/100 needs a conditional loss of hundreds of bb/100 and the cell cannot fail in practice (Phase 10: its four street cells spanned about +/-2.3 bb/100); a conditional cell (pairs diverging on that street only) has the right scale, but late-street divergences are a small and run-dependent share of pairs, so its pair count and skewness are not fixed before the run and its interval cannot be planned to resolve the margin at feasible sample sizes',
    },
  },
  liveConditions: {
    rule: 'each difference between this harness and a live cash table, with its handling: "addressed" means the harness now matches live play; "named limit" means it does not, and a qualification carries the limit',
    differences: [
      {
        id: 'mood',
        live: 'v9 mood on by default (HorseLogic.ts, (opts.v9Mood ?? opts.v9) !== false; the worker never sets it): moodOf(user_id, decisionTimeMs) shifts bluff frequency and aggression by the hour',
        harness:
          'v9 mood on in both arms; decisionTimeMs = omahaVariantMoodClockMs(dealSeed) = (dealSeed % 86400) * 1000, fixed by the deal seed and identical in both arms, so each seat mood is spread over the 24 hours of a day',
        handling: 'addressed',
      },
      {
        id: 'style_modifiers',
        live: 'resolveHorseStyle(player.horse_profile, ...).mods (ServerTableEngineTurns.ts), which carries the self-tuned multipliers',
        harness: 'empty style modifiers {}',
        handling:
          'named limit: the production self-tuned multipliers are per-horse database state that changes over time and is not available offline; no fixed snapshot is source-qualified',
      },
      {
        id: 'horsemind_history',
        live: 'opponent reads from accumulated HorseMind statistics',
        harness: 'a fresh HorseMind.createSandbox() per hand: no opponent history',
        handling:
          'named limit: the Phase 11 variant sampler (OmahaVariantSampler) conditions on the public action line only and reads no HorseMind statistic; but the reference path is HorseLogic, which does read HorseMind, and the candidate also takes from it the decision equity ceiling (phase11DecisionEquityCeiling, set when HorseLogic structural caps lower its own estimate) and falls back to the reference action wherever it does not fire, so both arms play without the opponent history they have live',
      },
      {
        id: 'policy_clock',
        live: 'the real clock: OmahaVariantLivePolicy falls back to the reference action (reason work_budget) beyond OMAHA_VARIANT_DOMAIN.liveBudgetMs (4 ms), and the sampler stops at 3 ms, which can truncate river sampling',
        harness:
          'phase11EvidenceMode: a fixed policy clock, so the fallback never fires and sampling completes its fixed work',
        handling:
          'named limit; P11.3 admission must also require natural completion-share evidence (admissionAlsoRequires)',
      },
      {
        id: 'second_look',
        live: 'the decision worker may take a deep second look at a decision',
        harness: 'HorseLogic.decide is called directly, once per decision',
        handling:
          'named limit: the second look is worker scheduling over live read frames, not reproducible offline',
      },
      {
        id: 'field',
        live: 'under activation every cash horse seat of the variant switches to candidate together',
        harness: 'one candidate seat against a reference field (every other seat phase11Omaha off)',
        handling:
          'design: the only design that measures strength against the horse population as it plays today; an all-candidate field measures self-play, which has no reference to beat',
      },
    ],
    admissionAlsoRequires: [
      'natural completion-share evidence for the pack: on the release under admission, the share of eligible live candidate-path decisions that complete without the work_budget fallback, per street, measured from natural decisions with the release unchanged throughout the window; P11.3 must state and meet its own floor for that share before admitting the pack, because this contract measures strength only for decisions that complete',
    ],
  },
  softwareValidity: {
    perShard: {
      complete: 'pairs completed equals pairsPerShard',
      positionCoverage: 'every dealer-relative offset visited equally',
      illegalActions: 0,
      conservationErrors: 0,
      cardErrors: 0,
      truncatedHands: 0,
      settlementMismatches: 0,
      deductionMismatches: 0,
      pairedReplayMismatches: 0,
      fixedWork:
        'EQUITY_GOVERNOR off, scale 1, fixed-work policy clock, mood clock from the deal seed',
    },
    settlementReference:
      'settleOmahaReference (OmahaReference.ts, Phase 9) for the pack variant (plo8 settles high and low halves): no seat receives more than its independent gross award, losers receive nothing, and the shortfall equals rake plus BBJ drop',
    deductionReference:
      'effectiveRake and effectiveBbjDrop (config/rakeSpec.ts, the arithmetic the database implements) for the pack variant on the contested pot',
  },
  notStrengthGates: ['atlas coordinate count', 'changed proposal count', 'eligible decision count'],
  promotionEligible: false,
});

export type OmahaVariantStrengthContract = typeof OMAHA_VARIANT_STRENGTH_CONTRACT;
type PackSection = OmahaVariantStrengthContract['packs'][OmahaPolicyVariant];

/** sha256 of the contract's JSON. Runs, assemblies and qualification files bind it. */
export function omahaVariantStrengthContractDigest(): string {
  return createHash('sha256').update(JSON.stringify(OMAHA_VARIANT_STRENGTH_CONTRACT)).digest('hex');
}
export function omahaVariantStrengthPack(variant: OmahaPolicyVariant): PackSection {
  if (!isOmahaVariantStrengthVariant(variant)) throw new Error('Unknown Phase 11 strength variant');
  return OMAHA_VARIANT_STRENGTH_CONTRACT.packs[variant];
}
export function omahaVariantStrengthDomain(variant: OmahaPolicyVariant): string {
  return omahaVariantStrengthPack(variant).domain;
}
export function omahaVariantStrengthProfile(
  variant: OmahaPolicyVariant,
  id: string
): Readonly<OmahaVariantStrengthProfile> | undefined {
  if (!isOmahaVariantStrengthVariant(variant)) return undefined;
  return omahaVariantStrengthPack(variant).matrix.profiles.find((p) => p.id === id);
}
/** True for a held-out seed of the named pack. */
export function isOmahaVariantHoldoutSeedOf(variant: OmahaPolicyVariant, seed: number): boolean {
  return (
    isOmahaVariantStrengthVariant(variant) &&
    (omahaVariantStrengthPack(variant).holdout.seeds as readonly number[]).includes(seed)
  );
}
/** True for a held-out seed of any Phase 11 pack. */
export function isOmahaVariantHoldoutSeed(seed: number): boolean {
  return OMAHA_VARIANT_STRENGTH_VARIANTS.some((v) => isOmahaVariantHoldoutSeedOf(v, seed));
}
export function omahaVariantStrengthShardKey(profileId: string, seed: number, shard: number) {
  return `${profileId}-${seed}-s${shard}`;
}
/** Every (profile, seed, shard) one pack's matrix requires, in a fixed order. */
export function omahaVariantStrengthRequiredShards(variant: OmahaPolicyVariant) {
  const pack = omahaVariantStrengthPack(variant);
  const out: { key: string; variant: string; profileId: string; seed: number; shard: number }[] =
    [];
  for (const p of pack.matrix.profiles)
    for (const seed of pack.matrix.seeds)
      for (let shard = 0; shard < p.shards; shard++)
        out.push({
          key: omahaVariantStrengthShardKey(p.id, seed, shard),
          variant,
          profileId: p.id,
          seed,
          shard,
        });
  return out;
}

export const OMAHA_VARIANT_DIVERGENCE_STREETS = [
  'none',
  'preflop',
  'flop',
  'turn',
  'river',
] as const;
export type OmahaVariantDivergenceStreet = (typeof OMAHA_VARIANT_DIVERGENCE_STREETS)[number];

export interface OmahaVariantStrengthShardResult {
  schema: 'horse-phase11-strength-shard-v1';
  variant: OmahaPolicyVariant;
  contractVersion: string;
  contractDigest: string;
  packVersion: string;
  evidenceMode: 'contract' | 'development';
  profileId: string;
  seed: number;
  shard: number;
  firstPair: number;
  requestedPairs: number;
  pairs: number;
  complete: boolean;
  positionCoverageComplete: boolean;
  offsetCounts: number[];
  /** key `${offset}|${street}` */
  strata: Record<string, Plo4PowerSums>;
  pairDigest: string;
  candidateNetCents: number;
  referenceNetCents: number;
  changedPairs: number;
  decisions: number;
  eligible: number;
  changed: number;
  illegalActions: number;
  conservationErrors: number;
  cardErrors: number;
  truncatedHands: number;
  settlementMismatches: number;
  deductionMismatches: number;
  pairedReplayMismatches: number;
  showdownsChecked: number;
  foldWinsChecked: number;
  /** Showdowns at which the reference awarded a low half (plo8 only). */
  lowHalvesChecked: number;
  totalRake: number;
  totalBbj: number;
  nodeCounts: Record<string, number>;
  reasons: Record<string, number>;
  equityWork: Record<string, number>;
  fixedWork: {
    governor: 'off';
    scale: 1;
    policyClock: string;
    moodClock: 'deal_seed_time_of_day';
  };
  durationMs: number;
  promotionEligible: false;
}

/** One profile's contribution to a cell: its weight and the selected pairs' sums
 * (n counts every pair in the profile sample; s1..s3 only the selected ones,
 * so unselected pairs enter as zeros where a contribution is measured). */
export interface OmahaVariantCellGroup {
  profileId: string;
  weight: number;
  n: number;
  s1: bigint;
  s2: bigint;
  s3: bigint;
}
export interface OmahaVariantCellStatistic {
  cell: string;
  profiles: string[];
  pairs: number;
  minimumProfilePairs: number;
  meanBbPer100: number;
  standardErrorBbPer100: number;
  confidence99BbPer100: [number, number];
  estimatorSkewness: number;
  edgeworthCoverageError: number;
  intervalTrusted: boolean;
}
const CENTS_PER_BB = OMAHA_VARIANT_STRENGTH_BB * 100;
const toBbPer100 = (cents: number) => (cents / CENTS_PER_BB) * 100;
const phi = (z: number) => Math.exp(-(z * z) / 2) / Math.sqrt(2 * Math.PI);

/** The stratified mean, its exact-sum standard error, the two-sided 99%
 * interval and the interval-validity guards, all from this contract. */
export function omahaVariantCellStatistic(
  cell: string,
  groups: OmahaVariantCellGroup[]
): OmahaVariantCellStatistic {
  const c = OMAHA_VARIANT_STRENGTH_CONTRACT.interval;
  let mean = 0,
    variance = 0,
    third = 0;
  for (const g of groups) {
    const n = BigInt(g.n);
    if (g.n < 2) {
      variance = Infinity;
      continue;
    }
    mean += g.weight * (Number(g.s1) / g.n);
    // Exact numerators, converted once: n(n-1)s^2 = n S2 - S1^2 and
    // n^3 mu3 = n^2 S3 - 3 n S1 S2 + 2 S1^3 (biased central third moment).
    const s2 = Number(n * g.s2 - g.s1 * g.s1) / (g.n * (g.n - 1));
    const mu3 = Number(n * n * g.s3 - 3n * n * g.s1 * g.s2 + 2n * g.s1 * g.s1 * g.s1) / g.n ** 3;
    variance += (g.weight ** 2 * s2) / g.n;
    third += (g.weight ** 3 * mu3) / g.n ** 2;
  }
  const se = Math.sqrt(variance);
  const skew = variance > 0 && Number.isFinite(variance) ? third / variance ** 1.5 : 0;
  const coverage = (Math.abs(skew) * (2 * c.z * c.z + 1) * phi(c.z)) / 6;
  const minimum = groups.length ? Math.min(...groups.map((g) => g.n)) : 0;
  const lo = mean - c.z * se,
    hi = mean + c.z * se;
  return {
    cell,
    profiles: groups.map((g) => g.profileId),
    pairs: groups.reduce((s, g) => s + g.n, 0),
    minimumProfilePairs: minimum,
    meanBbPer100: toBbPer100(mean),
    standardErrorBbPer100: toBbPer100(se),
    confidence99BbPer100: [toBbPer100(lo), toBbPer100(hi)],
    estimatorSkewness: skew,
    edgeworthCoverageError: coverage,
    intervalTrusted:
      groups.length > 0 &&
      Number.isFinite(se) &&
      minimum >= c.minimumPairsPerProfileInCell &&
      coverage <= c.edgeworthCoverageErrorMax,
  };
}

/** Reasons a shard cannot enter the named pack's verdict. Empty means it can. */
export function omahaVariantStrengthShardReasons(
  variant: OmahaPolicyVariant,
  r: OmahaVariantStrengthShardResult
): string[] {
  const c = OMAHA_VARIANT_STRENGTH_CONTRACT;
  const pack = omahaVariantStrengthPack(variant);
  const key = omahaVariantStrengthShardKey(r.profileId, r.seed, r.shard);
  const out: string[] = [];
  const profile = omahaVariantStrengthProfile(variant, r.profileId);
  if (r.schema !== 'horse-phase11-strength-shard-v1') out.push(`${key}:schema_mismatch`);
  if (r.variant !== variant) out.push(`${key}:variant_mismatch`);
  if (r.contractVersion !== c.version) out.push(`${key}:contract_version_mismatch`);
  if (r.contractDigest !== omahaVariantStrengthContractDigest())
    out.push(`${key}:contract_digest_mismatch`);
  if (r.packVersion !== pack.candidate.packVersion) out.push(`${key}:pack_version_mismatch`);
  if (r.evidenceMode !== 'contract') out.push(`${key}:not_contract_mode`);
  if (!profile) out.push(`${key}:unknown_profile`);
  if (!isOmahaVariantHoldoutSeedOf(variant, r.seed)) out.push(`${key}:not_holdout_seed`);
  if (!Number.isInteger(r.shard) || r.shard < 0 || !profile || r.shard >= profile.shards)
    out.push(`${key}:shard_outside_matrix`);
  if (r.firstPair !== r.shard * pack.matrix.pairsPerShard) out.push(`${key}:first_pair_mismatch`);
  if (r.requestedPairs !== pack.matrix.pairsPerShard) out.push(`${key}:pairs_below_contract`);
  if (!r.complete || r.pairs !== r.requestedPairs) out.push(`${key}:incomplete`);
  if (!r.positionCoverageComplete) out.push(`${key}:position_coverage_incomplete`);
  if (profile && r.offsetCounts.length !== profile.seats) out.push(`${key}:offset_count_mismatch`);
  if (new Set(r.offsetCounts).size > 1) out.push(`${key}:position_coverage_unbalanced`);
  const strataPairs = Object.values(r.strata).reduce((s, v) => s + v.n, 0);
  if (strataPairs !== r.pairs) out.push(`${key}:strata_pair_count_mismatch`);
  for (const k of Object.keys(r.strata)) {
    const [offset, street] = k.split('|');
    if (
      !profile ||
      !/^\d+$/.test(offset) ||
      Number(offset) >= profile.seats ||
      !(OMAHA_VARIANT_DIVERGENCE_STREETS as readonly string[]).includes(street)
    )
      out.push(`${key}:unknown_stratum:${k}`);
  }
  const none = Object.entries(r.strata).filter(([k]) => k.endsWith('|none'));
  if (none.some(([, v]) => v.s1 !== '0' || v.s2 !== '0')) out.push(`${key}:paired_replay_mismatch`);
  for (const field of [
    'illegalActions',
    'conservationErrors',
    'cardErrors',
    'truncatedHands',
    'settlementMismatches',
    'deductionMismatches',
    'pairedReplayMismatches',
  ] as const)
    if (r[field] !== 0) out.push(`${key}:${field}`);
  if (
    r.fixedWork?.governor !== 'off' ||
    r.fixedWork?.scale !== 1 ||
    r.fixedWork?.moodClock !== 'deal_seed_time_of_day'
  )
    out.push(`${key}:fixed_work_not_proven`);
  if (r.promotionEligible !== false) out.push(`${key}:shard_claims_promotion`);
  return out;
}

export interface OmahaVariantStreetDiagnostic extends OmahaVariantCellStatistic {
  gate: false;
  divergingPairs: number;
}
export interface OmahaVariantStrengthVerdict {
  variant: OmahaPolicyVariant;
  packVersion: string;
  domain: string;
  contractVersion: string;
  contractDigest: string;
  qualified: boolean;
  /** Cash failures only; they alone decide `qualified`. */
  reasons: string[];
  cash: {
    qualified: boolean;
    primary: OmahaVariantCellStatistic | null;
    seeds: OmahaVariantCellStatistic[];
    profiles: OmahaVariantCellStatistic[];
    positions: OmahaVariantCellStatistic[];
    depthBands: OmahaVariantCellStatistic[];
    gatingCells: number;
  };
  streetFamiliesDiagnostic: {
    gate: false;
    families: OmahaVariantStreetDiagnostic[];
    noDivergenceContributionBbPer100: number | null;
  };
  tournament: { status: string; qualified: false; reasons: readonly string[] };
  shardsUsed: number;
  promotionEligible: false;
}

/** One pack's whole-matrix verdict. Every required shard of that pack must be
 * present exactly once and valid; every gate is evaluated and every failure is
 * named. A shard of another pack is refused by name and never enters a cell. */
export function summarizeOmahaVariantStrength(
  variant: OmahaPolicyVariant,
  shards: OmahaVariantStrengthShardResult[]
): OmahaVariantStrengthVerdict {
  const c = OMAHA_VARIANT_STRENGTH_CONTRACT;
  const pack = omahaVariantStrengthPack(variant);
  const reasons: string[] = [];
  const seen = new Map<string, number>();
  const required = omahaVariantStrengthRequiredShards(variant);
  const requiredKeys = new Set(required.map((r) => r.key));
  const own: OmahaVariantStrengthShardResult[] = [];
  for (const s of shards) {
    const key = omahaVariantStrengthShardKey(s.profileId, s.seed, s.shard);
    seen.set(key, (seen.get(key) ?? 0) + 1);
    reasons.push(...omahaVariantStrengthShardReasons(variant, s));
    if (requiredKeys.has(key) && s.variant === variant) own.push(s);
  }
  for (const r of required) {
    const count = seen.get(r.key) ?? 0;
    if (count === 0) reasons.push(`${r.key}:missing_shard`);
    if (count > 1) reasons.push(`${r.key}:duplicate_shard`);
  }
  for (const key of seen.keys())
    if (!requiredKeys.has(key)) reasons.push(`${key}:unexpected_shard`);

  // Merge exact sums per profile x seed x offset x street, this pack only.
  const sums = new Map<string, Plo4PowerAccumulator>();
  for (const s of own)
    for (const [k, v] of Object.entries(s.strata)) {
      const key = `${s.profileId}|${s.seed}|${k}`;
      const acc = sums.get(key) ?? new Plo4PowerAccumulator();
      acc.merge(v);
      sums.set(key, acc);
    }
  const profiles = pack.matrix.profiles;
  type P = Readonly<OmahaVariantStrengthProfile>;
  type Pick = (p: P, seed: number, offset: number, street: string) => boolean;
  const group = (p: P, weight: number, inSample: Pick, selected: Pick) => {
    const g: OmahaVariantCellGroup & { selectedPairs: number } = {
      profileId: p.id,
      weight,
      n: 0,
      s1: 0n,
      s2: 0n,
      s3: 0n,
      selectedPairs: 0,
    };
    for (const [key, acc] of sums) {
      const [pid, seed, offset, street] = key.split('|');
      if (pid !== p.id || !inSample(p, Number(seed), Number(offset), street)) continue;
      g.n += acc.n;
      if (!selected(p, Number(seed), Number(offset), street)) continue;
      g.selectedPairs += acc.n;
      g.s1 += acc.s1;
      g.s2 += acc.s2;
      g.s3 += acc.s3;
    }
    return g;
  };
  const all: Pick = () => true;
  const equal = (cell: string, members: readonly P[], inSample: Pick, selected: Pick = inSample) =>
    omahaVariantCellStatistic(
      cell,
      members.map((p) => group(p, 1 / members.length, inSample, selected))
    );

  const primary = sums.size ? equal('primary', profiles, all) : null;
  const seeds = pack.matrix.seeds.map((seed) =>
    equal(`seed:${seed}`, profiles, (_p, s) => s === seed)
  );
  const profileCells = profiles.map((p) => equal(`profile:${p.id}`, [p], all));
  const positions = c.gatingCells.positions.map((position) => {
    const members = profiles.filter((p) =>
      Array.from({ length: p.seats }, (_, o) => positionForOffset(o, p.seats)).includes(position)
    );
    return equal(
      `position:${position}`,
      members,
      (p, _s, offset) => positionForOffset(offset, p.seats) === position
    );
  });
  const depthBands = c.gatingCells.depthBands.map((band) =>
    equal(
      `depth:${band}`,
      profiles.filter((p) => p.depthBand === band),
      all
    )
  );
  const families = c.gatingCells.streetFamilies.families.map((street) => {
    const onStreet: Pick = (_p, _s, _o, st) => st === street;
    const stat = equal(`street:${street}`, profiles, all, onStreet);
    const divergingPairs = profiles
      .map((p) => group(p, 1, all, onStreet).selectedPairs)
      .reduce((s, n) => s + n, 0);
    return { ...stat, gate: false as const, divergingPairs };
  });
  const noDivergence = sums.size
    ? equal('street:none', profiles, all, (_p, _s, _o, st) => st === 'none').meanBbPer100
    : null;

  const t = c.thresholds;
  if (!primary) reasons.push('cash:no_shard_results');
  else {
    if (!primary.intervalTrusted) reasons.push('cash:primary:interval_not_trusted');
    if (!(primary.confidence99BbPer100[0] > t.primary.lowerBoundAboveBbPer100))
      reasons.push('cash:primary:lower_bound_not_above_zero');
  }
  for (const s of seeds)
    if (!(s.meanBbPer100 > t.seedReplication.pointEstimateAboveBbPer100))
      reasons.push(`cash:${s.cell}:point_estimate_not_above_zero`);
  // The 14 gating cells. Street families are diagnostics and never enter here.
  const gating = [...profileCells, ...positions, ...depthBands];
  for (const cell of gating) {
    if (!cell.intervalTrusted) reasons.push(`cash:${cell.cell}:interval_not_trusted`);
    if (!(cell.confidence99BbPer100[0] >= t.nonregression.lowerBoundAtLeastBbPer100))
      reasons.push(`cash:${cell.cell}:regression_margin_exceeded`);
  }
  const cashQualified = reasons.length === 0;
  return {
    variant,
    packVersion: pack.candidate.packVersion,
    domain: pack.domain,
    contractVersion: c.version,
    contractDigest: omahaVariantStrengthContractDigest(),
    // The cash qualification of this pack is the only one this verdict can
    // grant; the tournament objective stays an unavailable dependency.
    qualified: cashQualified,
    reasons,
    cash: {
      qualified: cashQualified,
      primary,
      seeds,
      profiles: profileCells,
      positions,
      depthBands,
      gatingCells: gating.length,
    },
    streetFamiliesDiagnostic: {
      gate: false,
      families,
      noDivergenceContributionBbPer100: noDivergence,
    },
    tournament: {
      status: pack.tournament.status,
      qualified: false,
      reasons: pack.tournament.refusals,
    },
    shardsUsed: own.length,
    promotionEligible: false,
  };
}
