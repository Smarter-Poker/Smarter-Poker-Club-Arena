/**
 * P13.2 JOINT MULTIWAY STRENGTH QUALIFICATION CONTRACT (Horse Brain Phase 13)
 *
 * The one immutable, versioned statement of what a strength run of the joint
 * multiway owner (server/src/engine/multiway/*) must measure, per variant, and
 * what it must show before that variant's joint domain can be called
 * qualified. It is locked by the merge that introduces it: no held-out run may
 * precede that merge, and a run, an assembly or a verdict made against any
 * other contract (a different digest) is refused by name.
 *
 * Nine variants, nine separate qualifications. `packs.<variant>` carries that
 * variant's population, profiles, held-out seeds, matrix, design pilot and
 * regression margin, and its domain is
 * `<variant>-cash-joint-multiway-after-rake-horse-population`. The verdict
 * `summarizeJointStrength(variant, shards)` reads one variant's shards only and
 * refuses any shard of another, so a pass for one variant never certifies
 * another.
 *
 * It mirrors the Phase 12 machinery (RemainingVariantStrengthContract.ts) but
 * reads none of that contract's constants: every number below is this
 * contract's own, and the statistic and verdict functions are parametrized by
 * this object. What differs from Phase 12, and why:
 *
 *  (a) the candidate is the joint owner (`phase13Joint: 'candidate'`, domain
 *      joint-multiway-round1-v4, response pack joint-action-response-round2-v1,
 *      range pack joint-public-range-round1-v1) at the hero seat, and the
 *      reference is the same hand with `phase13Joint: 'off'`;
 *  (b) the profiles are cash populations where the joint owner is eligible:
 *      ordinary multiway at three dealt, the creator default six and the cash
 *      seat ceiling, and one-, two- and three-board bomb hands; heads-up
 *      single-board hands belong to the variant owners and are not profiles;
 *  (c) board count is its own gating family beside profiles, positions and
 *      depth bands;
 *  (d) an `illegal_candidate` (or `earlier_phase_applied`) refusal is a
 *      software validity failure, not a diagnostic: P13.1 put every joint
 *      candidate in the legalizer's own form, so a natural refusal means the
 *      measured code is not the code P13.1 verified;
 *  (e) the independent settlement composes every physical board
 *      (JointBoardReference.settleJointBoardReference), so a bomb hand is
 *      checked board by board and pot by pot.
 *
 * TOURNAMENT (prize and bounty): refused by name for every variant; Pineapple
 * has no tournament format at all, and no tournament deals a bomb pot.
 * Nothing here is a calibrated solver claim.
 */
import { createHash } from 'node:crypto';
import { positionForOffset, type Plo4Position } from '../engine/plo4/Plo4PolicyPack.js';
import { getFullRakeConfig, getPlayerCountCaps } from '../config/RakeConfig.js';
import { CASH_MAX_BB, CASH_MIN_BB } from '../config/cashBuyIn.js';
import { maxSeatsForVariant } from '../config/tableSeating.js';
import { KNOWN_VARIANTS, horseVariantRulesFor } from '../engine/VariantRules.js';
import { bettingStructureFor } from '../engine/BettingStructure.js';
import { JOINT_LIVE_DOMAIN } from '../engine/multiway/JointSampleAcquisition.js';
import { JOINT_RANGE_PACK } from '../engine/multiway/JointRangeSampler.js';
import type { GameVariant } from '../types.js';
// Pure functions and the style roster only. Plo4PowerAccumulator is exact
// integer arithmetic, and the seat-style function and roster describe the
// production horse population, which is the same for every variant. No PLO4,
// Phase 11 or Phase 12 contract constant (seeds, thresholds, matrix,
// interval) is read.
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

/** The nine variants of KNOWN_VARIANTS, in that order. */
export const JOINT_STRENGTH_VARIANTS: readonly GameVariant[] = Object.freeze([
  ...(KNOWN_VARIANTS as readonly GameVariant[]),
]);
export type JointStrengthVariant = GameVariant;
export function isJointStrengthVariant(value: unknown): value is JointStrengthVariant {
  return (JOINT_STRENGTH_VARIANTS as readonly unknown[]).includes(value);
}
const structureOf = (v: JointStrengthVariant) => bettingStructureFor(v);
const isFixedLimit = (v: JointStrengthVariant) => structureOf(v) === 'fixed_limit';

/** The league's chip unit: SB 1, BB 2, amounts in chip dollars with cents. */
export const JOINT_STRENGTH_BB = 2;
const STAKE = { smallBlind: 1, bigBlind: JOINT_STRENGTH_BB } as const;
/** The creator default table size of every cash template, and the dealt count
 * at which the depth bands and the bomb hands are measured. */
const SIX_MAX = 6;
/** The ordinary multiway minimum: three dealt is the smallest table at which
 * the joint owner (not the heads-up variant owner) takes a single-board
 * decision. */
const THREE_DEALT = 3;
/** The legacy fixed-limit exposure the joint domain supports. */
const LEGACY_FIXED_LIMIT_BB = JOINT_LIVE_DOMAIN.fixedLimitMaxStackBB;
/** The response pack identities the candidate is measured with. Written here
 * rather than imported: JointActionModel.ts reaches the Phase 7 tournament
 * owner, whose import closure constructs the database client at load, and
 * this contract stays pure data. The shard runner records the running
 * JOINT_ACTION_PACK.version, a shard whose version differs is refused by name
 * (pack_version_mismatch), and a test requires these to equal the running
 * constants. */
const RESPONSE_PACK_VERSION = 'joint-action-response-round2-v1';
const COMPARISON_RESPONSE_PACK_VERSION = 'joint-action-response-round1-v2';
/** The bomb ante the engine posts when a table leaves the default
 * (`bomb_pot_ante_multiplier ?? 2`, ServerTableEngineDealing). */
const BOMB_ANTE_MULTIPLIER = 2;

/** The live decision clock replacement (liveConditions, mood): a deterministic
 * time of day derived from the deal seed, identical in both arms of a pair. The
 * shared league computes the same value (`omahaVariantMoodClockMs`, the
 * `moodClock: 'deal_seed_time_of_day'` profile option); a test proves they
 * agree. */
export function jointMoodClockMs(dealSeed: number): number {
  return (dealSeed % 86_400) * 1000;
}

export { PRODUCTION_HORSE_STYLES };
/** The production style roster and per-seat draw of Phases 10, 11 and 12:
 * uniform over the five production styles by deal seed and seat, hero
 * included, identical in the candidate and reference arms. */
export const jointStrengthSeatStyle = plo4StrengthSeatStyle;

export type JointDepthBand = 'short' | 'standard' | 'deep' | 'legacy_deep';
export type JointBoardCount = 1 | 2 | 3;
export interface JointStrengthProfile {
  id: string;
  variant: JointStrengthVariant;
  /** Dealt seats; every seat is occupied and dealt. */
  seats: number;
  /** The table's max_players, which gates the player-count cap ladder. */
  tableSeats: number;
  stackBB: number;
  depthBand: JointDepthBand;
  /** 1, 2 or 3 for a bomb hand (the controller's activated board count, never
   * downgraded at this dealt count); null for an ordinary blinds hand. */
  bombBoards: JointBoardCount | null;
  /** The physical board count of every hand of this profile. */
  boards: JointBoardCount;
  /** Shards per held-out seed (each pairsPerShard pairs of this variant). */
  shards: number;
  /** Design pilot paired-difference standard deviation, BB per hand
   * (dispersion only; used to size `shards`). */
  pilotSdBB: number;
  /** Design pilot wall time per pair (candidate and reference hand), ms. */
  pilotMsPerPair: number;
  /** Design pilot kurtosis of the paired difference (m4 / m2^2). */
  pilotKurtosis: number;
  /** Design pilot joint-eligible hero decisions per pair (candidate arm). */
  pilotEligiblePerPair: number;
}

type ProfileKey =
  | '3dealt'
  | 'extra'
  | '40bb'
  | '100bb'
  | '200bb'
  | 'bomb1'
  | 'bomb2'
  | 'bomb3'
  | '1000bb';
type PilotRow = readonly [sdBB: number, msPerPair: number, kurtosis: number, eligible: number];
/** Design pilot, per variant and profile: [paired-difference SD in BB per
 * hand, ms per pair, kurtosis, joint-eligible hero decisions per pair].
 * Development seed 13101101 (JOINT_LEAGUE_SEEDS[0]), runJointStrengthShard
 * development mode, shard 0, PILOT_PAIRS pairs per profile, in this
 * repository's Linux container (2 vCPU, shared with other agents, one pilot
 * process at a time). Never a held-out seed and never a mean. The logs are
 * docs/evidence/phase13/pilot-<variant>.json. */
