/**
 * P10.2 PLO4 STRENGTH QUALIFICATION CONTRACT (Horse Brain Phase 10)
 *
 * The one immutable, versioned statement of what a PLO4 strength run must
 * measure and what it must show before the PLO4 pack can be called qualified.
 * It is locked by the merge that introduces it: no matrix run may precede that
 * merge, and a run, an assembly or a verdict made against any other contract
 * (a different digest) is refused by name.
 *
 * What this file decides and what it does not:
 *
 *  - CASH (after rake): the paired whole-hand league in Plo4PolicyLeague.ts,
 *    candidate (phase10Plo4 'candidate') against the deployed reference
 *    (phase10Plo4 'off') on identical cards, seats, button and opponents, at
 *    the engine's own published PLO4 1/2 rake, player-count cap ladder and BBJ
 *    drop. The verdict is `summarizePlo4Strength` over every shard.
 *  - TOURNAMENT (prize and bounty): REFUSED BY NAME. The only coherent
 *    future/outcome model in source for a tournament objective is the Phase 8
 *    paired whole-tournament league (HorseTournamentLeague.ts,
 *    realizedTournamentReturn over the funded pool), and it deals NLH only.
 *    The Phase 7 owner (HorseTournamentUtility) prices single decisions; the
 *    existing PLO4 tournament profile measures single-hand chip EV, which is
 *    not a prize objective. No PLO4 tournament threshold is set here, and NLH
 *    tournament thresholds are not borrowed.
 *  - Nothing here is a calibrated solver claim. The reference is the deployed
 *    Horse policy, not an external solver, and the opponents are the
 *    production Horse population at the same source.
 *
 * Every number below that is not already in PLO4 source carries its reason.
 */
import { createHash } from 'node:crypto';
import {
  PLO4_POLICY_PACK,
  positionForOffset,
  type Plo4Position,
} from '../engine/plo4/Plo4PolicyPack.js';
import { getFullRakeConfig, getPlayerCountCaps } from '../config/RakeConfig.js';
import { CASH_MAX_BB, CASH_MIN_BB } from '../config/cashBuyIn.js';
import { maxSeatsForVariant } from '../config/tableSeating.js';
import type { HorseStyle } from '../types.js';

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

/** The league's chip unit: SB 1, BB 2, amounts in chip dollars with cents. */
export const PLO4_STRENGTH_BB = 2;
const STAKE = { smallBlind: 1, bigBlind: PLO4_STRENGTH_BB } as const;
/** The engine's own rake/BBJ lookup for the published PLO4 1/2 game, read
 * through the same function ServerTableEngineBase.getRakeConfig uses. */
const PUBLISHED = getFullRakeConfig(STAKE.smallBlind, STAKE.bigBlind, 'plo4');

/** HorseLogic.ts (style fallback) and HorseOnboarding.ts (brainFor) assign a
 * production horse one of these five styles, uniformly by id hash. */
export const PRODUCTION_HORSE_STYLES: readonly HorseStyle[] = Object.freeze([
  'tag',
  'lag',
  'balanced',
  'tricky',
  'grinder',
]);
/** Seat style for one paired deal: uniform over the five production styles,
 * fixed by the deal seed and seat, identical in the candidate and reference
 * arms. The hero seat is drawn the same way: the candidate is a production
 * horse with the PLO4 pack on, the reference the same horse with it off. */
export function plo4StrengthSeatStyle(dealSeed: number, seat: number): HorseStyle {
  const h = (Math.imul((dealSeed ^ 0x9e3779b9) >>> 0, 2654435761) ^ Math.imul(seat, 40503)) >>> 0;
  return PRODUCTION_HORSE_STYLES[h % PRODUCTION_HORSE_STYLES.length];
}

export type Plo4DepthBand = 'short' | 'standard' | 'deep';
export interface Plo4StrengthProfile {
  id: string;
  /** Dealt seats; every seat is occupied and dealt. */
  seats: number;
  /** The table's max_players, which gates the player-count cap ladder. */
  tableSeats: number;
  stackBB: number;
  depthBand: Plo4DepthBand;
  /** Shards per held-out seed (each pairsPerShard pairs). Sized so every
   * nonregression cell can resolve the margin; see thresholds.nonregression. */
  shards: number;
  /** Paired-difference standard deviation (BB per hand) measured by the
   * development-seed design pilot; recorded, used only to size `shards`. */
  pilotSdBB: number;
}

