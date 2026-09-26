/**
 * Phase 6 Round 1: tournament M and preflop-atlas primitives.
 *
 * This module is deliberately pure. The table engine supplies one immutable
 * tournament snapshot, HorseLogic consumes the resulting policy, and neither
 * path performs IO or consults a network service on the action clock.
 */

import { bigBlindAnteTotal } from './AnteMath.js';

export const TOURNAMENT_CONTEXT_INCOMPLETE = 'TOURNAMENT_CONTEXT_INCOMPLETE' as const;
/** Maintained heuristic revision; release evidence pins the actual source postimage. */
export const TOURNAMENT_PREFLOP_ATLAS_REVISION = 'horse-tournament-preflop-v1' as const;
/** Prefix of every lookup cell string; names the implementation, not a calibration. */
export const TOURNAMENT_PREFLOP_CELL_PREFIX = 'phase6-v1' as const;

/**
 * Every exported domain constant is frozen to its leaves. A caller that holds
 * a reference to a ring, an anchor list or the domain descriptor cannot move
 * the lookup by mutating it; the atlas reads the same arrays it exports.
 */
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

export const TOURNAMENT_CONTEXT_STATUSES = freeze([
  'complete',
  'incomplete',
  'warming',
  'stale',
] as const);
export type TournamentContextStatus = (typeof TOURNAMENT_CONTEXT_STATUSES)[number];

export const TOURNAMENT_ANTE_TYPES = freeze(['none', 'per_player', 'big_blind'] as const);
export type TournamentAnteType = (typeof TOURNAMENT_ANTE_TYPES)[number];

/** Harrington zones in ascending order; `TOURNAMENT_M_ZONE_BOUNDARIES[i]` opens zone i + 1. */
export const TOURNAMENT_M_ZONES = freeze([
  'dead',
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
] as const);
export type TournamentMZone = (typeof TOURNAMENT_M_ZONES)[number];
export const TOURNAMENT_M_ZONE_BOUNDARIES = freeze([1, 5, 10, 20, 40] as const);
/** Half an M of deadband on the one boundary being crossed. */
export const TOURNAMENT_M_HYSTERESIS = 0.5;

export const TOURNAMENT_GAME_FAMILIES = freeze({
  /** The only family whose complete, valid coordinate yields nonzero baseline shifts. */
  supported: ['nlh'],
  /** Explicit atlas entries that never claim NLH coverage for another family. */
  labeled: ['omaha', 'other'],
} as const);
export type TournamentGameFamily =
  | (typeof TOURNAMENT_GAME_FAMILIES.supported)[number]
  | (typeof TOURNAMENT_GAME_FAMILIES.labeled)[number];

export const TOURNAMENT_CORE_DEPTHS = freeze([
  2, 3, 4, 5, 6, 8, 10, 12, 15, 18, 20, 25, 30, 40, 60, 80, 100,
] as const);
const DEPTH_MIN_BB = TOURNAMENT_CORE_DEPTHS[0];
const DEPTH_MAX_BB = TOURNAMENT_CORE_DEPTHS[TOURNAMENT_CORE_DEPTHS.length - 1];
/** The pure helper's stand-in for a non-finite depth; live admission rejects such input upstream. */
const DEPTH_NON_FINITE_HELPER_DEFAULT_BB = 20;
const SHIFT_ROUNDING_DECIMALS = 5;
const VELOCITY_URGENCY_ROUNDING_DECIMALS = 3;
const VELOCITY_URGENCY_DIVISOR_M_PER_MINUTE = 2;

export const TOURNAMENT_TABLE_SIZES = freeze([2, 3, 4, 5, 6, 7, 8, 9, 10] as const);
const PLAYERS_MIN = TOURNAMENT_TABLE_SIZES[0];
const PLAYERS_MAX = TOURNAMENT_TABLE_SIZES[TOURNAMENT_TABLE_SIZES.length - 1];
/** Effective M scales real M by dealt players over this denominator. */
const EFFECTIVE_M_SCALE_DENOMINATOR = 10;