const PILOT: Record<JointStrengthVariant, Partial<Record<ProfileKey, PilotRow>>> = {
  nlh: {
    '3dealt': [20.43, 17.8, 20, 0.5],
    extra: [25.25, 29.9, 12.8, 0.97],
    '40bb': [11.68, 21.3, 9.9, 0.86],
    '100bb': [29.13, 19.7, 10.6, 0.88],
    '200bb': [54.79, 21.1, 11.7, 0.89],
    bomb1: [62.45, 94.2, 7.1, 1.99],
    bomb2: [38.21, 112.1, 3.7, 1.76],
    bomb3: [36.72, 118.5, 4.6, 1.85],
  },
  short_deck: {
    '3dealt': [22.36, 23, 20.8, 0.56],
    extra: [58.73, 38.9, 4.6, 1.08],
    '40bb': [23.09, 29.6, 5.7, 0.99],
    '100bb': [57.07, 38.9, 6.4, 0.99],
    '200bb': [107.06, 33.2, 7.6, 0.97],
    bomb1: [59.18, 114.7, 2.6, 2.07],
    bomb2: [39.21, 118.3, 5.2, 1.73],
    bomb3: [35.11, 120.4, 4.2, 1.94],
  },
  flh: {
    '3dealt': [2.62, 34.7, 6, 0.64],
    extra: [4.43, 61.8, 6, 1.6],
    '40bb': [3.66, 39.7, 7.2, 1.18],
    '100bb': [3.85, 40.9, 5.9, 1.28],
    '200bb': [4.16, 37.6, 7.7, 1.31],
    bomb1: [6.89, 152.3, 5.2, 3.63],
    bomb2: [6.41, 165.8, 3.9, 3.24],
    bomb3: [5.14, 178.8, 3.3, 3.36],
    '1000bb': [4.13, 38.3, 7.8, 1.31],
  },
  pineapple: {
    '3dealt': [25.55, 21.4, 13.5, 0.55],
    extra: [68.08, 47.2, 12.9, 0.98],
    '40bb': [18.83, 29.8, 7.3, 0.93],
    '100bb': [40.75, 34.1, 5.5, 0.9],
    '200bb': [87.82, 37.8, 7.3, 0.91],
    bomb1: [63, 187.6, 2.7, 2],
    bomb2: [47.09, 176.2, 2.2, 1.76],
    bomb3: [46.22, 149.7, 2.7, 1.77],
  },
  plo4: {
    '3dealt': [21.09, 33, 18.6, 0.66],
    extra: [46.77, 71.4, 8.5, 1.7],
    '40bb': [17.36, 50.5, 7.1, 1.33],
    '100bb': [31.73, 55.5, 16.6, 1.46],
    '200bb': [39.57, 56.9, 16.8, 1.48],
    bomb1: [37.35, 173.5, 3, 2.63],
    bomb2: [37.16, 262, 3.7, 2.61],
    bomb3: [35.9, 390.3, 4.2, 2.47],
  },
  plo5: {
    '3dealt': [19.95, 60.3, 18.1, 0.7],
    extra: [29.73, 86, 10.1, 1.4],
    '40bb': [23.85, 106.2, 8.6, 1.32],
    '100bb': [39.29, 100.1, 26, 1.28],
    '200bb': [54.95, 98.1, 10.9, 1.29],
    bomb1: [50.3, 225.7, 5.8, 2.68],
    bomb2: [42.65, 351.6, 3.5, 2.78],
    bomb3: [40.23, 574.7, 4.5, 2.76],
  },
  plo6: {
    '3dealt': [19.16, 44.1, 20.9, 0.67],
    extra: [21.45, 57.6, 16.3, 1.08],
    '40bb': [16.99, 68.9, 7.3, 1.28],
    '100bb': [33.41, 76.2, 7.9, 1.38],
    '200bb': [47.68, 104, 14, 1.46],
    bomb1: [44.07, 265, 3.4, 2.72],
    bomb2: [40.33, 551.9, 7.4, 2.85],
    bomb3: [39.92, 710.5, 3.4, 2.76],
  },
  plo8: {
    '3dealt': [19.99, 45.4, 19.5, 0.7],
    extra: [35.94, 113.6, 6.4, 1.6],
    '40bb': [14.95, 110.3, 6, 1.34],
    '100bb': [23.33, 91.3, 12, 1.46],
    '200bb': [28.75, 130.7, 31.4, 1.44],
    bomb1: [39.37, 480.4, 3.7, 2.38],
    bomb2: [34.96, 794.3, 8.4, 2.56],
    bomb3: [28.53, 660.6, 5.5, 2.44],
  },
  flo8: {
    '3dealt': [3.93, 74.2, 7.8, 0.97],
    extra: [6.2, 177.3, 4.4, 2.58],
    '40bb': [4.14, 105.9, 3.7, 1.78],
    '100bb': [4.42, 125, 4, 1.91],
    '200bb': [5, 161.1, 5.3, 2.03],
    bomb1: [5.6, 520.7, 4.8, 3.38],
    bomb2: [4.75, 610.9, 3.8, 3.13],
    bomb3: [4.5, 937.9, 3, 3.24],
    '1000bb': [4.97, 130.4, 5.4, 2.01],
  },
};
/** Pairs per profile in the design pilot (a whole number of rotation blocks
 * is not required of a pilot; every offset is still visited). */
export const JOINT_PILOT_PAIRS = 144;
/** Shards per held-out seed, per variant, in profile order (3 dealt, the
 * extra dealt count, six-max 40, 100 and 200 BB, bomb one, two and three
 * boards, then 1,000 BB for the fixed-limit variants), found by the greedy
 * rule in matrixRules.sizingRule (docs/evidence/phase13/p13-2-sizing.mts.txt
 * and p13-2-sizing.log): start at the fewest shards per seed giving every
 * profile 10,000 pairs at each dealer-relative offset, and keep adding one
 * shard per seed to the member of the widest planned gating cell that narrows
 * it most per runner minute, until that cell is inside 0.85 x the margin or
 * the hosted budget refuses any addition. FLH reaches its planned maximum;
 * every other variant is bound by the budget, and its plannedGatingCells
 * record how wide each cell is planned to be. */
const SHARDS: Record<JointStrengthVariant, readonly number[]> = {
  nlh: [2, 2, 1, 3, 8, 11, 4, 4],
  short_deck: [1, 5, 1, 5, 17, 6, 3, 2],
  flh: [1, 2, 2, 2, 2, 5, 4, 3, 2],
  pineapple: [2, 9, 1, 3, 14, 7, 4, 4],
  plo4: [3, 11, 2, 6, 8, 7, 7, 7],
  plo5: [2, 4, 3, 7, 12, 10, 8, 7],
  plo6: [2, 3, 3, 5, 10, 9, 8, 7],
  plo8: [3, 8, 4, 4, 5, 9, 8, 5],
  flo8: [5, 11, 5, 6, 8, 9, 7, 6, 7],
};
/** Rotation blocks per shard, per variant: the largest whole number keeping
 * the slowest profile's shard at or under 60 hosted minutes (pilot time /
 * 1.5): NLH, Short Deck and Pineapple (rotation block 324) 140, 138 and 88;
 * FLH (324) 93; PLO4 and PLO8 (576) 24 and 11; PLO5 (1,764) 5; PLO6 (144) 52;
 * FLO8 (576) 9. The slowest profile is a bomb hand in every variant. */
const SHARD_BLOCKS: Record<JointStrengthVariant, number> = {
  nlh: 140,
  short_deck: 138,
  flh: 93,
  pineapple: 88,
  plo4: 24,
  plo5: 5,
  plo6: 52,
  plo8: 11,
  flo8: 9,
};
/** GitHub Actions runs at most this many jobs from one matrix (one dispatch). */
export const JOINT_MATRIX_JOB_CEILING = 256;
/** Hosted-runner budget: a GitHub-hosted runner is taken as 1.5 times faster
 * than the pilot container, a shard must stay well under the 120-minute job
 * timeout, and a variant matrix should finish in about two to three hours of
 * wall time at max-parallel 20. */
const HOSTED = {
  speedupOverPilot: 1.5,
  maxMinutesPerShard: 60,
  maxParallel: 20,
  targetWallHours: 3,
} as const;