/** Design pilot paired-difference standard deviations, BB per hand. */
const [SD_2DEALT, SD_4DEALT, SD_40, SD_100, SD_200] = [7.61, 16.07, 9.2, 13.49, 21.38];
/** Shards per held-out seed: 37 per seed, 111 in all. */
const [SHARDS_2DEALT, SHARDS_4DEALT, SHARDS_40, SHARDS_100, SHARDS_200] = [2, 8, 4, 8, 15];
/** Five six-max tables. Every production Omaha cash table is six-max and
 * locked (no seven- or eight-seat Omaha table has opened since 2026-09-08,
 * docs/horse-brain-phase9-completion-2026-10-03.md, G5), so every profile is a
 * six-max table: full at the 100 BB standard buy-in and at the cash buy-in band
 * endpoints (CASH_MIN_BB and CASH_MAX_BB, config/cashBuyIn.ts), and short-handed
 * with two and four dealt at 100 BB, where the player-count rake ladder and
 * the BBJ dealt floor change the price.
 *
 * Shard counts: the design pilot (development seed 10101101, 576 pairs per
 * profile, dispersion and timing only, never a held-out seed and never a
 * mean) measured the paired-difference standard deviations above. Shards are
 * sized so every nonregression cell's planned 99% half-width is at most
 * 8.5 bb/100 at 1.2 times those deviations (largest: middle and early
 * position, 8.3; profiles 5.4 to 6.7; primary 2.7), inside the 10 bb/100
 * nonregression margin. */
const PROFILES: Plo4StrengthProfile[] = [
  {
    id: 'p10c-6max-2dealt-100bb',
    seats: 2,
    tableSeats: 6,
    stackBB: 100,
    depthBand: 'standard',
    shards: SHARDS_2DEALT,
    pilotSdBB: SD_2DEALT,
  },
  {
    id: 'p10c-6max-4dealt-100bb',
    seats: 4,
    tableSeats: 6,
    stackBB: 100,
    depthBand: 'standard',
    shards: SHARDS_4DEALT,
    pilotSdBB: SD_4DEALT,
  },
  {
    id: 'p10c-6max-40bb',
    seats: 6,
    tableSeats: 6,
    stackBB: CASH_MIN_BB,
    depthBand: 'short',
    shards: SHARDS_40,
    pilotSdBB: SD_40,
  },
  {
    id: 'p10c-6max-100bb',
    seats: 6,
    tableSeats: 6,
    stackBB: 100,
    depthBand: 'standard',
    shards: SHARDS_100,
    pilotSdBB: SD_100,
  },
  {
    id: 'p10c-6max-200bb',
    seats: 6,
    tableSeats: 6,
    stackBB: CASH_MAX_BB,
    depthBand: 'deep',
    shards: SHARDS_200,
    pilotSdBB: SD_200,
  },
];

/** Held-out seeds. Never used by any test, development league or tuning run;
 * runPlo4PolicyLeague refuses them, and only the contract shard runner in
 * contract mode accepts them. Disjoint from the development PLO4 seeds
 * (PLO4_LEAGUE_SEEDS 10101101/10102203/10103307) and every other league seed. */
const HOLDOUT_SEEDS = [10201109, 10202231, 10203347];
const DEVELOPMENT_SEEDS = [10101101, 10102203, 10103307];

/** 576 is a multiple of every profile's seats² (4, 16, 36), so each shard of
 * a whole number of 576-pair blocks visits every (hero seat, button) pair the
 * same number of times: exact, balanced position coverage per shard. */
const ROTATION_BLOCK = 576;
/** 23,040 pairs per shard: about 8 to 24 minutes on a GitHub-hosted runner
 * (design pilot: 8.8 to 24.5 ms per pair on the development Mac, budgeted at
 * 2.5x), far inside the job timeout, so a lost runner costs one short shard. */
const SHARD_PAIRS = ROTATION_BLOCK * 40;

/** Φ⁻¹(0.995): the two-sided 99% normal quantile. */
const Z99 = 2.5758293035489004;