export const TOURNAMENT_POSITIONS = freeze([
  'UTG',
  'UTG1',
  'UTG2',
  'UTG3',
  'MP',
  'HJ',
  'CO',
  'BTN',
  'SB',
  'BB',
] as const);

export type TournamentPosition = (typeof TOURNAMENT_POSITIONS)[number];

export const TOURNAMENT_PREFLOP_BRANCHES = freeze([
  'unopened',
  'limp_facing',
  'open_facing',
  'three_bet_facing',
  'cold_call',
  'overcall',
  'squeeze',
  'reshove',
  'blind_vs_blind',
  'bb_defense',
  'multiway_all_in',
] as const);

export type TournamentPreflopBranch = (typeof TOURNAMENT_PREFLOP_BRANCHES)[number];
export type TournamentAtlasSource = 'deterministic_baseline' | 'labeled_fallback';

/** Fallback labels in the order the lookup tests them; the first true reason wins. */
export const TOURNAMENT_FALLBACK_PRECEDENCE = freeze([
  'invalid_coordinate',
  'unsupported_variant',
  'incomplete_context',
] as const);
export type TournamentFallbackReason = (typeof TOURNAMENT_FALLBACK_PRECEDENCE)[number];

/**
 * The next-level projection gate as HorseLogic and HorsePreflop apply it:
 * `nextBlindInMin <= maxMinutes` and `nextBlindMult > minMultiplierExclusive`.
 * Those consumers keep their own literals; the Phase 6 tournament domain
 * tests hold them to these values at the boundary.
 */
export const TOURNAMENT_NEXT_LEVEL_PROJECTION_GATE = freeze({
  maxMinutes: 3,
  minMultiplierExclusive: 1.15,
} as const);

export interface TournamentMState {
  schemaVersion: 1;
  orbitCostChips: number;
  realM: number;
  effectiveM: number;
  projectedOrbitCostChips: number;
  projectedM: number;
  projectedEffectiveM: number;
  /** Hero depth in next-level big blinds, distinct from orbit-cost M. */
  projectedStackBB: number;
  velocityMPerMinute: number;
  /** Real M for the smallest stack that can cover hero, retained for policy consumers. */
  coveringOpponentM: number | null;
  /** Every live opponent whose total stack can cover hero, never the players hero covers. */
  coveringOpponents: Array<{
    userId: string;
    stackChips: number;
    realM: number;
    effectiveM: number;
  }>;
  zone: TournamentMZone;
  previousZone: TournamentMZone | null;
}

export interface TournamentMInput {
  stackChips: number;
  smallBlind: number;
  bigBlind: number;
  ante: number;
  anteType: TournamentAnteType;
  playersAtTable: number;
  nextSmallBlind?: number | null;
  nextBigBlind?: number | null;
  nextAnte?: number | null;
  minutesToNextLevel?: number | null;
  opponentStacks?: Array<{ userId: string; stackChips: number }>;
  previousZone?: TournamentMZone | null;
}

export interface TournamentDepthBracket {
  lower: (typeof TOURNAMENT_CORE_DEPTHS)[number];
  upper: (typeof TOURNAMENT_CORE_DEPTHS)[number];
  weight: number;
}

export interface TournamentPreflopPolicyInput {
  gameFamily: TournamentGameFamily;
  contextStatus: TournamentContextStatus;
  tableSize: number;
  heroPosition: TournamentPosition;
  raiserPosition: TournamentPosition | null;
  anteType: TournamentAnteType;
  branch: TournamentPreflopBranch;
  stackBB: number;
  m?: TournamentMState;
}