/** Held-out seeds, chosen and written here before any run. Never used by any
 * test, development league, pilot or tuning run. Disjoint from every seed in
 * the repository (PLO4 development and held-out, the Phase 11 and Phase 12
 * development and held-out seeds, JOINT_LEAGUE_SEEDS, the Phase 8 league
 * seeds), from each other and across variants; none of the 27 numbers occurred
 * anywhere in the repository when they were chosen
 * (docs/evidence/phase13/p13-2-seeds.log). The pattern is 132 V K xxx, V the
 * variant's position in KNOWN_VARIANTS (1 to 9) and K the seed index (1 to 3).
 * runOmahaPolicyLeague, runPlo4StrengthShard, runOmahaVariantStrengthShard and
 * runRemainingVariantStrengthShard refuse them, and only runJointStrengthShard
 * in contract mode, for its own variant, accepts them. */
const HOLDOUT: Record<JointStrengthVariant, readonly [number, number, number]> = {
  nlh: [13211143, 13212287, 13213391],
  short_deck: [13221149, 13222293, 13223383],
  flh: [13231151, 13232299, 13233373],
  pineapple: [13241153, 13242309, 13243367],
  plo4: [13251157, 13252311, 13253359],
  plo5: [13261163, 13262317, 13263353],
  plo6: [13271167, 13272321, 13273349],
  plo8: [13281171, 13282327, 13283347],
  flo8: [13291177, 13292333, 13293341],
} as Record<JointStrengthVariant, readonly [number, number, number]>;
/** The Phase 13 development league seeds (JOINT_LEAGUE_SEEDS). */
const DEVELOPMENT_SEEDS = [13101101, 13102203, 13103307];

/** Phi^-1(0.995): the two-sided 99% normal quantile (the Phase 12 value). */
export const JOINT_STRENGTH_Z99 = 2.5758293035489004;
const Z99 = JOINT_STRENGTH_Z99;
/** Planning rule: every gating cell's planned 99% half-width is at most 0.85
 * of the variant's regression margin (Phase 10's 8.5 against 10) at
 * PLANNING_SD_FACTOR times the pilot deviations, where the hosted budget
 * allows it (matrixRules.sizingRule). */
const HALF_WIDTH_TO_MARGIN = 0.85;
const PLANNING_SD_FACTOR = 1.2;
const MINIMUM_PAIRS_PER_PROFILE_IN_CELL = 10_000;
/** The regression margins, bb/100, by betting structure. */
const NO_LIMIT_MARGIN = 10;
const FIXED_LIMIT_MARGIN = 4;
const marginOf = (v: JointStrengthVariant) =>
  isFixedLimit(v) ? FIXED_LIMIT_MARGIN : NO_LIMIT_MARGIN;
const plannedMaxOf = (v: JointStrengthVariant) =>
  Math.round(HALF_WIDTH_TO_MARGIN * marginOf(v) * 100) / 100;

const POSITIONS: Plo4Position[] = [
  'button',
  'small_blind',
  'big_blind',
  'cutoff',
  'middle',
  'early',
];
const BOARD_COUNTS: JointBoardCount[] = [1, 2, 3];

const ceilingOf = (v: JointStrengthVariant) => maxSeatsForVariant(v);
/** The third ordinary dealt count: the cash seat ceiling where it is above
 * six, and four (between three and the six-seat ceiling) for PLO6. */
const extraDealtOf = (v: JointStrengthVariant) => (ceilingOf(v) > SIX_MAX ? ceilingOf(v) : 4);
/** The smallest block that is a multiple of every profile's seats squared, so
 * each shard of a whole number of blocks visits every (hero seat, button)
 * pair the same number of times. */
function rotationBlockOf(v: JointStrengthVariant): number {
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  return [THREE_DEALT, SIX_MAX, extraDealtOf(v)].reduce((l, s) => (l * s * s) / gcd(l, s * s), 1);
}

function profilesFor(variant: JointStrengthVariant): JointStrengthProfile[] {
  const pilot = PILOT[variant];
  const shards = SHARDS[variant];
  const extra = extraDealtOf(variant);
  const table = (seats: number) => Math.max(SIX_MAX, seats);
  const rows: [string, ProfileKey, number, number, JointDepthBand, JointBoardCount | null][] = [
    ['3dealt-100bb', '3dealt', THREE_DEALT, 100, 'standard', null],
    [
      extra > SIX_MAX ? `${extra}max-100bb` : `${extra}dealt-100bb`,
      'extra',
      extra,
      100,
      'standard',
      null,
    ],
    ['6max-40bb', '40bb', SIX_MAX, CASH_MIN_BB, 'short', null],
    ['6max-100bb', '100bb', SIX_MAX, 100, 'standard', null],
    ['6max-200bb', '200bb', SIX_MAX, CASH_MAX_BB, 'deep', null],
    ['bomb1-6max-100bb', 'bomb1', SIX_MAX, 100, 'standard', 1],
    ['bomb2-6max-100bb', 'bomb2', SIX_MAX, 100, 'standard', 2],
    ['bomb3-6max-100bb', 'bomb3', SIX_MAX, 100, 'standard', 3],
  ];
  if (isFixedLimit(variant))
    rows.push([
      `6max-${LEGACY_FIXED_LIMIT_BB}bb`,
      '1000bb',
      SIX_MAX,
      LEGACY_FIXED_LIMIT_BB,
      'legacy_deep',
      null,
    ]);
  return rows.map(([suffix, key, seats, stackBB, depthBand, bombBoards], index) => {
    const p = pilot[key];
    if (!p || !shards[index])
      throw new Error(`P13.2 contract has no pilot or shards for ${variant} ${key}`);
    return {
      id: `p13c-${variant}-${suffix}`,
      variant,
      seats,
      tableSeats: table(seats),
      stackBB,
      depthBand,
      bombBoards,
      boards: bombBoards ?? 1,
      shards: shards[index],
      pilotSdBB: p[0],
      pilotMsPerPair: p[1],
      pilotKurtosis: p[2],
      pilotEligiblePerPair: p[3],
    };
  });
}
const depthBandsOf = (v: JointStrengthVariant): JointDepthBand[] =>
  isFixedLimit(v) ? ['short', 'standard', 'deep', 'legacy_deep'] : ['short', 'standard', 'deep'];

/** Members, and pairs per member, of each gating cell for a profile set. */
function gatingCellPlan(profiles: readonly JointStrengthProfile[], pairsPerShard: number) {
  const seeds = 3;
  const pairsOf = (p: JointStrengthProfile) => p.shards * pairsPerShard * seeds;
  const cells: { cell: string; members: { p: JointStrengthProfile; n: number }[] }[] = [];
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
  const bands = [...new Set(profiles.map((p) => p.depthBand))];
  for (const band of (['short', 'standard', 'deep', 'legacy_deep'] as const).filter((b) =>
    bands.includes(b)
  ))
    cells.push({
      cell: `depth:${band}`,
      members: profiles.filter((p) => p.depthBand === band).map((p) => ({ p, n: pairsOf(p) })),
    });
  for (const boards of BOARD_COUNTS)
    cells.push({
      cell: `boards:${boards}`,
      members: profiles.filter((p) => p.boards === boards).map((p) => ({ p, n: pairsOf(p) })),
    });
  return cells;
}
/** Planned 99% half-width (bb/100) of each gating cell at PLANNING_SD_FACTOR
 * times the pilot deviations, the smallest per-profile pair count in it, and
 * the largest relative standard error of a member's variance estimate at its
 * pilot kurtosis, sqrt((kurtosis - 1) / n). The sizing script calls this same
 * function on candidate shard counts. */
export function jointPlannedHalfWidths(
  profiles: readonly JointStrengthProfile[],
  pairsPerShard: number
) {
  return Object.fromEntries(
    gatingCellPlan(profiles, pairsPerShard).map(({ cell, members }) => {
      const w = 1 / members.length;
      const variance = members.reduce(
        (s, m) => s + (w * w * (PLANNING_SD_FACTOR * m.p.pilotSdBB) ** 2) / m.n,
        0
      );
      const halfWidth = Z99 * Math.sqrt(variance) * 100;
      return [
        cell,
        {
          halfWidthBbPer100: Math.round(halfWidth * 100) / 100,
          minimumProfilePairs: Math.min(...members.map((m) => m.n)),
          varianceRelativeSeAtPilotKurtosis:
            Math.round(
              Math.max(...members.map((m) => Math.sqrt(Math.max(0, m.p.pilotKurtosis - 1) / m.n))) *
                1000
            ) / 1000,
        },
      ];
    })
  );
}
/** Estimated hosted minutes for one shard of a profile and the variant's
 * runner hours and wall hours at max-parallel 20 (the hosted budget). */