export const PLO4_STRENGTH_CONTRACT = deepFreeze({
  schema: 'horse-phase10-strength-contract',
  version: 'plo4-strength-contract-v1',
  phase: 'P10.2',
  locked:
    'by the merge of the pull request that introduced this file; the matrix is dispatched only against a commit on main that contains it',
  candidate: {
    owner: 'HorseLogic.decide with phase10Plo4 "candidate" (Plo4LivePolicy over the pack)',
    packVersion: PLO4_POLICY_PACK.version,
    packSource: PLO4_POLICY_PACK.source,
    calibratedConfidence: PLO4_POLICY_PACK.calibratedConfidence,
  },
  reference: {
    owner: 'HorseLogic.decide with phase10Plo4 "off" (the deployed reference proposal)',
    claim: 'the deployed Horse reference policy, not an external solver',
  },
  objectives: {
    cash: {
      id: 'cash_after_rake',
      status: 'measured',
      metric:
        'paired difference of the hero seat net chips per hand (final stack minus starting stack) after the engine rake and BBJ drop, candidate minus reference, reported in bb/100',
      excluded:
        'BBJ jackpot awards (paid by the database from the external pool after the hand, not in hand settlement)',
      verdict: 'summarizePlo4Strength, server/src/benchmark/Plo4StrengthContract.ts',
    },
    tournament: {
      id: 'tournament_prize_bounty',
      status: 'unavailable dependency',
      objectiveOwner: 'HorseTournamentUtility.evaluateTournamentUtilityDetailed (Phase 7)',
      requiredOutcomeModel:
        'paired whole tournaments to realized prize and bounty share of the funded pool (HorseTournamentLeague.realizedTournamentReturn), the Phase 8 contract shape',
      refusals: [
        'tournament:plo4_whole_tournament_outcome_model_unavailable',
        'tournament:qualified_plo4_tournament_reference_population_unavailable',
        'tournament:plo4_tournament_thresholds_not_specified',
      ],
      why: 'HorseTournamentLeague deals NLH only; the PLO4 league tournament profile measures single-hand chip EV, which is not a prize objective; no source-qualified PLO4 tournament structure population exists; NLH tournament thresholds are not borrowed',
    },
  },
  population: {
    variant: 'plo4',
    stake: STAKE,
    rake: {
      source:
        'getFullRakeConfig(1, 2, "plo4") and getPlayerCountCaps(cap, tableSeats), server/src/config/RakeConfig.ts, as ServerTableEngineBase builds a cash hand',
      percent: PUBLISHED.rakePercent,
      cap: PUBLISHED.rakeCap,
      noFlopNoDrop: true,
      playerCountCaps: Object.fromEntries(
        [6].map((seats) => [seats, getPlayerCountCaps(PUBLISHED.rakeCap, seats)])
      ),
    },
    bbj: {
      enabled: PUBLISHED.bbjEnabled,
      feeBB: PUBLISHED.bbjFeeBB,
      minPotBB: PUBLISHED.rules.minPotBB,
      minPlayersDealt: PUBLISHED.rules.minPlayersDealt,
    },
    buyInBandBB: [CASH_MIN_BB, CASH_MAX_BB],
    maxSeats: maxSeatsForVariant('plo4'),
    styles: PRODUCTION_HORSE_STYLES,
    styleRule:
      'plo4StrengthSeatStyle(dealSeed, seat): uniform over the five production styles for every seat, hero included, identical in both arms',
    opponents: 'the production Horse population (HorseLogic.decide) at the evaluated source',
    humanPopulation:
      'unavailable dependency (qualified human reference and independent holdout are P14-D); the cash qualification is scoped to the Horse population',
    excludedFromQualifiedDomain: [
      'antes and straddles (no profile; the development straddle-ante-100bb profile is software validity only)',
      'tables above six seats (no production Omaha table since 2026-09-08), three or five dealt, and stakes other than the published 1/2 row',
      'depth outside the 40 to 200 BB cash buy-in band',
      'bomb pots, multi-board and run-it-twice (Phase 13 boundaries)',
      'every tournament format (refused above)',
    ],
  },
  holdout: {
    seeds: HOLDOUT_SEEDS,
    developmentSeeds: DEVELOPMENT_SEEDS,
    dealSeedRule:
      '(seed ^ Math.imul(pairIndex + 1, 2654435761)) >>> 0 || 1, as runOmahaPolicyLeague',
    seatingRule: 'plo4LeagueSeating(pairIndex, seats)',
    guard:
      'runPlo4PolicyLeague refuses a held-out seed; the contract shard runner refuses a development seed in contract mode and a held-out seed in development mode',
  },
  matrix: {
    profiles: PROFILES,
    seeds: HOLDOUT_SEEDS,
    pairsPerShard: SHARD_PAIRS,
    rotationBlock: ROTATION_BLOCK,
    pairsPerProfile: Object.fromEntries(
      PROFILES.map((p) => [p.id, p.shards * SHARD_PAIRS * HOLDOUT_SEEDS.length])
    ),
    requiredShards: PROFILES.reduce((n, p) => n + p.shards, 0) * HOLDOUT_SEEDS.length,
    designPilot:
      'development seed 10101101, 576 pairs per profile, runPlo4StrengthShard development mode; recorded paired-difference standard deviation and time per pair only',
    shardRule: 'shard k plays pair indices [k * pairsPerShard, (k + 1) * pairsPerShard)',
    runner:
      'server/src/scripts/plo4StrengthEvaluate.ts --output=<dir> --profile=<id> --seed=<s> --shard=<k> --contract',
  },
  statistic: {
    unit: 'chip cents per paired hand (exact integers); bb/100 = mean cents / (BB * 100) * 100',
    pairing:
      'one deal seed per pair: identical cards, hero seat, button and seat styles in both arms; candidate arm then reference arm',
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
    // Validity of the normal approximation. The first Edgeworth term of a
    // one-sided bound's coverage error is |k|(2z^2 + 1)phi(z)/6, k the skewness
    // of the estimator itself (sum w^3 mu3_p / n_p^2 over Var(T)^1.5). Capping
    // it at 0.001 keeps the one-sided 0.5% error rate below 0.6%. A cell that
    // fails it carries no claim (refused, never relaxed).
    edgeworthCoverageErrorMax: 0.001,
    // Heavy-tailed paired differences make the variance estimate itself noisy:
    // its relative standard error is about sqrt((kurtosis - 1) / n), under 10%
    // for kurtosis up to 100 at n = 10,000. Fewer pairs in any profile of a
    // cell and the interval is not trusted.
    minimumPairsPerProfileInCell: 10_000,
  },
  thresholds: {
    primary: {
      gate: 'cash_after_rake 99% lower bound > 0 bb/100, all five profiles pooled with equal weight',
      lowerBoundAboveBbPer100: 0,
      // Zero is break-even after the house's take: any positive value means the
      // horse keeps more money than the reference against the same population
      // at the published rake and BBJ drop. The lower end of a two-sided 99%
      // interval bounds a false promotion at 0.5%. No positive effect-size
      // floor is set because no calibrated cost of switching exists in source.
    },
    seedReplication: {
      gate: 'each held-out seed block: pooled stratified point estimate > 0 bb/100',
      pointEstimateAboveBbPer100: 0,
      // Three independent replication blocks fixed in advance. Requiring each
      // to point the same way keeps the improvement from resting on one block;
      // a zero true effect passes all three with probability 1/8 on top of the
      // primary bound.
    },
    nonregression: {
      gate: 'every critical cell 99% lower bound >= -10 bb/100',
      lowerBoundAtLeastBbPer100: -10,
      // 10 bb/100 is one 100 BB buy-in per 1,000 hands, the size of a whole
      // winning edge in PLO cash. A domain that may lose more than that against
      // the reference can turn a break-even reference into a clear loser
      // there, whatever the pooled result. The locked shard counts plan every
      // cell's 99% half-width at or below 8.5 bb/100 (1.2 times the pilot
      // deviations), so a cell that truly breaks even can show it. Each cell
      // is tested at 99% with no multiplicity relief: all must pass
      // (intersection-union), so the conjunction is no easier to pass than
      // any one cell.
    },
  },
  nonregressionCells: {
    profiles: PROFILES.map((p) => p.id),
    positions: [
      'button',
      'small_blind',
      'big_blind',
      'cutoff',
      'middle',
      'early',
    ] as Plo4Position[],
    positionRule:
      'positionForOffset(offset, seats), the pack position names; heads-up offset 0 is button',
    depthBands: ['short', 'standard', 'deep'] as Plo4DepthBand[],
    streetFamilies: ['preflop', 'flop', 'turn', 'river'],
    streetRule:
      'contribution to the pooled bb/100 of pairs that diverge on that street (zero elsewhere); the four families and the no-divergence pairs sum exactly to the primary estimate',
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
      fixedWork: 'EQUITY_GOVERNOR off, scale 1, fixed-work policy clock',
    },
    settlementReference:
      'settleOmahaReference (OmahaReference.ts, Phase 9): no seat receives more than its independent gross award, losers receive nothing, and the shortfall equals rake plus BBJ drop',
    deductionReference:
      'effectiveRake and effectiveBbjDrop (config/rakeSpec.ts, the arithmetic the database implements) on the contested pot',
  },
  notStrengthGates: ['atlas coordinate count', 'changed proposal count', 'eligible decision count'],
  promotionEligible: false,
});