export interface TournamentPreflopPolicy {
  schemaVersion: 1;
  cell: string;
  source: TournamentAtlasSource;
  fallbackReason: TournamentFallbackReason | null;
  branch: TournamentPreflopBranch;
  depth: TournamentDepthBracket;
  /** Additive movements in the HorsePreflop strength-score scale. */
  shifts: {
    open: number;
    jam: number;
    call: number;
    threeBet: number;
    fourBet: number;
  };
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
const finiteNonNegative = (n: number | null | undefined): number =>
  Number.isFinite(n) && (n as number) > 0 ? (n as number) : 0;

function orbitCost(
  smallBlind: number,
  bigBlind: number,
  ante: number,
  anteType: TournamentAnteType,
  playersAtTable: number
): number {
  const blinds = finiteNonNegative(smallBlind) + finiteNonNegative(bigBlind);
  const cleanAnte = finiteNonNegative(ante);
  const anteCost =
    anteType === 'per_player'
      ? cleanAnte * clamp(Math.floor(playersAtTable), PLAYERS_MIN, PLAYERS_MAX)
      : anteType === 'big_blind'
        ? bigBlindAnteTotal(cleanAnte, playersAtTable, bigBlind)
        : 0;
  return blinds + anteCost;
}

/** Standard Harrington zones, with an optional Schmitt-trigger prior. */
export function tournamentMZone(
  effectiveM: number,
  previousZone?: TournamentMZone | null
): TournamentMZone {
  const m = Math.max(0, Number.isFinite(effectiveM) ? effectiveM : 0);
  const boundaries = TOURNAMENT_M_ZONE_BOUNDARIES;
  const zones: readonly TournamentMZone[] = TOURNAMENT_M_ZONES;
  let candidate = zones[boundaries.findIndex((boundary) => m < boundary)];
  if (!candidate) candidate = 'blue';
  if (!previousZone) return candidate;

  const previousIndex = zones.indexOf(previousZone);
  const candidateIndex = zones.indexOf(candidate);
  if (previousIndex < 0 || candidateIndex === previousIndex) return candidate;

  // Hysteresis belongs only to the boundary being crossed. A genuine jump
  // across two or more zones (for example after a blind increase) must not
  // preserve a wildly obsolete prior zone.
  if (Math.abs(candidateIndex - previousIndex) > 1) return candidate;

  // A half-M deadband means a single chip cannot bounce a horse back and
  // forth across a zone boundary. The prior zone itself travels in the
  // canonical decision snapshot, so worker replay sees the same state.
  const margin = TOURNAMENT_M_HYSTERESIS;
  if (candidateIndex > previousIndex) {
    const improveBoundary = boundaries[Math.min(previousIndex, boundaries.length - 1)];
    return m >= improveBoundary + margin ? candidate : previousZone;
  }
  const worsenBoundary = boundaries[Math.min(candidateIndex, boundaries.length - 1)];
  return m < worsenBoundary - margin ? candidate : previousZone;
}

/** Compute every M quantity from chips, never from a guessed BB multiple. */
export function buildTournamentMState(input: TournamentMInput): TournamentMState {
  const players = clamp(Math.floor(input.playersAtTable || 0), PLAYERS_MIN, PLAYERS_MAX);
  const currentOrbit = orbitCost(
    input.smallBlind,
    input.bigBlind,
    input.ante,
    input.anteType,
    players
  );
  const stack = Math.max(0, Number(input.stackChips) || 0);
  const realM = currentOrbit > 0 ? stack / currentOrbit : 0;
  const shortHandedScale = players / EFFECTIVE_M_SCALE_DENOMINATOR;
  const effectiveM = realM * shortHandedScale;

  const hasNext =
    finiteNonNegative(input.nextSmallBlind) > 0 && finiteNonNegative(input.nextBigBlind) > 0;
  const projectedOrbit = hasNext
    ? orbitCost(
        input.nextSmallBlind as number,
        input.nextBigBlind as number,
        input.nextAnte ?? input.ante,
        input.anteType,
        players
      )
    : currentOrbit;
  const projectedM = projectedOrbit > 0 ? stack / projectedOrbit : realM;
  const projectedEffectiveM = projectedM * shortHandedScale;
  const projectedStackBB =
    finiteNonNegative(input.nextBigBlind) > 0
      ? stack / (input.nextBigBlind as number)
      : finiteNonNegative(input.bigBlind) > 0
        ? stack / input.bigBlind
        : 0;
  const minutes = finiteNonNegative(input.minutesToNextLevel);
  const velocityMPerMinute =
    minutes > 0 ? Math.max(0, effectiveM - projectedEffectiveM) / minutes : 0;

  const coveringOpponents = (input.opponentStacks ?? [])
    .map((opponent) => ({
      userId: String(opponent.userId || ''),
      stackChips: Math.max(0, Number(opponent.stackChips) || 0),
    }))
    .filter(
      (opponent) =>
        opponent.userId.length > 0 && opponent.stackChips > 0 && opponent.stackChips >= stack
    )
    .sort(
      (left, right) =>
        left.stackChips - right.stackChips ||
        (left.userId < right.userId ? -1 : left.userId > right.userId ? 1 : 0)
    )
    .map((opponent) => ({
      ...opponent,
      realM: currentOrbit > 0 ? opponent.stackChips / currentOrbit : 0,
      effectiveM: currentOrbit > 0 ? (opponent.stackChips / currentOrbit) * shortHandedScale : 0,
    }));
  const coveringOpponentM = coveringOpponents[0]?.realM ?? null;
  const previousZone = input.previousZone ?? null;

  return {
    schemaVersion: 1,
    orbitCostChips: currentOrbit,
    realM,
    effectiveM,
    projectedOrbitCostChips: projectedOrbit,
    projectedM,
    projectedEffectiveM,
    projectedStackBB,
    velocityMPerMinute,
    coveringOpponentM,
    coveringOpponents,
    zone: tournamentMZone(effectiveM, previousZone),
    previousZone,
  };
}

export function interpolateTournamentDepth(stackBB: number): TournamentDepthBracket {
  const depth = clamp(
    Number.isFinite(stackBB) ? stackBB : DEPTH_NON_FINITE_HELPER_DEFAULT_BB,
    DEPTH_MIN_BB,
    DEPTH_MAX_BB
  );
  for (let index = 0; index < TOURNAMENT_CORE_DEPTHS.length; index++) {
    const lower = TOURNAMENT_CORE_DEPTHS[index];
    if (depth === lower || index === TOURNAMENT_CORE_DEPTHS.length - 1) {
      return { lower, upper: lower, weight: 0 };
    }
    const upper = TOURNAMENT_CORE_DEPTHS[index + 1];
    if (depth < upper) return { lower, upper, weight: (depth - lower) / (upper - lower) };
  }
  return { lower: 100, upper: 100, weight: 0 };
}

const POSITION_BY_CLOCKWISE_INDEX: Record<number, readonly TournamentPosition[]> = freeze({
  2: ['SB', 'BB'],
  3: ['SB', 'BB', 'BTN'],
  4: ['SB', 'BB', 'CO', 'BTN'],
  5: ['SB', 'BB', 'HJ', 'CO', 'BTN'],
  6: ['SB', 'BB', 'UTG', 'HJ', 'CO', 'BTN'],
  7: ['SB', 'BB', 'UTG', 'MP', 'HJ', 'CO', 'BTN'],
  8: ['SB', 'BB', 'UTG', 'UTG1', 'MP', 'HJ', 'CO', 'BTN'],
  9: ['SB', 'BB', 'UTG', 'UTG1', 'UTG2', 'MP', 'HJ', 'CO', 'BTN'],
  10: ['SB', 'BB', 'UTG', 'UTG1', 'UTG2', 'UTG3', 'MP', 'HJ', 'CO', 'BTN'],
});
/** The pure ring helper's stand-in for a non-finite size; the lookup itself labels that invalid. */
const RING_NON_FINITE_HELPER_DEFAULT_SIZE = 9;

export function tournamentPositionsForTable(tableSize: number): readonly TournamentPosition[] {
  const normalized = Number.isFinite(tableSize)
    ? clamp(Math.floor(tableSize), PLAYERS_MIN, PLAYERS_MAX)
    : RING_NON_FINITE_HELPER_DEFAULT_SIZE;
  return POSITION_BY_CLOCKWISE_INDEX[normalized];
}

/**
 * The machine-readable domain of the maintained NLH tournament preflop atlas.
 *
 * Read-only evidence built from the same arrays the lookup reads; it is not a
 * policy-authority token, it adds no cells, and it never claims calibration
 * or solver coverage. Depth outside the anchor grid is an approximation
 * (a clamp to the nearest endpoint), stated here rather than hidden. A valid
 * algebraic coordinate says nothing about whether a real betting history
 * reaches it. Any deliberate change to the domain changes
 * `TOURNAMENT_PREFLOP_ATLAS_DOMAIN_DIGEST` alongside it.
 */
export const TOURNAMENT_PREFLOP_ATLAS_DOMAIN = freeze({
  schemaVersion: 1,
  atlasRevision: TOURNAMENT_PREFLOP_ATLAS_REVISION,
  implementation: TOURNAMENT_PREFLOP_CELL_PREFIX,
  gameFamilies: TOURNAMENT_GAME_FAMILIES,
  contextStatuses: {
    baseline: TOURNAMENT_CONTEXT_STATUSES.filter((status) => status === 'complete'),
    fallback: TOURNAMENT_CONTEXT_STATUSES.filter((status) => status !== 'complete'),
  },
  tableSizes: TOURNAMENT_TABLE_SIZES,
  positionsBySize: POSITION_BY_CLOCKWISE_INDEX,
  positions: TOURNAMENT_POSITIONS,
  branches: TOURNAMENT_PREFLOP_BRANCHES,
  anteTypes: TOURNAMENT_ANTE_TYPES,
  depth: {
    anchorsBB: TOURNAMENT_CORE_DEPTHS,
    minBB: DEPTH_MIN_BB,
    maxBB: DEPTH_MAX_BB,
    belowMin: `clamp_to_${DEPTH_MIN_BB}_approximation`,
    aboveMax: `clamp_to_${DEPTH_MAX_BB}_approximation`,
    nonFiniteHelperDefaultBB: DEPTH_NON_FINITE_HELPER_DEFAULT_BB,
    shiftRoundingDecimals: SHIFT_ROUNDING_DECIMALS,
    velocityUrgencyRoundingDecimals: VELOCITY_URGENCY_ROUNDING_DECIMALS,
  },
  m: {
    zoneBoundaries: TOURNAMENT_M_ZONE_BOUNDARIES,
    zones: TOURNAMENT_M_ZONES,
    hysteresisM: TOURNAMENT_M_HYSTERESIS,
    multiZoneJumpBypassesHysteresis: true,
    playersClamp: { min: PLAYERS_MIN, max: PLAYERS_MAX },
    effectiveScaleDenominator: EFFECTIVE_M_SCALE_DENOMINATOR,
    velocityUrgencyDivisorMPerMinute: VELOCITY_URGENCY_DIVISOR_M_PER_MINUTE,
    projection: TOURNAMENT_NEXT_LEVEL_PROJECTION_GATE,
  },
  fallbackPrecedence: TOURNAMENT_FALLBACK_PRECEDENCE,
  /** Valid (size, hero, raiser-or-none) pairs times antes, branches and anchors. */
  totalValidCoordinates:
    TOURNAMENT_TABLE_SIZES.reduce((sum, size) => sum + size * size, 0) *
    TOURNAMENT_ANTE_TYPES.length *
    TOURNAMENT_PREFLOP_BRANCHES.length *
    TOURNAMENT_CORE_DEPTHS.length,
});

/**
 * Canonical JSON: object keys sorted at every level, arrays in order, no
 * whitespace, undefined members omitted. Stable across engines so a digest of
 * the domain means the same bytes everywhere.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${members.join(',')}}`;
}

/**
 * sha256 of `canonicalJson(TOURNAMENT_PREFLOP_ATLAS_DOMAIN)`, pinned as a
 * literal. The Phase 6 tournament domain test recomputes it; editing the
 * domain therefore requires editing this line on purpose.
 */
export const TOURNAMENT_PREFLOP_ATLAS_DOMAIN_DIGEST =
  '4a8918a0f015e9e96b31dc63e0a7ab45eca503698c514c82f55627bec7864305' as const;

/** Exact seat label from the dealt-in ring, including the HU button/SB rule. */
export function tournamentPositionForSeat(
  heroSeat: number,
  dealerSeat: number | undefined,
  dealtInSeats: number[]
): TournamentPosition {
  const seats = [...new Set(dealtInSeats.filter(Number.isFinite))].sort((a, b) => a - b);
  if (dealerSeat === undefined || !seats.includes(heroSeat) || seats.length < 2) return 'MP';
  if (seats.length === 2) return heroSeat === dealerSeat ? 'SB' : 'BB';

  const order: number[] = [];
  let cursor = dealerSeat;
  for (let index = 0; index < seats.length; index++) {
    const next = seats.find((seat) => seat > cursor) ?? seats[0];
    order.push(next);
    cursor = next;
  }
  const positionOrder = tournamentPositionsForTable(order.length);
  return positionOrder[order.indexOf(heroSeat)] ?? 'MP';
}

export interface TournamentBranchInput {
  raises: number;
  limpers: number;
  callers: number;
  callersOfPreviousRaise: number;
  opponentsAllIn: number;
  opponentsLeft: number;
  stackBB: number;
  mZone?: TournamentMZone;
  heroPosition: TournamentPosition;
  raiserPosition: TournamentPosition | null;
  heroPreviouslyActed: boolean;
  heroWasInitialRaiser: boolean;
  squeezed: boolean;
}

/** Name the exact preflop node before choosing an action. */
export function classifyTournamentPreflopBranch(
  input: TournamentBranchInput
): TournamentPreflopBranch {
  if (
    input.opponentsAllIn >= 2 ||
    (input.opponentsAllIn >= 1 &&
      (input.callers >= 1 || (input.raises >= 1 && input.opponentsLeft >= 2)))
  ) {
    return 'multiway_all_in';
  }
  if (input.squeezed || (input.raises >= 2 && input.heroWasInitialRaiser)) {
    return 'three_bet_facing';
  }
  const heroBlind = input.heroPosition === 'SB' || input.heroPosition === 'BB';
  const raiserBlind = input.raiserPosition === 'SB' || input.raiserPosition === 'BB';
  if (heroBlind && input.opponentsLeft === 1 && (input.raises === 0 || raiserBlind)) {
    return input.heroPosition === 'BB' && input.raises > 0 ? 'bb_defense' : 'blind_vs_blind';
  }
  if (input.raises === 0) return input.limpers > 0 ? 'limp_facing' : 'unopened';
  if (input.raises >= 2) return 'three_bet_facing';
  const reshovePressure =
    input.mZone === 'dead' ||
    input.mZone === 'red' ||
    input.mZone === 'orange' ||
    input.mZone === 'yellow';
  if (input.callers > 0) {
    // M-zone hysteresis owns the live reshove transition. A raw 25.00/25.01bb
    // split changed the entire action plan on one chip and defeated the
    // interpolation guarantee.
    if (reshovePressure) return 'reshove';
    return ['CO', 'BTN', 'SB', 'BB'].includes(input.heroPosition) ? 'squeeze' : 'overcall';
  }
  if (reshovePressure && ['HJ', 'CO', 'BTN', 'SB'].includes(input.raiserPosition ?? 'UTG')) {
    return 'reshove';
  }
  if (input.heroPosition === 'BB') return 'bb_defense';
  return input.heroPreviouslyActed ? 'open_facing' : 'cold_call';
}

interface PolicyShiftSet {
  open: number;
  jam: number;
  call: number;
  threeBet: number;
  fourBet: number;
}

const ZERO_SHIFTS: PolicyShiftSet = { open: 0, jam: 0, call: 0, threeBet: 0, fourBet: 0 };

const VELOCITY_URGENCY_ROUNDING = 10 ** VELOCITY_URGENCY_ROUNDING_DECIMALS;
const SHIFT_ROUNDING = 10 ** SHIFT_ROUNDING_DECIMALS;

function velocityUrgency(m: TournamentMState | undefined): number {
  return (
    Math.round(
      clamp((m?.velocityMPerMinute ?? 0) / VELOCITY_URGENCY_DIVISOR_M_PER_MINUTE, 0, 1) *
        VELOCITY_URGENCY_ROUNDING
    ) / VELOCITY_URGENCY_ROUNDING
  );
}

function anchorShifts(input: TournamentPreflopPolicyInput, depth: number): PolicyShiftSet {
  // Other games keep their existing deterministic variant engines. Their atlas
  // entry is explicit, but it never masquerades as an NLH solver cell.
  if (input.gameFamily !== 'nlh') return ZERO_SHIFTS;

  const short = clamp((20 - depth) / 18, 0, 1);
  const deep = clamp((depth - 40) / 60, 0, 1);
  const tableWiden = clamp((9 - input.tableSize) * 0.004, -0.004, 0.028);
  const anteWiden = input.anteType === 'none' ? 0 : input.anteType === 'big_blind' ? 0.012 : 0.018;
  const stealPosition = ['CO', 'BTN', 'SB'].includes(input.heroPosition);
  const earlyRaiser = ['UTG', 'UTG1', 'UTG2', 'UTG3', 'MP'].includes(input.raiserPosition ?? 'BTN');
  const lateRaiser = ['CO', 'BTN', 'SB'].includes(input.raiserPosition ?? 'UTG');
  const shifts: PolicyShiftSet = { ...ZERO_SHIFTS };

  switch (input.branch) {
    case 'unopened':
      shifts.open =
        (stealPosition ? -0.018 : input.heroPosition === 'UTG' ? 0.012 : 0) -
        tableWiden -
        anteWiden;
      shifts.jam = -0.035 * short - tableWiden - anteWiden;
      break;
    case 'limp_facing':
      shifts.open = (stealPosition ? -0.025 : 0.008) - tableWiden - anteWiden;
      shifts.call = 0.012;
      break;
    case 'blind_vs_blind':
      shifts.open = -0.045 - anteWiden;
      shifts.jam = -0.04 * short - anteWiden;
      shifts.call = -0.025;
      shifts.threeBet = -0.025;
      break;
    case 'bb_defense':
      shifts.call = lateRaiser ? -0.04 - anteWiden : 0.005;
      shifts.threeBet = lateRaiser ? -0.018 : 0.012;
      break;
    case 'reshove':
      shifts.jam = (earlyRaiser ? 0.025 : -0.025) - 0.04 * short - anteWiden;
      shifts.call = 0.02;
      break;
    case 'squeeze':
      shifts.threeBet = (earlyRaiser ? 0.018 : -0.02) - 0.5 * anteWiden;
      shifts.call = 0.02;
      break;
    case 'overcall':
      shifts.call = 0.035 + (earlyRaiser ? 0.018 : 0) + 0.015 * short;
      shifts.threeBet = 0.012;
      break;
    case 'multiway_all_in':
      shifts.call = 0.09 + 0.02 * short;
      shifts.jam = 0.07;
      shifts.threeBet = 0.06;
      shifts.fourBet = 0.05;
      break;
    case 'three_bet_facing':
      shifts.call = 0.015 + 0.02 * deep;
      shifts.fourBet = 0.01 + 0.025 * deep;
      break;
    case 'open_facing':
      shifts.call = (earlyRaiser ? 0.025 : lateRaiser ? -0.012 : 0) + 0.01 * short;
      shifts.threeBet = earlyRaiser ? 0.025 : lateRaiser ? -0.015 : 0;
      break;
    case 'cold_call':
      // A true cold caller still has uncapped players behind. Require a
      // little more than the heads-up/open-facing node rather than cloning it.
      shifts.call = (earlyRaiser ? 0.037 : lateRaiser ? 0.002 : 0.012) + 0.015 * short;
      shifts.threeBet = earlyRaiser ? 0.028 : lateRaiser ? -0.002 : 0.008;
      break;
  }

  if (input.m && input.m.velocityMPerMinute > 0) {
    const urgency = velocityUrgency(input.m);
    shifts.open -= 0.012 * urgency;
    shifts.jam -= 0.02 * urgency;
  }
  return shifts;
}

function interpolateShift(lower: number, upper: number, weight: number): number {
  return Math.round((lower + (upper - lower) * weight) * SHIFT_ROUNDING) / SHIFT_ROUNDING;
}

/** A total lookup: every supported coordinate returns a policy or a labeled fallback. */
export function tournamentPreflopPolicy(
  input: TournamentPreflopPolicyInput
): TournamentPreflopPolicy {
  const rawTableSize = Number(input.tableSize);
  const tableSize = clamp(Math.floor(rawTableSize || 0), PLAYERS_MIN, PLAYERS_MAX);
  const depth = interpolateTournamentDepth(input.stackBB);
  const allowedPositions = POSITION_BY_CLOCKWISE_INDEX[tableSize] ?? [];
  const validCoordinate =
    Number.isSafeInteger(rawTableSize) &&
    rawTableSize === tableSize &&
    allowedPositions.includes(input.heroPosition) &&
    (input.raiserPosition === null ||
      (input.raiserPosition !== input.heroPosition &&
        allowedPositions.includes(input.raiserPosition)));
  const supported = input.gameFamily === 'nlh';
  const complete = input.contextStatus === 'complete';
  const baseline = supported && complete && validCoordinate;
  const lower = baseline ? anchorShifts({ ...input, tableSize }, depth.lower) : ZERO_SHIFTS;
  const upper = baseline ? anchorShifts({ ...input, tableSize }, depth.upper) : ZERO_SHIFTS;
  const shifts: PolicyShiftSet = {
    open: interpolateShift(lower.open, upper.open, depth.weight),
    jam: interpolateShift(lower.jam, upper.jam, depth.weight),
    call: interpolateShift(lower.call, upper.call, depth.weight),
    threeBet: interpolateShift(lower.threeBet, upper.threeBet, depth.weight),
    fourBet: interpolateShift(lower.fourBet, upper.fourBet, depth.weight),
  };
  const source: TournamentAtlasSource = baseline ? 'deterministic_baseline' : 'labeled_fallback';
  const fallbackReason = !validCoordinate
    ? 'invalid_coordinate'
    : !supported
      ? 'unsupported_variant'
      : !complete
        ? 'incomplete_context'
        : null;
  const cell = [
    TOURNAMENT_PREFLOP_CELL_PREFIX,
    input.gameFamily,
    source,
    validCoordinate ? tableSize : `invalid-${String(input.tableSize)}`,
    input.heroPosition,
    input.raiserPosition ?? 'NONE',
    input.anteType,
    input.branch,
    `${depth.lower}-${depth.upper}@${depth.weight}`,
    `velocity=${velocityUrgency(input.m)}`,
  ].join(':');

  return {
    schemaVersion: 1,
    cell,
    source,
    fallbackReason,
    branch: input.branch,
    depth,
    shifts,
  };
}