export function jointHostedEstimate(
  profiles: readonly JointStrengthProfile[],
  pairsPerShard: number
) {
  const minutes = (p: JointStrengthProfile) =>
    (p.pilotMsPerPair * pairsPerShard) / HOSTED.speedupOverPilot / 60_000;
  const jobs = profiles.flatMap((p) => Array<number>(p.shards * 3).fill(minutes(p)));
  const runnerHours = jobs.reduce((s, m) => s + m, 0) / 60;
  // Longest-processing-time list schedule over max-parallel lanes.
  const lanes = Array<number>(HOSTED.maxParallel).fill(0);
  for (const m of [...jobs].sort((a, b) => b - a)) {
    const i = lanes.indexOf(Math.min(...lanes));
    lanes[i] += m;
  }
  return {
    slowestShardMinutes: Math.round(Math.max(0, ...profiles.map(minutes)) * 10) / 10,
    jobs: jobs.length,
    runnerHours: Math.round(runnerHours * 10) / 10,
    wallHoursAtMaxParallel: Math.round((Math.max(...lanes) / 60) * 100) / 100,
  };
}

function tournamentSection(variant: JointStrengthVariant) {
  const common = {
    id: 'tournament_prize_bounty',
    status: 'unavailable dependency',
    objectiveOwner: 'HorseTournamentUtility.evaluateTournamentUtilityDetailed (Phase 7)',
  };
  if (variant === 'pineapple')
    return {
      ...common,
      requiredOutcomeModel: 'none: there is no Pineapple tournament to model',
      refusals: ['tournament:pineapple_tournament_format_unavailable'],
      why: 'Pineapple has no tournament format: the tournament catalog excludes it, the tournament allowlist (supabase/migrations/20260912044409_remaining_tournament_variant_allowlist.sql) refuses it, and the joint acquisition refuses a Pineapple tournament decision (pineapple_tournament_unavailable)',
    };
  return {
    ...common,
    requiredOutcomeModel:
      'paired whole tournaments to realized prize and bounty share of the funded pool (HorseTournamentLeague.realizedTournamentReturn), the Phase 8 contract shape, with the joint owner deciding multiway spots through the Phase 7 utility',
    refusals: [
      `tournament:${variant}_joint_whole_tournament_outcome_model_unavailable`,
      `tournament:qualified_${variant}_joint_tournament_reference_population_unavailable`,
      `tournament:${variant}_joint_tournament_thresholds_not_specified`,
    ],
    why: `HorseTournamentLeague deals NLH only and plays no joint candidate; a tournament joint decision is priced by the Phase 7 utility owner, so the league's single-hand chip result is not a prize objective; no source-qualified ${variant} multiway tournament structure population exists; no tournament deals a bomb pot (ServerTableEngineDealing: a tournament never deals a bomb); NLH tournament thresholds are not borrowed`,
  };
}

const TEMPLATES: Record<string, string> = {
  nlh: 'fn_cash_template_defaults (family holdem): Classic nine seats by default (choices 9 or 6), Action and Madness six by default (choices 2 to 9), not locked',
  flh: 'fn_cash_template_defaults (family holdem): Classic nine seats by default (choices 9 or 6), Action and Madness six by default (choices 2 to 9), not locked',
  short_deck:
    'fn_cash_template_defaults (family shortdeck): six seats by default, the host may choose 2 to 8, not locked',
  pineapple:
    'fn_cash_template_defaults (family pineapple): six seats by default, the host may choose 2 to 8, not locked',
  plo4: 'fn_cash_template_defaults (family plo): six seats, locked (Omaha tables are locked at six since 2026-09-05; legacy tables up to the seat law exist)',
  plo5: 'fn_cash_template_defaults (family plo): six seats, locked (Omaha tables are locked at six since 2026-09-05; legacy tables up to the seat law exist)',
  plo6: 'fn_cash_template_defaults (family plo): six seats, locked',
  plo8: 'fn_cash_template_defaults (family plo): six seats, locked (Omaha tables are locked at six since 2026-09-05; legacy tables up to the seat law exist)',
  flo8: 'fn_cash_template_defaults (family plo): six seats, locked (legacy tables up to the seat law exist)',
};