export type Plo4StrengthContract = typeof PLO4_STRENGTH_CONTRACT;
export const PLO4_STRENGTH_DOMAIN = 'plo4-cash-single-board-after-rake-horse-population';

/** sha256 of the contract's JSON. Runs, assemblies and qualification files bind it. */
export function plo4StrengthContractDigest(): string {
  return createHash('sha256').update(JSON.stringify(PLO4_STRENGTH_CONTRACT)).digest('hex');
}
export function plo4StrengthProfile(id: string): Readonly<Plo4StrengthProfile> | undefined {
  return PLO4_STRENGTH_CONTRACT.matrix.profiles.find((p) => p.id === id);
}
export function isPlo4HoldoutSeed(seed: number): boolean {
  return (PLO4_STRENGTH_CONTRACT.holdout.seeds as readonly number[]).includes(seed);
}
export function plo4StrengthShardKey(profileId: string, seed: number, shard: number): string {
  return `${profileId}-${seed}-s${shard}`;
}
/** Every (profile, seed, shard) the matrix requires, in a fixed order. */
export function plo4StrengthRequiredShards() {
  const out: { key: string; profileId: string; seed: number; shard: number }[] = [];
  for (const p of PLO4_STRENGTH_CONTRACT.matrix.profiles)
    for (const seed of PLO4_STRENGTH_CONTRACT.matrix.seeds)
      for (let shard = 0; shard < p.shards; shard++)
        out.push({ key: plo4StrengthShardKey(p.id, seed, shard), profileId: p.id, seed, shard });
  return out;
}