function packSection(variant: JointStrengthVariant) {
  const published = getFullRakeConfig(STAKE.smallBlind, STAKE.bigBlind, variant);
  const rules = horseVariantRulesFor(variant);
  const profiles = profilesFor(variant);
  const rotationBlock = rotationBlockOf(variant);
  const pairsPerShard = rotationBlock * SHARD_BLOCKS[variant];
  const seeds = HOLDOUT[variant];
  const ceiling = ceilingOf(variant);
  const extra = extraDealtOf(variant);
  const fixedLimit = isFixedLimit(variant);
  const depthBands = depthBandsOf(variant);
  const margin = marginOf(variant);
  return {
    variant,
    domain: jointStrengthDomainOf(variant),
    structure: structureOf(variant),
    candidate: {
      owner:
        'HorseLogic.decide with phase13Joint "candidate" at the hero seat (evaluateJointLivePolicy over the joint domain, the P13.1 legal form and the illegal_candidate / earlier_phase_applied guards in the joint_policy node)',
      packVersion: RESPONSE_PACK_VERSION,
      domainVersion: JOINT_LIVE_DOMAIN.version,
      rangePackVersion: JOINT_RANGE_PACK.version,
      comparisonResponseVersion: COMPARISON_RESPONSE_PACK_VERSION,
      comparisonResponseRole:
        'the retained one-response model is a named comparison identity only; it is never the candidate here',
      calibratedConfidence: JOINT_LIVE_DOMAIN.calibratedConfidence,
      structure: structureOf(variant),
      holes: rules.holeCardsDealt,
      deck: rules.deckSize,
      splitLow: rules.splitLow8OrBetter,
      eligibility:
        'the joint acquisition: a cash betting decision with at least two live opponents on one board, or any bomb hand after the flop with at least one; heads-up single-board decisions belong to the variant owner and keep the reference action in both arms',
      discard:
        variant === 'pineapple'
          ? 'the flop discard is not a betting candidate: both arms discard through HorseLogic.decideDiscard seeded by (deal seed, seat), discards are counted separately and never as candidate changes'
          : 'none',
    },
    reference: {
      owner:
        'HorseLogic.decide with phase13Joint "off" at the hero seat; every other phase at its live default action',
      claim:
        'the action live tables execute today: Phase 13 runs in shadow, and the Phase 10, 11 and 12 candidates are not selected live (every protected release selection is null), so live play takes the variant owners reference action; in the harness phase10Plo4, phase11Omaha and phase12Remaining are off in every seat, which executes the same action as their live shadow; not an external solver',
    },
    population: {
      variant,
      stake: STAKE,
      rake: {
        source: `getFullRakeConfig(1, 2, "${variant}") and getPlayerCountCaps(cap, tableSeats), server/src/config/RakeConfig.ts, as ServerTableEngineBase builds a cash hand (a bomb hand is priced by the same lookup)`,
        percent: published.rakePercent,
        cap: published.rakeCap,
        noFlopNoDrop: true,
        playerCountCaps: {
          [SIX_MAX]: getPlayerCountCaps(published.rakeCap, SIX_MAX),
          [ceiling]: getPlayerCountCaps(published.rakeCap, ceiling),
        },
      },
      bbj: {
        source: `getFullRakeConfig(1, 2, "${variant}").bbjEnabled, bbjFeeBB and rules (a variant the jackpot does not cover drops nothing; a multi-board bomb hand still drops the fee and is excluded only from the payout)`,
        enabled: published.bbjEnabled,
        feeBB: published.bbjFeeBB,
        minPotBB: published.rules.minPotBB,
        minPlayersDealt: published.rules.minPlayersDealt,
      },
      bombPot: {
        source:
          'ServerTableEngineDealing and BombPotScheduler: cash tables of every variant may enable bomb pots (a tournament never deals one); the table variant is dealt; bomb_pot_min_players defaults to 3; the ante is bomb_pot_ante_multiplier (default 2) big blinds; HandController.postBombPotAntes activates as many of the requested boards as the deck covers',
        anteMultiplier: BOMB_ANTE_MULTIPLIER,
        dealtSeats: SIX_MAX,
        boardsActivatedAtSixDealt: BOARD_COUNTS.map((b) =>
          Math.min(b, Math.floor((rules.deckSize - SIX_MAX * rules.holeCardsDealt) / 5))
        ),
      },
      buyInBandBB: [CASH_MIN_BB, CASH_MAX_BB],
      ...(fixedLimit
        ? {
            legacyDepthBB: LEGACY_FIXED_LIMIT_BB,
            legacyDepthReason:
              'JOINT_LIVE_DOMAIN.fixedLimitMaxStackBB (the Phase 12 fixed-limit domain): an observed legacy fixed-limit cash table permits a deep buy-in, and the joint domain admits fixed-limit depth through 1,000 BB because fixed wager bounds control each candidate exposure',
          }
        : {}),
      cashSeatCeiling: ceiling,
      dealtCounts: [THREE_DEALT, SIX_MAX, extra].sort((a, b) => a - b),
      tableSeats: [...new Set([SIX_MAX, Math.max(SIX_MAX, extra)])],
      currentTemplates: TEMPLATES[variant],
      tableSeatsReason:
        extra > SIX_MAX
          ? `three dealt is the smallest single-board table the joint owner decides at; six seats is the creator default (${TEMPLATES[variant]}) and carries the depth bands and the bomb hands; ${ceiling} seats is the cash seat law (maxSeatsForVariant), the largest table the joint domain admits, measured as its own profile rather than assumed`
          : `three dealt is the smallest single-board table the joint owner decides at; six seats is both the creator default and the cash seat law for ${variant} (${TEMPLATES[variant]}) and carries the depth bands and the bomb hands; four dealt is the middle count between them`,
      styles: PRODUCTION_HORSE_STYLES,
      styleRule:
        'jointStrengthSeatStyle(dealSeed, seat) (the Phase 10 production-style draw): uniform over the five production styles for every seat, hero included, identical in both arms',
      opponents:
        'HorseLogic.decide seats at the evaluated source with the production style mix, every one with phase13Joint off (and the Phase 10, 11 and 12 policies off), under the harness conditions in liveConditions',
      humanPopulation:
        'unavailable dependency (qualified human reference and independent holdout are P14-D); the cash qualification is scoped to the Horse population',
      excludedFromQualifiedDomain: [
        'heads-up single-board hands (owned by the variant policy, never by the joint owner)',
        'antes and straddles outside bomb hands (no profile; the Action and Madness templates carry antes)',
        `ordinary tables other than six and ${Math.max(SIX_MAX, extra)} seats, ordinary dealt counts other than ${[THREE_DEALT, SIX_MAX, extra].sort((a, b) => a - b).join(', ')}, bomb hands at other dealt counts, other bomb antes (fixed antes and multipliers other than 2), and stakes other than the published 1/2 row`,
        fixedLimit
          ? `depth outside the 40 to 200 BB cash buy-in band other than the legacy ${LEGACY_FIXED_LIMIT_BB} BB profile, and bomb hands at depths other than 100 BB`
          : 'depth outside the 40 to 200 BB cash buy-in band, and bomb hands at depths other than 100 BB',
        'bomb hands dealt as another variant (the bomb_pot_variant override), and run-it-twice',
        variant === 'nlh'
          ? 'Diamond NLH whole-unit cash: a different asset with whole-unit settlement and zero configured deductions on Diamond Arena tables whose stakes and population are not the published chip 1/2 row, so it is not an after-rake chip domain; its correctness stays covered by the development league profile nlh-diamond-bomb3, and a Diamond qualification needs its own domain identity'
          : 'Diamond tables (the joint owner refuses a Diamond hand of any variant but NLH: diamond_variant_unavailable)',
        variant === 'pineapple'
          ? 'every tournament format (Pineapple has none)'
          : 'every tournament format, Spin included (refused in tournament)',
      ],
    },
    tournament: tournamentSection(variant),
    holdout: {
      seeds,
      developmentSeeds: DEVELOPMENT_SEEDS,
      dealSeedRule:
        '(seed ^ Math.imul(pairIndex + 1, 2654435761)) >>> 0 || 1, as runOmahaPolicyLeague',
      seatingRule: 'plo4LeagueSeating(pairIndex, seats)',
    },
    regressionMargin: {
      lowerBoundAtLeastBbPer100: -margin,
      plannedHalfWidthMaxBbPer100: plannedMaxOf(variant),
      reason: fixedLimit
        ? 'fixed limit: 4 bb/100 is two big bets per 100 hands (the big bet is 2 BB), about a whole winning edge in fixed-limit cash; the Phase 12 fixed-limit number and reasoning'
        : 'no limit and pot limit: 10 bb/100 is one 100 BB buy-in per 1,000 hands, about the size of a whole winning edge in big-bet cash (the Phase 10, 11 and 12 number and reasoning)',
    },
    gatingCells: {
      count: profiles.length + POSITIONS.length + depthBands.length + BOARD_COUNTS.length,
      depthBands,
      boardCounts: BOARD_COUNTS,
    },
    matrix: {
      profiles,
      seeds,
      rotationBlock,
      pairsPerShard,
      pairsPerProfile: Object.fromEntries(
        profiles.map((p) => [p.id, p.shards * pairsPerShard * seeds.length])
      ),
      requiredShards: profiles.reduce((n, p) => n + p.shards, 0) * seeds.length,
      plannedGatingCells: jointPlannedHalfWidths(profiles, pairsPerShard),
      hostedEstimate: jointHostedEstimate(profiles, pairsPerShard),
      runner: `server/src/scripts/jointStrengthEvaluate.ts --variant=${variant} --output=<dir> --profile=<id> --seed=<s> --shard=<k> --contract`,
    },
  };
}

export function jointStrengthDomainOf(variant: string): string {
  return `${variant}-cash-joint-multiway-after-rake-horse-population`;
}

export const JOINT_STRENGTH_CONTRACT = deepFreeze({
  schema: 'horse-phase13-strength-contract',
  version: 'joint-strength-contract-v1',
  phase: 'P13.2',
  locked:
    'by the merge of the pull request that introduced this file; the matrix of a variant is dispatched only against a commit on main that contains it, and no held-out hand is dealt before',
  independence:
    'each variant is qualified on its own matrix, seeds, margin and verdict; a pass for one variant never certifies another, and a shard of one variant is refused by name in another variant verdict',
  objectives: {
    cash: {
      id: 'cash_after_rake',
      status: 'measured',
      metric:
        'paired difference of the hero seat net chips per hand (final stack minus starting stack) after the engine rake and BBJ drop, candidate minus reference, reported in bb/100',
      excluded:
        'BBJ jackpot awards (paid by the database from the external pool after the hand, not in hand settlement)',
      verdict:
        'summarizeJointStrength(variant, shards), server/src/benchmark/JointStrengthContract.ts',
    },
    tournament:
      'refused by name per variant (packs.<variant>.tournament), never in the top-level verdict reasons',
  },
  packs: Object.fromEntries(JOINT_STRENGTH_VARIANTS.map((v) => [v, packSection(v)])) as Record<
    JointStrengthVariant,
    ReturnType<typeof packSection>
  >,
  matrixRules: {
    shardRule: 'shard k plays pair indices [k * pairsPerShard, (k + 1) * pairsPerShard)',
    designPilot:
      'per variant: development seed 13101101, PILOT_PAIRS pairs per profile, runJointStrengthShard development mode, shard 0; recorded paired-difference standard deviation, kurtosis, time per pair and joint-eligible decisions per pair only (never a mean, never a held-out seed); logs docs/evidence/phase13/pilot-<variant>.json',
    sizingRule: `shards per profile are the fewest for which every gating cell's planned 99% half-width is at most ${HALF_WIDTH_TO_MARGIN} times the variant's regression margin at ${PLANNING_SD_FACTOR} times the pilot deviations, with at least ${MINIMUM_PAIRS_PER_PROFILE_IN_CELL} pairs per profile in every gating cell, subject to the hosted budget (at most ${JOINT_MATRIX_JOB_CEILING} jobs and about ${HOSTED.targetWallHours} hours of wall time at max-parallel ${HOSTED.maxParallel}); where the budget binds, the budget is spent to minimize the widest planned gating half-width and the shortfall is a matter of power, recorded per cell in plannedGatingCells, never of validity`,
    pairsPerShardRule: `pairsPerShard = rotationBlock x k, k the largest whole number keeping the slowest profile under ${HOSTED.maxMinutesPerShard} minutes per shard on a GitHub-hosted runner taken as ${HOSTED.speedupOverPilot} times faster than the pilot container (half the 120-minute job timeout)`,
    jobCeiling: `a variant's requiredShards is at most ${JOINT_MATRIX_JOB_CEILING}, the GitHub Actions limit on jobs from one matrix`,
    kurtosisCheck:
      'every gating cell member has sqrt((pilot kurtosis - 1) / planned pairs) under 0.1 (matrix.plannedGatingCells), so the 10,000-pair floor assumption holds at the planned sizes',
    halfWidthToMargin: HALF_WIDTH_TO_MARGIN,
    planningSdFactor: PLANNING_SD_FACTOR,
    hostedBudget: HOSTED,
    pilotPairs: JOINT_PILOT_PAIRS,
  },
  statistic: {
    unit: 'chip cents per paired hand (exact integers); bb/100 = mean cents / (BB * 100) * 100',
    pairing:
      'one deal seed per pair: identical cards, hero seat, button, seat styles, Pineapple discards, bomb antes and boards and decision clock in both arms; candidate arm then reference arm',
    strata:
      'profile x seed x dealer-relative hero offset x divergence street, exact integer power sums n, S1..S4',
    divergence:
      'street of the first action at which the two arms differ (none, preflop, flop, turn, river; a Pineapple discard belongs to the flop, where it is made); identical action traces with a nonzero difference count as a paired replay mismatch',
    estimator:
      'stratified mean: equal weight per profile among the profiles in a cell, pairs pooled within a profile across seeds and shards',
  },
  interval: {
    method:
      'two-sided 99% normal (Wald) interval on the stratified mean: T +/- z * sqrt(sum w_p^2 s_p^2 / n_p), z = Phi^-1(0.995), s_p^2 the unbiased within-profile variance',
    z: Z99,
    // Phase 10's guard, kept: the first Edgeworth term of a one-sided bound's
    // coverage error, |k|(2z^2 + 1)phi(z)/6, k the skewness of the estimator.
    edgeworthCoverageErrorMax: 0.001,
    minimumPairsPerProfileInCell: MINIMUM_PAIRS_PER_PROFILE_IN_CELL,
  },
  thresholds: {
    primary: {
      gate: "cash_after_rake 99% lower bound > 0 bb/100, the variant's profiles pooled with equal weight",
      lowerBoundAboveBbPer100: 0,
      // Zero is break-even after the house's take; the lower end of a
      // two-sided 99% interval bounds a false promotion at 0.5%. No positive
      // effect-size floor: no calibrated cost of switching exists in source.
    },
    seedReplication: {
      gate: 'each held-out seed block of the variant: pooled stratified point estimate > 0 bb/100',
      pointEstimateAboveBbPer100: 0,
      // Three independent blocks fixed in advance; a zero true effect passes
      // all three with probability 1/8 on top of the primary bound.
    },
    nonregression: {
      gate: "every gating cell 99% lower bound >= the variant's regression margin (packs.<variant>.regressionMargin): -10 bb/100 for the no-limit and pot-limit variants, -4 bb/100 for FLH and FLO8",
      noLimitLowerBoundAtLeastBbPer100: -NO_LIMIT_MARGIN,
      fixedLimitLowerBoundAtLeastBbPer100: -FIXED_LIMIT_MARGIN,
      // Each cell is tested at 99% with no multiplicity relief: all must pass
      // (intersection-union).
    },
  },
  gatingCells: {
    rule: 'per variant: every profile, the six positions, every depth band the variant has and each board count (packs.<variant>.gatingCells.count: 20 for the no-limit and pot-limit variants, 22 for FLH and FLO8)',
    positions: POSITIONS,
    positionRule:
      'positionForOffset(offset, seats), the pack position names; three dealt has button, small blind and big blind; at seven to nine seats the extra offsets are middle; a bomb hand keeps its dealer-relative offset (its action order), though no blind is posted',
    boardCountRule:
      'boards:1 pools every ordinary profile and the one-board bomb hand, boards:2 and boards:3 the two- and three-board bomb hands (the controller activates the requested count at six dealt for every variant)',
    effective:
      "every gating cell holds only pairs of its own domain (no zero padding), so its estimate is the domain mean; its 99% lower bound sits below the true domain mean with probability 99.5%, so a true domain loss of the variant's margin or more fails the gate with at least that probability",
    streetFamilies: {
      gate: false,
      families: ['preflop', 'flop', 'turn', 'river'],
      reported:
        'diagnostic only: each family as its contribution to the pooled bb/100 (zero for pairs that diverged elsewhere), with the share of pairs diverging there; the four contributions and the no-divergence pairs sum exactly to the primary estimate',
      whyNotAGate:
        'a contribution cell is diluted by every pair that did not diverge on its street, and a conditional cell has a run-dependent size and skewness that cannot be planned before the run (the Phase 11 and 12 handling, kept)',
    },
  },
  selectionGuard: {
    owner:
      'HorseLogic joint_policy: an applied Phase 13 candidate the legalizer would rewrite is refused (receipt.applied false, selectionRefusal "illegal_candidate"), and a Phase 13 candidate on top of an applied Phase 10/11/12 candidate is refused ("earlier_phase_applied"); the reference is retained',
    counted:
      'per shard as illegalCandidates and earlierPhaseRefusals (candidate-arm hero decisions refused by the guard), beside changed',
    gate: false,
    why: 'not a strength gate: a refused candidate executes the reference, so the refusal never moves the paired difference. It is a software validity condition instead (softwareValidity.perShard.illegalCandidates and earlierPhaseRefusals must be 0): P13.1 puts every joint candidate in the legalizer form before it is priced, and the harness keeps every earlier phase off, so either refusal on a natural decision means the code measured is not the code P13.1 verified, and the shard is refused by name',
  },
  liveConditions: {
    rule: 'each difference between this harness and a live cash table, with its handling: "addressed" means the harness now matches live play; "named limit" means it does not, and a qualification carries the limit',
    differences: [
      {
        id: 'mood',
        live: 'v9 mood on by default: moodOf(user_id, decisionTimeMs) shifts bluff frequency and aggression by the hour',
        harness:
          'v9 mood on in both arms; decisionTimeMs = jointMoodClockMs(dealSeed) = (dealSeed % 86400) * 1000, identical in both arms',
        handling: 'addressed',
      },
      {
        id: 'style_modifiers',
        live: 'resolveHorseStyle(player.horse_profile, ...).mods (ServerTableEngineTurns.ts), with the self-tuned multipliers',
        harness: 'empty style modifiers {}',
        handling:
          'named limit: the production self-tuned multipliers are per-horse database state, not available offline; no fixed snapshot is source-qualified',
      },
      {
        id: 'horsemind_history',
        live: 'opponent reads from accumulated HorseMind statistics',
        harness: 'a fresh HorseMind.createSandbox() per hand: no opponent history',
        handling:
          'named limit: the joint range sampler conditions on the public action line only, but the reference action the joint owner starts from is HorseLogic, which reads HorseMind, so both arms play without the opponent history they have live',
      },
      {
        id: 'policy_clock_and_sampling',
        live: `the real clock: the joint acquisition stops sampling at ${JOINT_LIVE_DOMAIN.samplingDeadlineMs} ms and refuses below ${JOINT_LIVE_DOMAIN.minSamples} samples (insufficient_joint_samples); the whole proposal falls back to the reference beyond ${JOINT_LIVE_DOMAIN.liveBudgetMs} ms (work_budget); the response tree returns null when the budget expires inside it; and the requested sample count scales with the live equity governor`,
        harness:
          'phase13EvidenceMode: a fixed policy clock (now = 0), EQUITY_GOVERNOR=off at scale 1, so the full requested samples are drawn (16 through four dealt, 8 above), the tree completes, and work_budget never fires',
        handling:
          'named limit: the matrix measures strength only for decisions that complete their fixed work; the live share of eligible decisions that complete without work_budget, insufficient_joint_samples or a response refusal, per street and board count, is measured by P13.3 from natural decisions (admissionAlsoRequires); this container measured the four-millisecond wrapper unable to complete at maximum tables for most variants (P13-A timing table)',
      },
      {
        id: 'response_branch_refusals',
        live: 'a candidate whose tree needs more terminal branches than the pack allows is refused (joint_response_branch_unavailable) and the reference is played',
        harness:
          'the same refusal, counted per shard as responseBranchUnavailable (diagnostic, never a validity failure: the reference is played in both arms)',
        handling: 'addressed',
      },
      {
        id: 'second_look',
        live: 'the decision worker may take a deep second look at a decision',
        harness: 'HorseLogic.decide is called directly, once per decision',
        handling:
          'named limit: the second look is worker scheduling over live read frames, not reproducible offline',
      },
      {
        id: 'earlier_phases',
        live: 'the Phase 10, 11 and 12 policies run in shadow at their live default and are never selected (every protected release selection is null)',
        harness:
          'phase10Plo4, phase11Omaha and phase12Remaining off in every seat and both arms; shadow does not change the executed action, so the reference action is the live action',
        handling: 'addressed',
      },
      {
        id: 'pineapple_discard',
        live: 'the worker chooses each Pineapple discard with HorseLogic.decideDiscard on the live random stream and clock; the controller retains the private dead card',
        harness:
          'HorseLogic.decideDiscard seeded by (deal seed, seat) through the real HandController.performDiscard, identical in both arms',
        handling:
          'design: the discard is not a betting candidate and is the same in both arms, so the paired difference measures the betting policy only',
      },
      {
        id: 'bomb_schedule',
        live: 'a bomb hand arrives by the table trigger (every N hands, once per orbit, timed, bomb only or a manual request), with its own optional bomb button',
        harness:
          'every hand of a bomb profile is a bomb hand at the league button rotation, with the default ante of two big blinds',
        handling:
          'design: the trigger decides only which hands are bomb hands, never how a bomb hand is played or settled; the profile measures the bomb hand itself',
      },
      {
        id: 'field',
        live: 'under activation every cash horse seat of the variant switches together',
        harness: 'one candidate seat against a reference field (every other seat phase13Joint off)',
        handling:
          'design: the only design that measures strength against the horse population as it plays today',
      },
    ],
    admissionAlsoRequires: [
      'natural completion-share evidence for the variant: on the release under admission, the share of eligible live joint decisions that complete without work_budget, insufficient_joint_samples or a joint_response_ refusal, per street and per board count, measured from natural decisions with the release unchanged throughout the window; P13.3 must state and meet its own floor for that share before admitting the variant, because this contract measures strength only for decisions that complete their fixed work',
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
      illegalCandidates: 0,
      earlierPhaseRefusals: 0,
      fixedWork:
        'EQUITY_GOVERNOR off, scale 1, phase13EvidenceMode fixed policy clock, mood clock from the deal seed',
    },
    reportedNotGated: {
      workBudgetRefusals:
        'candidate-arm hero decisions refused as work_budget (expected 0 under the fixed clock; recorded so a nonzero count is visible)',
      responseBranchUnavailable:
        'candidate-arm hero decisions refused as joint_response_branch_unavailable (the reference is played)',
      insufficientSamples:
        'candidate-arm hero decisions refused as insufficient_joint_samples (the reference is played)',
      discards: 'Pineapple discards made in each arm (never betting decisions)',
    },
    settlementReference:
      'settleJointBoardReference (JointBoardReference.ts, the Phase 13 offline multiboard reference): every physical board settled pot by pot with independently built contribution layers and refunds, ranked by the independent Omaha reference (PLO4/5/6/8, FLO8 with high and low halves) or the independent remaining-game reference (NLH and FLH high, Short Deck order and wheel, Pineapple retained pairs with discards and the third card of a seat folded before the discard checked as dead cards); no seat receives more than its independent gross award, losers receive nothing, and the shortfall equals rake plus BBJ drop',
    deductionReference:
      'effectiveRake and effectiveBbjDrop (config/rakeSpec.ts, the arithmetic the database implements) for the variant on the contested pot, ordinary and bomb hands alike',
  },
  notStrengthGates: [
    'joint eligible decision count',
    'changed proposal count',
    'work budget refusal count',
    'response branch refusal count',
  ],
  promotionEligible: false,
});