export const PLO4_DIVERGENCE_STREETS = ['none', 'preflop', 'flop', 'turn', 'river'] as const;
export type Plo4DivergenceStreet = (typeof PLO4_DIVERGENCE_STREETS)[number];

/** Exact integer power sums of paired differences in chip cents. Decimal strings in JSON. */
export interface Plo4PowerSums {
  n: number;
  s1: string;
  s2: string;
  s3: string;
  s4: string;
}
export interface Plo4StrengthShardResult {
  schema: 'horse-phase10-strength-shard-v1';
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
  totalRake: number;
  totalBbj: number;
  nodeCounts: Record<string, number>;
  reasons: Record<string, number>;
  equityWork: Record<string, number>;
  fixedWork: { governor: 'off'; scale: 1; policyClock: string };
  durationMs: number;
  promotionEligible: false;
}

/** Exact accumulation of one paired difference (integer cents) into power sums. */
export class Plo4PowerAccumulator {
  n = 0;
  s1 = 0n;
  s2 = 0n;
  s3 = 0n;
  s4 = 0n;
  add(cents: number) {
    if (!Number.isSafeInteger(cents)) throw new Error('Paired difference must be integer cents');
    const x = BigInt(cents);
    this.n++;
    this.s1 += x;
    this.s2 += x * x;
    this.s3 += x * x * x;
    this.s4 += x * x * x * x;
  }
  merge(s: Plo4PowerSums) {
    this.n += s.n;
    this.s1 += BigInt(s.s1);
    this.s2 += BigInt(s.s2);
    this.s3 += BigInt(s.s3);
    this.s4 += BigInt(s.s4);
  }
  toJSON(): Plo4PowerSums {
    return {
      n: this.n,
      s1: String(this.s1),
      s2: String(this.s2),
      s3: String(this.s3),
      s4: String(this.s4),
    };
  }
}