export type JointStrengthContract = typeof JOINT_STRENGTH_CONTRACT;
type PackSection = JointStrengthContract['packs'][JointStrengthVariant];

/** sha256 of the contract's JSON. Runs, assemblies and qualification files bind it. */
export function jointStrengthContractDigest(): string {
  return createHash('sha256').update(JSON.stringify(JOINT_STRENGTH_CONTRACT)).digest('hex');
}
export function jointStrengthPack(variant: JointStrengthVariant): PackSection {
  if (!isJointStrengthVariant(variant)) throw new Error('Unknown Phase 13 strength variant');
  return JOINT_STRENGTH_CONTRACT.packs[variant];
}
export function jointStrengthDomain(variant: JointStrengthVariant): string {
  return jointStrengthPack(variant).domain;
}
export function jointStrengthProfile(
  variant: JointStrengthVariant,
  id: string
): Readonly<JointStrengthProfile> | undefined {
  if (!isJointStrengthVariant(variant)) return undefined;
  return jointStrengthPack(variant).matrix.profiles.find((p) => p.id === id);
}
/** True for a held-out seed of the named variant. */
export function isJointHoldoutSeedOf(variant: JointStrengthVariant, seed: number): boolean {
  return (
    isJointStrengthVariant(variant) &&
    (jointStrengthPack(variant).holdout.seeds as readonly number[]).includes(seed)
  );
}
/** True for a held-out seed of any Phase 13 variant. */
export function isJointHoldoutSeed(seed: number): boolean {
  return JOINT_STRENGTH_VARIANTS.some((v) => isJointHoldoutSeedOf(v, seed));
}
export function jointStrengthShardKey(profileId: string, seed: number, shard: number) {
  return `${profileId}-${seed}-s${shard}`;
}
/** Every (profile, seed, shard) one variant's matrix requires, in a fixed order. */
export function jointStrengthRequiredShards(variant: JointStrengthVariant) {
  const pack = jointStrengthPack(variant);
  const out: { key: string; variant: string; profileId: string; seed: number; shard: number }[] =
    [];
  for (const p of pack.matrix.profiles)
    for (const seed of pack.matrix.seeds)
      for (let shard = 0; shard < p.shards; shard++)
        out.push({
          key: jointStrengthShardKey(p.id, seed, shard),
          variant,
          profileId: p.id,
          seed,
          shard,
        });
  return out;
}

export const JOINT_DIVERGENCE_STREETS = ['none', 'preflop', 'flop', 'turn', 'river'] as const;
export type JointDivergenceStreet = (typeof JOINT_DIVERGENCE_STREETS)[number];