/** One profile's contribution to a cell: its weight and the selected pairs' sums
 * (n counts every pair in the profile sample; s1..s4 only the selected ones,
 * so unselected pairs enter as zeros where a contribution is measured). */
interface CellGroup {
  profileId: string;
  weight: number;
  n: number;
  s1: bigint;
  s2: bigint;
  s3: bigint;
}
export interface Plo4CellStatistic {
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
const CENTS_PER_BB = PLO4_STRENGTH_BB * 100;
const toBbPer100 = (cents: number) => (cents / CENTS_PER_BB) * 100;
const phi = (z: number) => Math.exp(-(z * z) / 2) / Math.sqrt(2 * Math.PI);

export function plo4CellStatistic(cell: string, groups: CellGroup[]): Plo4CellStatistic {
  const c = PLO4_STRENGTH_CONTRACT.interval;
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

/** Reasons a shard cannot enter the verdict. Empty means it can. */
export function plo4StrengthShardReasons(r: Plo4StrengthShardResult): string[] {
  const c = PLO4_STRENGTH_CONTRACT;
  const key = plo4StrengthShardKey(r.profileId, r.seed, r.shard);
  const out: string[] = [];
  const profile = plo4StrengthProfile(r.profileId);
  if (r.schema !== 'horse-phase10-strength-shard-v1') out.push(`${key}:schema_mismatch`);
  if (r.contractVersion !== c.version) out.push(`${key}:contract_version_mismatch`);
  if (r.contractDigest !== plo4StrengthContractDigest())
    out.push(`${key}:contract_digest_mismatch`);
  if (r.packVersion !== c.candidate.packVersion) out.push(`${key}:pack_version_mismatch`);
  if (r.evidenceMode !== 'contract') out.push(`${key}:not_contract_mode`);
  if (!profile) out.push(`${key}:unknown_profile`);
  if (!isPlo4HoldoutSeed(r.seed)) out.push(`${key}:not_holdout_seed`);
  if (!Number.isInteger(r.shard) || r.shard < 0 || !profile || r.shard >= profile.shards)
    out.push(`${key}:shard_outside_matrix`);
  if (r.firstPair !== r.shard * c.matrix.pairsPerShard) out.push(`${key}:first_pair_mismatch`);
  if (r.requestedPairs !== c.matrix.pairsPerShard) out.push(`${key}:pairs_below_contract`);
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
      !(PLO4_DIVERGENCE_STREETS as readonly string[]).includes(street)
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
  if (r.fixedWork?.governor !== 'off' || r.fixedWork?.scale !== 1)
    out.push(`${key}:fixed_work_not_proven`);
  if (r.promotionEligible !== false) out.push(`${key}:shard_claims_promotion`);
  return out;
}

export interface Plo4StrengthVerdict {
  contractVersion: string;
  contractDigest: string;
  qualified: boolean;
  reasons: string[];
  cash: {
    qualified: boolean;
    primary: Plo4CellStatistic | null;
    seeds: Plo4CellStatistic[];
    profiles: Plo4CellStatistic[];
    positions: Plo4CellStatistic[];
    depthBands: Plo4CellStatistic[];
    streetFamilies: Plo4CellStatistic[];
    noDivergenceContributionBbPer100: number | null;
  };
  tournament: { status: string; qualified: false; reasons: readonly string[] };
  shardsUsed: number;
  promotionEligible: false;
}

/** The whole-matrix verdict. Every required shard must be present exactly once
 * and valid; every gate is evaluated and every failure is named. */
export function summarizePlo4Strength(shards: Plo4StrengthShardResult[]): Plo4StrengthVerdict {
  const c = PLO4_STRENGTH_CONTRACT;
  const reasons: string[] = [];
  const seen = new Map<string, number>();
  for (const s of shards) {
    const key = plo4StrengthShardKey(s.profileId, s.seed, s.shard);
    seen.set(key, (seen.get(key) ?? 0) + 1);
    reasons.push(...plo4StrengthShardReasons(s));
  }
  const required = plo4StrengthRequiredShards();
  for (const r of required) {
    const count = seen.get(r.key) ?? 0;
    if (count === 0) reasons.push(`${r.key}:missing_shard`);
    if (count > 1) reasons.push(`${r.key}:duplicate_shard`);
  }
  for (const key of seen.keys())
    if (!required.some((r) => r.key === key)) reasons.push(`${key}:unexpected_shard`);

  // Merge exact sums per profile x seed x offset x street.
  const sums = new Map<string, Plo4PowerAccumulator>();
  for (const s of shards)
    for (const [k, v] of Object.entries(s.strata)) {
      const key = `${s.profileId}|${s.seed}|${k}`;
      const acc = sums.get(key) ?? new Plo4PowerAccumulator();
      acc.merge(v);
      sums.set(key, acc);
    }
  const profiles = c.matrix.profiles;
  const group = (
    profileId: string,
    weight: number,
    inSample: (seed: number, offset: number, street: string) => boolean,
    selected: (seed: number, offset: number, street: string) => boolean
  ): CellGroup => {
    const g: CellGroup = { profileId, weight, n: 0, s1: 0n, s2: 0n, s3: 0n };
    for (const [key, acc] of sums) {
      const [pid, seed, offset, street] = key.split('|');
      if (pid !== profileId || !inSample(Number(seed), Number(offset), street)) continue;
      g.n += acc.n;
      if (!selected(Number(seed), Number(offset), street)) continue;
      g.s1 += acc.s1;
      g.s2 += acc.s2;
      g.s3 += acc.s3;
    }
    return g;
  };
  const all = () => true;
  const equal = (
    cell: string,
    members: readonly Readonly<Plo4StrengthProfile>[],
    inSample: (
      p: Readonly<Plo4StrengthProfile>,
      seed: number,
      offset: number,
      street: string
    ) => boolean,
    selected: (
      p: Readonly<Plo4StrengthProfile>,
      seed: number,
      offset: number,
      street: string
    ) => boolean = inSample
  ) =>
    plo4CellStatistic(
      cell,
      members.map((p) =>
        group(
          p.id,
          1 / members.length,
          (seed, offset, street) => inSample(p, seed, offset, street),
          (seed, offset, street) => selected(p, seed, offset, street)
        )
      )
    );

  const primary = sums.size ? equal('primary', profiles, all) : null;
  const seeds = c.matrix.seeds.map((seed) =>
    equal(`seed:${seed}`, profiles, (_p, s) => s === seed)
  );
  const profileCells = profiles.map((p) => equal(`profile:${p.id}`, [p], all));
  const positions = c.nonregressionCells.positions.map((position) => {
    const members = profiles.filter((p) =>
      Array.from({ length: p.seats }, (_, o) => positionForOffset(o, p.seats)).includes(position)
    );
    return equal(
      `position:${position}`,
      members,
      (p, _s, offset) => positionForOffset(offset, p.seats) === position
    );
  });
  const depthBands = c.nonregressionCells.depthBands.map((band) =>
    equal(
      `depth:${band}`,
      profiles.filter((p) => p.depthBand === band),
      all
    )
  );
  const streetFamilies = c.nonregressionCells.streetFamilies.map((street) =>
    equal(`street:${street}`, profiles, all, (_p, _s, _o, st) => st === street)
  );
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
  for (const cell of [...profileCells, ...positions, ...depthBands, ...streetFamilies]) {
    if (!cell.intervalTrusted) reasons.push(`cash:${cell.cell}:interval_not_trusted`);
    if (!(cell.confidence99BbPer100[0] >= t.nonregression.lowerBoundAtLeastBbPer100))
      reasons.push(`cash:${cell.cell}:regression_margin_exceeded`);
  }
  const cashQualified = reasons.length === 0;
  const tournamentReasons = c.objectives.tournament.refusals;
  return {
    contractVersion: c.version,
    contractDigest: plo4StrengthContractDigest(),
    // The cash qualification is the only one this contract can grant; the
    // tournament objective stays an unavailable dependency and is never
    // qualified here.
    qualified: cashQualified,
    reasons,
    cash: {
      qualified: cashQualified,
      primary,
      seeds,
      profiles: profileCells,
      positions,
      depthBands,
      streetFamilies,
      noDivergenceContributionBbPer100: noDivergence,
    },
    tournament: {
      status: c.objectives.tournament.status,
      qualified: false,
      reasons: tournamentReasons,
    },
    shardsUsed: shards.length,
    promotionEligible: false,
  };
}