export interface JointStrengthShardResult {
  schema: 'horse-phase13-strength-shard-v1';
  variant: JointStrengthVariant;
  contractVersion: string;
  contractDigest: string;
  /** The response pack (JOINT_ACTION_PACK.version). */
  packVersion: string;
  domainVersion: string;
  rangePackVersion: string;
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
  /** Candidate-arm hero decisions the joint acquisition admitted. */
  eligible: number;
  /** Candidate-arm hero decisions the joint owner priced and ranked. */
  fired: number;
  /** Candidate-arm hero decisions whose applied proposal reached the table. */
  changed: number;
  /** Candidate-arm hero decisions refused by the illegal_candidate guard. A
   * validity failure when nonzero. */
  illegalCandidates: number;
  /** Candidate-arm hero decisions refused as earlier_phase_applied. A validity
   * failure when nonzero (the harness keeps every earlier phase off). */
  earlierPhaseRefusals: number;
  /** Diagnostic: candidate-arm hero decisions refused as work_budget. */
  workBudgetRefusals: number;
  /** Diagnostic: refused as joint_response_branch_unavailable. */
  responseBranchUnavailable: number;
  /** Diagnostic: refused as insufficient_joint_samples. */
  insufficientSamples: number;
  /** Candidate-arm eligible hero decisions by board count. */
  eligibleByBoards: Record<string, number>;
  /** Pineapple discards made, both arms (zero for the other variants). */
  discards: number;
  illegalActions: number;
  conservationErrors: number;
  cardErrors: number;
  truncatedHands: number;
  settlementMismatches: number;
  deductionMismatches: number;
  pairedReplayMismatches: number;
  showdownsChecked: number;
  /** Showdowns settled on two or three physical boards. */
  multiBoardShowdownsChecked: number;
  foldWinsChecked: number;
  /** Showdowns at which the reference awarded a low half (PLO8 and FLO8). */
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

/** One profile's contribution to a cell: its weight and the selected pairs'
 * sums (n counts every pair in the profile sample; s1..s3 only the selected
 * ones, so unselected pairs enter as zeros where a contribution is measured). */
export interface JointCellGroup {
  profileId: string;
  weight: number;
  n: number;
  s1: bigint;
  s2: bigint;
  s3: bigint;
}
export interface JointCellStatistic {
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
const CENTS_PER_BB = JOINT_STRENGTH_BB * 100;
const toBbPer100 = (cents: number) => (cents / CENTS_PER_BB) * 100;
const phi = (z: number) => Math.exp(-(z * z) / 2) / Math.sqrt(2 * Math.PI);

/** The stratified mean, its exact-sum standard error, the two-sided 99%
 * interval and the interval-validity guards, all from this contract. */
export function jointCellStatistic(cell: string, groups: JointCellGroup[]): JointCellStatistic {
  const c = JOINT_STRENGTH_CONTRACT.interval;
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

const RECORDED = [
  'illegalCandidates',
  'earlierPhaseRefusals',
  'workBudgetRefusals',
  'responseBranchUnavailable',
  'insufficientSamples',
  'discards',
] as const;
/** Reasons a shard cannot enter the named variant's verdict. Empty means it can. */
export function jointStrengthShardReasons(
  variant: JointStrengthVariant,
  r: JointStrengthShardResult
): string[] {
  const c = JOINT_STRENGTH_CONTRACT;
  const pack = jointStrengthPack(variant);
  const key = jointStrengthShardKey(r.profileId, r.seed, r.shard);
  const out: string[] = [];
  const profile = jointStrengthProfile(variant, r.profileId);
  if (r.schema !== 'horse-phase13-strength-shard-v1') out.push(`${key}:schema_mismatch`);
  if (r.variant !== variant) out.push(`${key}:variant_mismatch`);
  if (r.contractVersion !== c.version) out.push(`${key}:contract_version_mismatch`);
  if (r.contractDigest !== jointStrengthContractDigest())
    out.push(`${key}:contract_digest_mismatch`);
  if (r.packVersion !== pack.candidate.packVersion) out.push(`${key}:pack_version_mismatch`);
  if (r.domainVersion !== pack.candidate.domainVersion) out.push(`${key}:domain_version_mismatch`);
  if (r.rangePackVersion !== pack.candidate.rangePackVersion)
    out.push(`${key}:range_pack_version_mismatch`);
  if (r.evidenceMode !== 'contract') out.push(`${key}:not_contract_mode`);
  if (!profile) out.push(`${key}:unknown_profile`);
  if (!isJointHoldoutSeedOf(variant, r.seed)) out.push(`${key}:not_holdout_seed`);
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
      !(JOINT_DIVERGENCE_STREETS as readonly string[]).includes(street)
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
  // Every counter must be recorded; the two guard refusals are validity
  // failures, the rest are diagnostics.
  for (const field of RECORDED)
    if (!Number.isInteger(r[field]) || r[field] < 0) out.push(`${key}:${field}_unrecorded`);
  if (Number.isInteger(r.illegalCandidates) && r.illegalCandidates > 0)
    out.push(`${key}:illegalCandidates`);
  if (Number.isInteger(r.earlierPhaseRefusals) && r.earlierPhaseRefusals > 0)
    out.push(`${key}:earlierPhaseRefusals`);
  if (variant !== 'pineapple' && r.discards !== 0) out.push(`${key}:discards_outside_pineapple`);
  if (
    r.fixedWork?.governor !== 'off' ||
    r.fixedWork?.scale !== 1 ||
    r.fixedWork?.moodClock !== 'deal_seed_time_of_day'
  )
    out.push(`${key}:fixed_work_not_proven`);
  if (r.promotionEligible !== false) out.push(`${key}:shard_claims_promotion`);
  return out;
}

export interface JointStreetDiagnostic extends JointCellStatistic {
  gate: false;
  divergingPairs: number;
}
export interface JointStrengthVerdict {
  variant: JointStrengthVariant;
  packVersion: string;
  domain: string;
  contractVersion: string;
  contractDigest: string;
  qualified: boolean;
  /** Cash failures only; they alone decide `qualified`. */
  reasons: string[];
  cash: {
    qualified: boolean;
    primary: JointCellStatistic | null;
    seeds: JointCellStatistic[];
    profiles: JointCellStatistic[];
    positions: JointCellStatistic[];
    depthBands: JointCellStatistic[];
    boardCounts: JointCellStatistic[];
    gatingCells: number;
    regressionMarginBbPer100: number;
  };
  streetFamiliesDiagnostic: {
    gate: false;
    families: JointStreetDiagnostic[];
    noDivergenceContributionBbPer100: number | null;
  };
  selectionGuard: {
    gate: false;
    illegalCandidates: number;
    earlierPhaseRefusals: number;
    changed: number;
  };
  diagnostics: {
    gate: false;
    eligible: number;
    fired: number;
    workBudgetRefusals: number;
    responseBranchUnavailable: number;
    insufficientSamples: number;
  };
  tournament: { status: string; qualified: false; reasons: readonly string[] };
  shardsUsed: number;
  promotionEligible: false;
}

/** One variant's whole-matrix verdict. Every required shard of that variant
 * must be present exactly once and valid; every gate is evaluated and every
 * failure is named. A shard of another variant is refused by name and never
 * enters a cell. */
export function summarizeJointStrength(
  variant: JointStrengthVariant,
  shards: JointStrengthShardResult[]
): JointStrengthVerdict {
  const c = JOINT_STRENGTH_CONTRACT;
  const pack = jointStrengthPack(variant);
  const reasons: string[] = [];
  const seen = new Map<string, number>();
  const required = jointStrengthRequiredShards(variant);
  const requiredKeys = new Set(required.map((r) => r.key));
  const own: JointStrengthShardResult[] = [];
  for (const s of shards) {
    const key = jointStrengthShardKey(s.profileId, s.seed, s.shard);
    seen.set(key, (seen.get(key) ?? 0) + 1);
    reasons.push(...jointStrengthShardReasons(variant, s));
    if (requiredKeys.has(key) && s.variant === variant) own.push(s);
  }
  for (const r of required) {
    const count = seen.get(r.key) ?? 0;
    if (count === 0) reasons.push(`${r.key}:missing_shard`);
    if (count > 1) reasons.push(`${r.key}:duplicate_shard`);
  }
  for (const key of seen.keys())
    if (!requiredKeys.has(key)) reasons.push(`${key}:unexpected_shard`);

  const sums = new Map<string, Plo4PowerAccumulator>();
  for (const s of own)
    for (const [k, v] of Object.entries(s.strata)) {
      const key = `${s.profileId}|${s.seed}|${k}`;
      const acc = sums.get(key) ?? new Plo4PowerAccumulator();
      acc.merge(v);
      sums.set(key, acc);
    }
  const profiles = pack.matrix.profiles;
  type P = Readonly<JointStrengthProfile>;
  type Pick = (p: P, seed: number, offset: number, street: string) => boolean;
  const group = (p: P, weight: number, inSample: Pick, selected: Pick) => {
    const g: JointCellGroup & { selectedPairs: number } = {
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
    jointCellStatistic(
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
  const depthBands = pack.gatingCells.depthBands.map((band) =>
    equal(
      `depth:${band}`,
      profiles.filter((p) => p.depthBand === band),
      all
    )
  );
  const boardCounts = pack.gatingCells.boardCounts.map((boards) =>
    equal(
      `boards:${boards}`,
      profiles.filter((p) => p.boards === boards),
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
  const margin = pack.regressionMargin.lowerBoundAtLeastBbPer100;
  if (!primary) reasons.push('cash:no_shard_results');
  else {
    if (!primary.intervalTrusted) reasons.push('cash:primary:interval_not_trusted');
    if (!(primary.confidence99BbPer100[0] > t.primary.lowerBoundAboveBbPer100))
      reasons.push('cash:primary:lower_bound_not_above_zero');
  }
  for (const s of seeds)
    if (!(s.meanBbPer100 > t.seedReplication.pointEstimateAboveBbPer100))
      reasons.push(`cash:${s.cell}:point_estimate_not_above_zero`);
  // The gating cells. Street families are diagnostics and never enter here.
  const gating = [...profileCells, ...positions, ...depthBands, ...boardCounts];
  for (const cell of gating) {
    if (!cell.intervalTrusted) reasons.push(`cash:${cell.cell}:interval_not_trusted`);
    if (!(cell.confidence99BbPer100[0] >= margin))
      reasons.push(`cash:${cell.cell}:regression_margin_exceeded`);
  }
  const cashQualified = reasons.length === 0;
  const total = (field: keyof JointStrengthShardResult) =>
    own.reduce((n, s) => n + (Number(s[field]) || 0), 0);
  return {
    variant,
    packVersion: pack.candidate.packVersion,
    domain: pack.domain,
    contractVersion: c.version,
    contractDigest: jointStrengthContractDigest(),
    qualified: cashQualified,
    reasons,
    cash: {
      qualified: cashQualified,
      primary,
      seeds,
      profiles: profileCells,
      positions,
      depthBands,
      boardCounts,
      gatingCells: gating.length,
      regressionMarginBbPer100: margin,
    },
    streetFamiliesDiagnostic: {
      gate: false,
      families,
      noDivergenceContributionBbPer100: noDivergence,
    },
    selectionGuard: {
      gate: false,
      illegalCandidates: total('illegalCandidates'),
      earlierPhaseRefusals: total('earlierPhaseRefusals'),
      changed: total('changed'),
    },
    diagnostics: {
      gate: false,
      eligible: total('eligible'),
      fired: total('fired'),
      workBudgetRefusals: total('workBudgetRefusals'),
      responseBranchUnavailable: total('responseBranchUnavailable'),
      insufficientSamples: total('insufficientSamples'),
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
