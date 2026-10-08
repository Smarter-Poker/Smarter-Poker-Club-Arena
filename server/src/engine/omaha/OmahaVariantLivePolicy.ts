import {
  sampleOmahaVariantEquity,
  type OmahaVariantTerminalShowdowns,
} from './OmahaVariantSampler.js';
import {
  omahaVariantActionEconomics,
  omahaVariantActionEconomicsIsValid,
  OMAHA_VARIANT_NET_ACTION_BUDGET_MS,
  type OmahaVariantActionEconomics,
} from './OmahaVariantActionEconomics.js';
import type { HorseDecision, SeatPlayer } from '../../types.js';
import type { HorseGameStateV2 } from '../HorseLogic.js';
import { omahaNutStatus } from '../HorseEval.js';
import { omahaCardFacts } from './OmahaCardFacts.js';
import { calculateContestablePot, calculateRake } from '../PokerEngine.js';
import { horsePolicyDealtPlayers } from '../multiway/DealtSeatCensus.js';
import { horseCanonicalMaterialSha256 } from '../HorseTournamentUtilityEvidence.js';
// Shared public seat/action geometry and legal choice kernel. No Phase 10
// hand-quality model, entry threshold or equity calibration is imported.
import {
  plo4BlindSeatsStatus,
  plo4ButtonOffset,
  plo4CanonicalPosition,
  plo4DealerSeatIsValid,
  plo4PreflopChoice,
  plo4Role,
  plo4SelectionOf,
  type Plo4BlindSeats,
  type Plo4Selection,
} from '../plo4/Plo4LivePolicy.js';
import { PLO4_POSITIONS, PLO4_POSTFLOP_ROLES, PLO4_PREFLOP_ROLES } from '../plo4/Plo4PolicyPack.js';
import {
  isOmahaPolicyVariant,
  OMAHA_VARIANT_PACKS,
  OMAHA_VARIANT_DOMAIN,
  omahaVariantHandShape,
  omahaVariantEntryBars,
  omahaVariantSeatCap,
  type OmahaPolicyPosition,
  type OmahaPolicyRole,
  type OmahaPolicyVariant,
} from './OmahaVariantPolicyPack.js';
import {
  validOmahaVariantEquity,
  type OmahaVariantEquityEvidence,
  type OmahaVariantRangeProvenance,
} from './OmahaVariantEquity.js';

export type OmahaVariantMode = 'off' | 'shadow' | 'candidate';

/** P11.1: the PLO4 range-status vocabulary, applied to the variant sampler. */
export type OmahaVariantRangeStatus =
  | 'not_consumed_preflop'
  | 'unavailable'
  | 'rejected_malformed'
  | 'rejected_population'
  | 'consumed_unattributed'
  | 'consumed';

/**
 * P11.1: the facts a PLO5, PLO6 or PLO8 proposal actually consumed, copied and
 * frozen when it was computed. A private receipt field: never public state or
 * telemetry. The census, positions, geometry and depth have the same meaning
 * as the Phase 10 binding (plo4-input-binding-v2): positions are derived from
 * the blind seats the engine posted, never inferred from the button alone.
 * Variant-specific: the pack's own seat ceiling for the table's mode, the
 * hand-shape scores (entry scores, not probabilities), the split-pot board
 * fact and the variant sampler's own range provenance and pot-share numbers.
 */
export interface OmahaVariantInputBinding {
  readonly version: 'omaha-variant-input-binding-v1';
  readonly variant: OmahaPolicyVariant;
  readonly pack: Readonly<{
    version: string;
    holes: 4 | 5 | 6;
    splitPot: boolean;
    source: 'explicit_variant_heuristic';
    calibratedConfidence: null;
    /** [2, the seat ceiling for this table's mode]. */
    seats: readonly [number, number];
    seatCapOwner: 'cash_table_seating' | 'tournament_deck_capacity';
    maxStackBB: number;
    maxAnteBB: number;
    maxRakePercent: number;
  }>;
  readonly approximation: Readonly<{
    status:
      | 'explicit_variant_heuristic'
      | 'explicit_variant_heuristic_with_uncalibrated_range_sample';
    solverInput: false;
    handShape: Readonly<{
      score: number;
      highScore: number;
      /** PLO8 only; null for the high-only packs. */
      lowScore: number | null;
      kind: 'heuristic_entry_score';
      probability: false;
    }>;
  }>;
  readonly census: Readonly<{
    source: 'dealt_seat_ids' | 'legacy_player_list';
    dealerSeat: number;
    heroSeat: number;
    dealtSeats: readonly number[];
    blindSeats: Plo4BlindSeats;
    contestingOpponentSeats: readonly number[];
    actingOpponentSeats: readonly number[];
    foldedSeats: readonly number[];
    awaySeats: readonly number[];
    allInSeats: readonly number[];
  }>;
  readonly positions: Readonly<{
    hero: OmahaPolicyPosition;
    heroOffset: number;
    role: OmahaPolicyRole;
    aggressor: OmahaPolicyPosition | null;
    aggressorSeat: number | null;
    straddle: 'table_enabled_utg_2bb' | 'none';
  }>;
  readonly geometry: Readonly<{
    bettingStructure: 'pot_limit';
    chipUnit: 0.01 | 1;
    bigBlind: number;
    pot: number;
    currentBet: number;
    heroBet: number;
    heroStack: number;
    callCost: number;
    minRaiseTo: number | null;
    maxRaiseTo: number | null;
    potLimitRaiseTo: number;
    stackRaiseTo: number;
    wagerCap: number | null;
    ante: number;
    anteBB: number;
    rake: Readonly<{
      percent: number;
      cap: number;
      noFlopNoDrop: boolean;
      playerCountCaps: ReadonlyArray<Readonly<{ players: number; cap: number }>> | null;
      dealtCount: number;
    }>;
    postflop: Readonly<{
      contestablePot: number;
      eligibleAfterCall: number;
      chargedRake: number;
      netPotAfterCall: number;
      callPrice: number;
      spr: number;
    }> | null;
  }>;
  readonly depth: Readonly<{
    effectiveBB: number;
    heroCoverBB: number;
    deepestOpponentCoverBB: number;
    basis: 'stack_plus_street_bet_vs_deepest_contesting_opponent';
  }>;
  readonly board: Readonly<{
    street: 'preflop' | 'flop' | 'turn' | 'river';
    cards: number;
    paired: boolean | null;
    flushBoard: boolean | null;
    /** PLO8 postflop: whether a qualifying low can still be made. */
    lowPossible: boolean | null;
    features: readonly string[];
  }>;
  readonly range: Readonly<{
    status: OmahaVariantRangeStatus;
    equity: number | null;
    highEquity: number | null;
    lowEquity: number | null;
    samples: number | null;
    standardError: number | null;
    confidence99: readonly [number, number] | null;
    scoopProbability: number | null;
    quarterOrLessProbability: number | null;
    sixthOrLessProbability: number | null;
    pots: number | null;
    decisionEquityCeiling: number | null;
    provenance: OmahaVariantRangeProvenance | null;
  }>;
}

export interface OmahaVariantReceipt {
  version: string;
  variant: string;
  mode: OmahaVariantMode;
  eligible: boolean;
  fired: boolean;
  changed: boolean;
  applied: boolean;
  reason: string;
  street: string;
  position: OmahaPolicyPosition | null;
  aggressorPosition: OmahaPolicyPosition | null;
  role: OmahaPolicyRole | null;
  depthBB: number | null;
  confidence: 'explicit_variant_heuristic' | 'range_sample' | 'unavailable';
  baselineAction: HorseDecision['action'];
  baselineAmount: number | null;
  proposalAction: HorseDecision['action'];
  proposalAmount: number | null;
  finalAction: HorseDecision['action'];
  finalAmount: number | null;
  features: string[];
  /** The validated equity evidence actually consumed, copied; null otherwise. */
  equity: OmahaVariantEquityEvidence | null;
  callPrice: number | null;
  /** P11.1 (Phase 11 receipts only): frozen inputs of an eligible proposal;
   * null when it was refused. Absent on retained receipts and on the Phase 12
   * receipts that share this type. */
  inputs?: OmahaVariantInputBinding | null;
  shadowUtility?: import('../../types.js').HorseTournamentUtilityLedger;
  utilityOwner: 'cash' | 'phase7_pending' | 'phase7_evaluated' | 'phase7_unavailable';
  utilityLatencyMs?: number;
  utilityUnavailableReason?: string;
  latencyMs: number;
  executionStatus: 'pending' | 'intended' | 'coerced' | 'fallback' | 'not_executed';
  executedAction: HorseDecision['action'] | null;
  executedAmount: number | null;
  /** P11.3 selection outcome, the Phase 10 vocabulary (`Plo4Selection`).
   * Phase 11 receipts only; absent on retained receipts and on the Phase 12
   * receipts that share this type. */
  selection?: Plo4Selection;
  /** P11.3: why an authority-backed candidate was not selected (the
   * reference was retained); null otherwise. */
  selectionRefusal?: 'illegal_candidate' | null;
  /** P11.3: the worker's authority receipt for this pack; null outside the
   * live worker; absent on retained receipts. */
  authority?: import('../HorseQualifiedAuthority.js').HorseAuthorityReceipt | null;
  /** P11.3: main-scheduler verdict immediately before acceptance; null in the worker. */
  authorityVerdict?: import('../HorseQualifiedAuthority.js').HorseAuthorityVerdict | null;
  /** P11-A (audit 2026-10-07): the net chip result of every legal candidate
   * at a fired PLO5/PLO6/PLO8 river node, priced on the showdowns the policy
   * already sampled. Diagnostic: nothing reads it to decide. Priced AFTER the
   * policy has finished, on its own budget, so its cost never reaches
   * `latencyMs`, the reason or the proposal. Phase 11 receipts only; absent
   * on retained receipts, on unpriced nodes and on the Phase 12 receipts that
   * share this type (which carry their own `actionEconomics`). */
  netActionEconomics?: OmahaVariantActionEconomics;
}
const same = (a: HorseDecision, b: HorseDecision) =>
  a.action === b.action && (!['bet', 'raise'].includes(a.action) || a.amount === b.amount);

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  object(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const unit = (value: unknown): value is number => finite(value) && value <= 1 + 1e-9;
const nullableFinite = (value: unknown) => value === null || finite(value);
const seatList = (value: unknown, max = 10): value is number[] =>
  Array.isArray(value) &&
  value.length <= max &&
  value.every(
    (seat, i) =>
      Number.isSafeInteger(seat) && seat >= 1 && seat <= 10 && (i === 0 || seat > value[i - 1])
  );
const count = (value: unknown, max: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;

const RANGE_STATUSES: readonly OmahaVariantRangeStatus[] = [
  'not_consumed_preflop',
  'unavailable',
  'rejected_malformed',
  'rejected_population',
  'consumed_unattributed',
  'consumed',
];

/**
 * Labels, shape and internal consistency of the variant sampler's provenance.
 * With `population`, the scored opponents must be exactly this decision's
 * contesting opponents (seat and user), the deck must have been occupied by
 * every other dealt seat, and the work must be the sample's own work.
 */
export function omahaVariantRangeProvenanceIsValid(
  value: unknown,
  population?: Readonly<{
    contesting: ReadonlyArray<Readonly<{ userId: string; seat: number }>>;
    dealtOpponents: number;
    samples: number;
    requestedSamples: number | undefined;
  }>
): value is OmahaVariantRangeProvenance {
  if (
    !exact(value, [
      'version',
      'source',
      'calibration',
      'solverInput',
      'reads',
      'prior',
      'deck',
      'work',
      'opponents',
    ]) ||
    value.version !== 'omaha-variant-range-provenance-v1' ||
    value.source !== 'variant_public_line_sequential_prior' ||
    value.calibration !== 'uncalibrated' ||
    value.solverInput !== false ||
    value.reads !== 'public_action_line_only' ||
    !exact(value.prior, ['attemptsPerSeat', 'finalAttempt', 'seatDraws', 'uniformEscapes']) ||
    value.prior.attemptsPerSeat !== 3 ||
    value.prior.finalAttempt !== 'uniform_escape' ||
    !count(value.prior.seatDraws, 4096 * 9) ||
    !count(value.prior.uniformEscapes, value.prior.seatDraws as number) ||
    !exact(value.deck, ['physical', 'dealtOpponents']) ||
    value.deck.physical !== 'single_deck_excluding_hero_and_board' ||
    !count(value.deck.dealtOpponents, 9) ||
    (value.deck.dealtOpponents as number) < 1 ||
    !exact(value.work, ['requestedSamples', 'completedSamples', 'budgetExhausted']) ||
    !count(value.work.requestedSamples, 4096) ||
    !count(value.work.completedSamples, value.work.requestedSamples as number) ||
    (value.work.completedSamples as number) < 1 ||
    value.work.budgetExhausted !==
      (value.work.completedSamples as number) < (value.work.requestedSamples as number) ||
    value.prior.seatDraws !==
      (value.work.completedSamples as number) * (value.deck.dealtOpponents as number) ||
    !Array.isArray(value.opponents) ||
    value.opponents.length < 1 ||
    value.opponents.length > (value.deck.dealtOpponents as number)
  )
    return false;
  const ids = new Set<string>();
  const seats = new Set<number>();
  for (const row of value.opponents as unknown[]) {
    if (
      !exact(row, ['userId', 'seat', 'raises', 'calls']) ||
      typeof row.userId !== 'string' ||
      !row.userId.length ||
      row.userId.length > 256 ||
      ids.has(row.userId) ||
      !Number.isSafeInteger(row.seat) ||
      (row.seat as number) < 1 ||
      (row.seat as number) > 10 ||
      seats.has(row.seat as number) ||
      !count(row.raises, OMAHA_VARIANT_DOMAIN.maxActionsPerHand) ||
      !count(row.calls, OMAHA_VARIANT_DOMAIN.maxActionsPerHand)
    )
      return false;
    ids.add(row.userId);
    seats.add(row.seat as number);
  }
  if (!population) return true;
  const rows = value.opponents as ReadonlyArray<{ userId: string; seat: number }>;
  return (
    population.contesting.length === rows.length &&
    population.contesting.every((p) =>
      rows.some((r) => r.userId === p.userId && r.seat === p.seat)
    ) &&
    value.deck.dealtOpponents === population.dealtOpponents &&
    value.work.completedSamples === population.samples &&
    (population.requestedSamples === undefined ||
      value.work.requestedSamples === population.requestedSamples)
  );
}

/** A frozen copy of evidence the proposal consumed: the receipt never aliases
 * the caller's object (P10.1 defect 2, applied to Phase 11). */
function copyEvidence(e: OmahaVariantEquityEvidence): OmahaVariantEquityEvidence {
  return Object.freeze({
    ...e,
    confidence99: Object.freeze([e.confidence99[0], e.confidence99[1]]) as unknown as [
      number,
      number,
    ],
    distribution: Object.freeze(
      e.distribution.map((b) => Object.freeze({ share: b.share, probability: b.probability }))
    ) as unknown as OmahaVariantEquityEvidence['distribution'],
    perPot: Object.freeze(
      e.perPot.map((p) =>
        Object.freeze({
          ...p,
          eligiblePlayers: Object.freeze([...p.eligiblePlayers]) as unknown as string[],
        })
      )
    ) as unknown as OmahaVariantEquityEvidence['perPot'],
  });
}

/** Worker-boundary shape check of a returned Phase 11 binding. It does not
 * recompute the proposal or the census; the journal reviewer checks that the
 * execution witness commits to this binding (`phase11Inputs`). Positions must be the canonical positions of the recorded button,
 * census and posted blind seats. */
export function omahaVariantInputBindingIsValid(value: unknown): value is OmahaVariantInputBinding {
  if (
    !exact(value, [
      'version',
      'variant',
      'pack',
      'approximation',
      'census',
      'positions',
      'geometry',
      'depth',
      'board',
      'range',
    ]) ||
    value.version !== 'omaha-variant-input-binding-v1' ||
    !isOmahaPolicyVariant(value.variant)
  )
    return false;
  const variant = value.variant;
  const packDef = OMAHA_VARIANT_PACKS[variant];
  const { pack, approximation, census, positions, geometry, depth, board, range } = value;
  if (!object(geometry) || (geometry.chipUnit !== 0.01 && geometry.chipUnit !== 1)) return false;
  const tournament = geometry.chipUnit === 1;
  const cap = omahaVariantSeatCap(variant, tournament ? 'tournament' : 'cash');
  if (
    !exact(pack, [
      'version',
      'holes',
      'splitPot',
      'source',
      'calibratedConfidence',
      'seats',
      'seatCapOwner',
      'maxStackBB',
      'maxAnteBB',
      'maxRakePercent',
    ]) ||
    pack.version !== packDef.version ||
    pack.holes !== packDef.holes ||
    pack.splitPot !== packDef.splitPot ||
    pack.source !== OMAHA_VARIANT_DOMAIN.source ||
    pack.calibratedConfidence !== null ||
    !Array.isArray(pack.seats) ||
    pack.seats.length !== 2 ||
    pack.seats[0] !== OMAHA_VARIANT_DOMAIN.minSeats ||
    pack.seats[1] !== cap ||
    pack.seatCapOwner !== (tournament ? 'tournament_deck_capacity' : 'cash_table_seating') ||
    pack.maxStackBB !== OMAHA_VARIANT_DOMAIN.maxStackBB ||
    pack.maxAnteBB !== OMAHA_VARIANT_DOMAIN.maxAnteBB ||
    pack.maxRakePercent !== OMAHA_VARIANT_DOMAIN.maxRakePercent ||
    !exact(approximation, ['status', 'solverInput', 'handShape']) ||
    ![
      'explicit_variant_heuristic',
      'explicit_variant_heuristic_with_uncalibrated_range_sample',
    ].includes(approximation.status as string) ||
    approximation.solverInput !== false ||
    !exact(approximation.handShape, ['score', 'highScore', 'lowScore', 'kind', 'probability']) ||
    !unit(approximation.handShape.score) ||
    !unit(approximation.handShape.highScore) ||
    (packDef.splitPot
      ? !unit(approximation.handShape.lowScore)
      : approximation.handShape.lowScore !== null) ||
    approximation.handShape.kind !== 'heuristic_entry_score' ||
    approximation.handShape.probability !== false
  )
    return false;
  if (
    !exact(census, [
      'source',
      'dealerSeat',
      'heroSeat',
      'dealtSeats',
      'blindSeats',
      'contestingOpponentSeats',
      'actingOpponentSeats',
      'foldedSeats',
      'awaySeats',
      'allInSeats',
    ]) ||
    !['dealt_seat_ids', 'legacy_player_list'].includes(census.source as string) ||
    !seatList(census.dealtSeats, cap) ||
    census.dealtSeats.length < OMAHA_VARIANT_DOMAIN.minSeats ||
    !(census.dealtSeats as number[]).includes(census.heroSeat as number) ||
    plo4BlindSeatsStatus(
      census.dealerSeat,
      census.dealtSeats as number[],
      census.blindSeats,
      tournament
    ) !== 'valid' ||
    [
      'contestingOpponentSeats',
      'actingOpponentSeats',
      'foldedSeats',
      'awaySeats',
      'allInSeats',
    ].some(
      (key) =>
        !seatList(census[key]) ||
        (census[key] as number[]).some((seat) => !(census.dealtSeats as number[]).includes(seat))
    ) ||
    (census.contestingOpponentSeats as number[]).length < 1 ||
    (census.contestingOpponentSeats as number[]).includes(census.heroSeat as number) ||
    (census.foldedSeats as number[]).includes(census.heroSeat as number) ||
    (census.actingOpponentSeats as number[]).some(
      (seat) =>
        !(census.contestingOpponentSeats as number[]).includes(seat) ||
        (census.allInSeats as number[]).includes(seat)
    ) ||
    (census.contestingOpponentSeats as number[]).some((seat) =>
      (census.foldedSeats as number[]).includes(seat)
    )
  )
    return false;
  const roles: readonly string[] = [...PLO4_PREFLOP_ROLES, ...PLO4_POSTFLOP_ROLES];
  const positionOf = (seat: number) =>
    plo4CanonicalPosition(
      seat,
      census.dealerSeat as number,
      census.dealtSeats as number[],
      census.blindSeats as Plo4BlindSeats
    );
  if (
    !exact(positions, ['hero', 'heroOffset', 'role', 'aggressor', 'aggressorSeat', 'straddle']) ||
    !PLO4_POSITIONS.includes(positions.hero as OmahaPolicyPosition) ||
    positions.heroOffset !==
      plo4ButtonOffset(
        census.heroSeat as number,
        census.dealerSeat as number,
        census.dealtSeats as number[]
      ) ||
    positions.hero !== positionOf(census.heroSeat as number) ||
    !roles.includes(positions.role as string) ||
    (positions.aggressor === null) !== (positions.aggressorSeat === null) ||
    (positions.aggressorSeat !== null &&
      (!(census.dealtSeats as number[]).includes(positions.aggressorSeat as number) ||
        positions.aggressorSeat === census.heroSeat ||
        positions.aggressor !== positionOf(positions.aggressorSeat as number))) ||
    !['table_enabled_utg_2bb', 'none'].includes(positions.straddle as string)
  )
    return false;
  if (
    !exact(geometry, [
      'bettingStructure',
      'chipUnit',
      'bigBlind',
      'pot',
      'currentBet',
      'heroBet',
      'heroStack',
      'callCost',
      'minRaiseTo',
      'maxRaiseTo',
      'potLimitRaiseTo',
      'stackRaiseTo',
      'wagerCap',
      'ante',
      'anteBB',
      'rake',
      'postflop',
    ]) ||
    geometry.bettingStructure !== 'pot_limit' ||
    ![
      geometry.bigBlind,
      geometry.pot,
      geometry.currentBet,
      geometry.heroBet,
      geometry.heroStack,
      geometry.callCost,
      geometry.potLimitRaiseTo,
      geometry.stackRaiseTo,
      geometry.ante,
      geometry.anteBB,
    ].every(finite) ||
    !(geometry.bigBlind as number) ||
    !(geometry.heroStack as number) ||
    (geometry.anteBB as number) > OMAHA_VARIANT_DOMAIN.maxAnteBB ||
    ![geometry.minRaiseTo, geometry.maxRaiseTo, geometry.wagerCap].every(nullableFinite) ||
    Math.abs(
      (geometry.potLimitRaiseTo as number) -
        ((geometry.currentBet as number) + (geometry.pot as number) + (geometry.callCost as number))
    ) > 1e-6 ||
    Math.abs(
      (geometry.stackRaiseTo as number) -
        ((geometry.heroBet as number) + (geometry.heroStack as number))
    ) > 1e-6 ||
    (geometry.maxRaiseTo === null) !== (geometry.wagerCap === null) ||
    (geometry.wagerCap !== null &&
      Math.abs(
        (geometry.wagerCap as number) -
          Math.min(
            geometry.maxRaiseTo as number,
            geometry.stackRaiseTo as number,
            geometry.potLimitRaiseTo as number
          )
      ) > 1e-6) ||
    !exact(geometry.rake, ['percent', 'cap', 'noFlopNoDrop', 'playerCountCaps', 'dealtCount']) ||
    !finite(geometry.rake.percent) ||
    (geometry.rake.percent as number) > OMAHA_VARIANT_DOMAIN.maxRakePercent ||
    !finite(geometry.rake.cap) ||
    typeof geometry.rake.noFlopNoDrop !== 'boolean' ||
    geometry.rake.dealtCount !== (census.dealtSeats as number[]).length ||
    !(
      geometry.rake.playerCountCaps === null ||
      (Array.isArray(geometry.rake.playerCountCaps) &&
        geometry.rake.playerCountCaps.length <= 16 &&
        geometry.rake.playerCountCaps.every(
          (tier) =>
            exact(tier, ['players', 'cap']) &&
            Number.isSafeInteger(tier.players) &&
            finite(tier.cap)
        ))
    ) ||
    !(
      geometry.postflop === null ||
      (exact(geometry.postflop, [
        'contestablePot',
        'eligibleAfterCall',
        'chargedRake',
        'netPotAfterCall',
        'callPrice',
        'spr',
      ]) &&
        Object.values(geometry.postflop).every(finite))
    )
  )
    return false;
  // An empty dealer or a dead small blind exists only at a tournament table.
  if (
    (!(census.dealtSeats as number[]).includes(census.dealerSeat as number) ||
      (census.blindSeats as Plo4BlindSeats).smallBlind === null) &&
    !tournament
  )
    return false;
  const street = object(board) ? board.street : undefined;
  if (
    !exact(depth, ['effectiveBB', 'heroCoverBB', 'deepestOpponentCoverBB', 'basis']) ||
    ![depth.effectiveBB, depth.heroCoverBB, depth.deepestOpponentCoverBB].every(finite) ||
    !(depth.effectiveBB as number) ||
    (depth.effectiveBB as number) > OMAHA_VARIANT_DOMAIN.maxStackBB ||
    Math.abs(
      (depth.effectiveBB as number) -
        Math.min(depth.heroCoverBB as number, depth.deepestOpponentCoverBB as number)
    ) > 1e-6 ||
    depth.basis !== 'stack_plus_street_bet_vs_deepest_contesting_opponent' ||
    !exact(board, ['street', 'cards', 'paired', 'flushBoard', 'lowPossible', 'features']) ||
    !['preflop', 'flop', 'turn', 'river'].includes(street as string) ||
    board.cards !== { preflop: 0, flop: 3, turn: 4, river: 5 }[street as 'flop'] ||
    (street === 'preflop') !== (board.paired === null) ||
    (street === 'preflop') !== (board.flushBoard === null) ||
    (street === 'preflop') !== (geometry.postflop === null) ||
    (street === 'preflop' || !packDef.splitPot) !== (board.lowPossible === null) ||
    (board.paired !== null && typeof board.paired !== 'boolean') ||
    (board.flushBoard !== null && typeof board.flushBoard !== 'boolean') ||
    (board.lowPossible !== null && typeof board.lowPossible !== 'boolean') ||
    !Array.isArray(board.features) ||
    board.features.length > 24 ||
    board.features.some((f) => typeof f !== 'string' || !/^[a-z][a-z_]{0,63}$/.test(f)) ||
    (street === 'preflop' && board.features.length > 0)
  )
    return false;
  if (
    !exact(range, [
      'status',
      'equity',
      'highEquity',
      'lowEquity',
      'samples',
      'standardError',
      'confidence99',
      'scoopProbability',
      'quarterOrLessProbability',
      'sixthOrLessProbability',
      'pots',
      'decisionEquityCeiling',
      'provenance',
    ]) ||
    !RANGE_STATUSES.includes(range.status as OmahaVariantRangeStatus)
  )
    return false;
  const consumed = range.status === 'consumed' || range.status === 'consumed_unattributed';
  const numbers = [
    range.equity,
    range.highEquity,
    range.lowEquity,
    range.standardError,
    range.scoopProbability,
    range.quarterOrLessProbability,
    range.sixthOrLessProbability,
  ];
  if (
    (street === 'preflop') !== (range.status === 'not_consumed_preflop') ||
    (approximation.status === 'explicit_variant_heuristic_with_uncalibrated_range_sample') !==
      consumed ||
    (range.status === 'consumed') !== (range.provenance !== null)
  )
    return false;
  if (!consumed)
    return (
      numbers.every((n) => n === null) &&
      range.decisionEquityCeiling === null &&
      range.samples === null &&
      range.confidence99 === null &&
      range.pots === null
    );
  return (
    numbers.every(unit) &&
    (range.decisionEquityCeiling === null || unit(range.decisionEquityCeiling)) &&
    Math.abs(
      (range.highEquity as number) + (range.lowEquity as number) - (range.equity as number)
    ) < 1e-8 &&
    (packDef.splitPot || (range.lowEquity as number) === 0) &&
    (range.sixthOrLessProbability as number) <= (range.quarterOrLessProbability as number) + 1e-9 &&
    Number.isSafeInteger(range.samples) &&
    (range.samples as number) >= 1 &&
    (range.samples as number) <= 4096 &&
    Array.isArray(range.confidence99) &&
    range.confidence99.length === 2 &&
    range.confidence99.every(unit) &&
    (range.confidence99[0] as number) <= (range.equity as number) + 1e-9 &&
    (range.confidence99[1] as number) >= (range.equity as number) - 1e-9 &&
    Number.isSafeInteger(range.pots) &&
    (range.pots as number) >= 1 &&
    (range.pots as number) <= 10 &&
    (range.provenance === null ||
      (omahaVariantRangeProvenanceIsValid(range.provenance) &&
        range.provenance.work.completedSamples === range.samples &&
        range.provenance.opponents.length === (census.contestingOpponentSeats as number[]).length &&
        range.provenance.opponents.every((row) =>
          (census.contestingOpponentSeats as number[]).includes(row.seat)
        ) &&
        range.provenance.deck.dealtOpponents === (census.dealtSeats as number[]).length - 1))
  );
}

/** The returned receipt's P11.1 fields: an eligible proposal carries a valid
 * binding of its own variant and pack, and an ineligible one carries none. A
 * retained receipt without the field claims no binding and is not refused. */
export function omahaVariantReceiptBindingIsValid(value: unknown): boolean {
  if (!object(value)) return false;
  return omahaInputBindingIsValid(value) && omahaNetActionBindingIsValid(value);
}

function omahaInputBindingIsValid(value: Record<string, unknown>): boolean {
  if (!Object.hasOwn(value, 'inputs')) return true;
  if (value.inputs === null) return value.eligible === false;
  return (
    value.eligible === true &&
    omahaVariantInputBindingIsValid(value.inputs) &&
    value.inputs.variant === value.variant &&
    value.inputs.pack.version === value.version
  );
}

/**
 * P11-A (audit 2026-10-07): the net-action field is re-checked against this
 * running module, not merely carried. An eligible river receipt must declare
 * its own variant and street and a result the economics validator accepts,
 * and the `net_action_economics` feature must be present exactly when a
 * result is available. A receipt without the field claims no economics.
 */
function omahaNetActionBindingIsValid(receipt: Record<string, unknown>): boolean {
  const features = Array.isArray(receipt.features) ? (receipt.features as unknown[]) : [];
  const tagged = features.includes('net_action_economics');
  if (!Object.hasOwn(receipt, 'netActionEconomics')) return !tagged;
  const economics = receipt.netActionEconomics;
  if (!omahaVariantActionEconomicsIsValid(economics)) return false;
  const bound = economics as OmahaVariantActionEconomics;
  return (
    receipt.eligible === true &&
    bound.variant === receipt.variant &&
    bound.street === receipt.street &&
    receipt.street === 'river' &&
    tagged === (bound.unavailable === null)
  );
}

/** Canonical private commitment carried by the execution witness. */
export function omahaVariantInputBindingSha256(binding: OmahaVariantInputBinding): string {
  return horseCanonicalMaterialSha256(binding);
}

/** Only in-memory facts and a decision-local equity sample are consumed here.
 * Live candidate mode is granted only by the worker's own P11.3 authority for
 * this pack (`horsePhase11AdmittedMode`); no caller can request it.
 */
export function evaluateOmahaVariantPolicy(
  hero: SeatPlayer,
  s: HorseGameStateV2,
  baseline: HorseDecision,
  evidence: OmahaVariantEquityEvidence | null,
  mode: OmahaVariantMode = 'shadow',
  now = () => performance.now(),
  decisionEquityCeiling = 1,
  sampleWhenMissing = true,
  /** The owner's legalizer (HorseLogic passes its own). A changed proposal is
   * recorded and executed in the exact legal form the owner will give it, so
   * a unit or all-in rewrite never turns a measured proposal into an
   * `illegal_candidate` refusal (audit 2026-10-05). */
  legalForm?: (decision: HorseDecision) => HorseDecision
) {
  const start = now();
  const externalAnalysisMs = evidence
    ? Number.isFinite(evidence.analysisMs) && evidence.analysisMs >= 0
      ? evidence.analysisMs
      : Infinity
    : 0;
  const variant = isOmahaPolicyVariant(s.gameVariant) ? s.gameVariant : null;
  const pack = variant ? OMAHA_VARIANT_PACKS[variant] : null;
  const receipt: OmahaVariantReceipt = {
    version: pack?.version ?? 'unsupported',
    variant: s.gameVariant ?? 'unknown',
    mode,
    eligible: false,
    fired: false,
    changed: false,
    applied: false,
    reason: 'off',
    street: s.stage,
    position: null,
    aggressorPosition: null,
    role: null,
    depthBB: null,
    confidence: 'unavailable',
    baselineAction: baseline.action,
    baselineAmount: baseline.amount ?? null,
    proposalAction: baseline.action,
    proposalAmount: baseline.amount ?? null,
    finalAction: baseline.action,
    finalAmount: baseline.amount ?? null,
    features: [],
    // Set only to a frozen copy of evidence the proposal consumed.
    equity: null,
    callPrice: null,
    inputs: null,
    utilityOwner: s.gameMode === 'tournament' ? 'phase7_pending' : 'cash',
    latencyMs: 0,
    executionStatus: 'pending',
    executedAction: null,
    executedAmount: null,
    selection: 'none',
    selectionRefusal: null,
    authority: null,
    authorityVerdict: null,
  };
  /** Assembled only once every canonical check has passed. */
  let bind: (() => OmahaVariantInputBinding) | null = null;
  const finish = (reason: string, proposal = baseline) => {
    // Bound inside the timed region: recording the inputs is policy work.
    if (bind) receipt.inputs = bind();
    if (legalForm && proposal !== baseline)
      proposal = { ...legalForm(proposal), thinkTime: proposal.thinkTime };
    const elapsed = Math.max(0, now() - start) + externalAnalysisMs;
    if (elapsed > OMAHA_VARIANT_DOMAIN.liveBudgetMs) {
      reason = 'work_budget';
      proposal = baseline;
      receipt.fired = false;
    }
    if (!s.legalActions?.includes(proposal.action)) {
      proposal = baseline;
      reason = 'proposal_outside_legal_menu';
      receipt.fired = false;
    }
    receipt.reason = reason;
    receipt.latencyMs = elapsed;
    receipt.proposalAction = proposal.action;
    receipt.proposalAmount = proposal.amount ?? null;
    receipt.changed = !same(proposal, baseline);
    const decision = mode === 'candidate' && receipt.fired ? proposal : baseline;
    receipt.applied = !same(decision, baseline);
    receipt.selection = plo4SelectionOf(receipt);
    return { decision, proposal, receipt };
  };
  if (mode === 'off') return finish('off');
  if (!['shadow', 'candidate'].includes(mode)) return finish('invalid_mode');
  if (!variant || !pack) return finish('variant_outside_pack');
  if (
    s.bombPot ||
    (s.boardCount ?? 1) !== 1 ||
    s.communityCards2?.length ||
    s.communityCards3?.length
  )
    return finish('multiboard_owned_by_phase13');
  let seats: SeatPlayer[];
  try {
    seats = horsePolicyDealtPlayers(s.players, hero.seat, s.dealtSeatIds);
  } catch {
    return finish('canonical_state_unavailable');
  }
  const dealt = seats.map((p) => p.seat).sort((a, b) => a - b);
  const tournamentTable = s.gameMode === 'tournament';
  if (
    s.stateSchemaVersion !== 1 ||
    s.bettingStructure !== 'pot_limit' ||
    seats.length < 2 ||
    !['cash', 'tournament'].includes(s.gameMode ?? '') ||
    !seats.some(
      (p) =>
        p.user_id === hero.user_id &&
        p.seat === hero.seat &&
        p.stack === hero.stack &&
        p.bet === hero.bet &&
        p.totalInvested === hero.totalInvested
    ) ||
    // P11.1: a tournament dead button (an empty physical dealer seat at three
    // or more dealt) is a valid engine state, as P10.1 defect 3 found for PLO4.
    !plo4DealerSeatIsValid(s.dealerSeat, dealt, tournamentTable) ||
    new Set(seats.map((p) => p.seat)).size !== seats.length ||
    new Set(seats.map((p) => p.user_id)).size !== seats.length ||
    !s.legalActions?.includes(baseline.action)
  )
    return finish('canonical_state_unavailable');
  // P11.1: a valid census larger than the pack's ceiling for this mode is
  // outside the declared domain, not an unavailable canonical state.
  const seatCap = omahaVariantSeatCap(variant, tournamentTable ? 'tournament' : 'cash');
  if (seats.length > seatCap) return finish('seat_count_outside_pack');
  // Positions come from the blinds the engine posted (P10.1 F3/F5, applied to
  // Phase 11). A state without them is refused by name; blind seats the engine
  // could not have posted with this button are malformed.
  const blinds = plo4BlindSeatsStatus(s.dealerSeat, dealt, s.blindSeats, tournamentTable);
  if (blinds === 'missing') return finish('blind_seats_unavailable');
  if (blinds === 'invalid') return finish('canonical_state_unavailable');
  const blindSeats: Plo4BlindSeats = Object.freeze({
    smallBlind: s.blindSeats!.smallBlind,
    bigBlind: s.blindSeats!.bigBlind,
  });
  const positionOf = (seat: number) =>
    plo4CanonicalPosition(seat, s.dealerSeat!, dealt, blindSeats);
  if (
    s.players.some((p) => !Array.isArray(p.cards) || p.cards.length > 0 || p.knownDeadCards?.length)
  )
    return finish('private_state_rejected');
  const callCost = Math.min(hero.stack, Math.max(0, s.currentBet - hero.bet));
  if (
    !(Number.isFinite(s.bigBlind) && s.bigBlind > 0) ||
    hero.is_folded ||
    hero.is_sitting_out ||
    hero.is_all_in ||
    ![hero.stack, hero.bet, s.pot, s.currentBet, s.toCall, s.ante ?? 0].every(
      (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0
    ) ||
    seats.some(
      (p) =>
        ![
          p.stack,
          p.bet,
          p.totalInvested,
          p.deadInvested ?? 0,
          p.individualAnteInvested ?? 0,
        ].every((n) => Number.isFinite(n) && n >= 0)
    ) ||
    Math.abs(s.toCall! - Math.max(0, s.currentBet - hero.bet)) > 0.011 ||
    Math.abs(s.players.reduce((n, p) => n + p.totalInvested, 0) - s.pot) > 0.011 ||
    hero.stack <= 0
  )
    return finish('invalid_geometry');
  if (
    s.legalActions?.some((a) => a === 'bet' || a === 'raise') &&
    (!Number.isFinite(s.minRaiseTo) ||
      !Number.isFinite(s.maxRaiseTo) ||
      s.minRaiseTo! <= s.currentBet ||
      s.maxRaiseTo! < s.minRaiseTo!)
  )
    return finish('invalid_wager_geometry');
  const active = seats.filter(
    (p) => p.user_id !== hero.user_id && !p.is_folded && (!p.is_sitting_out || p.is_all_in)
  );
  const deepestOpponentCover = Math.max(...active.map((p) => p.stack + p.bet));
  const depth = Math.min(hero.stack + hero.bet, deepestOpponentCover) / s.bigBlind;
  // Reachability 2026-10-08: with every live opponent away (sitting out, not
  // all-in) no seat can cover, the depth is -Infinity and the pack refuses it
  // below. The receipt records that as an unavailable depth: a non-finite
  // number cannot be journaled, and the whole decision record was lost.
  receipt.depthBB = Number.isFinite(depth) ? depth : null;
  if (
    !Number.isFinite(depth) ||
    depth <= 0 ||
    depth > OMAHA_VARIANT_DOMAIN.maxStackBB ||
    (s.ante ?? 0) / s.bigBlind > 1
  )
    return finish('depth_or_ante_outside_pack');
  const rake = s.rakeConfig;
  if (
    !rake ||
    !Number.isFinite(rake.percent) ||
    rake.percent < 0 ||
    rake.percent > 10 ||
    !Number.isFinite(rake.cap) ||
    rake.cap < 0 ||
    rake.timedRake
  )
    return finish('rake_schedule_unavailable');
  if (
    hero.cards.length !== pack.holes ||
    s.communityCards.length !==
      ({ preflop: 0, flop: 3, turn: 4, river: 5 } as Record<string, number>)[s.stage]
  )
    return finish('invalid_cards');
  let facts: ReturnType<typeof omahaCardFacts>;
  let shape: ReturnType<typeof omahaVariantHandShape>;
  try {
    facts = omahaCardFacts(hero.cards, s.communityCards, true, pack.splitPot);
    shape = omahaVariantHandShape(variant, hero.cards);
  } catch {
    return finish('invalid_cards');
  }
  receipt.position = positionOf(hero.seat);
  receipt.role = plo4Role(hero, s, positionOf);
  const aggressor = (s.actionHistory ?? [])
    .filter(
      (a) =>
        a.userId !== hero.user_id &&
        a.stage === s.stage &&
        (a.action === 'bet' ||
          a.action === 'raise' ||
          (a.action === 'all_in' && a.isFullRaise !== undefined))
    )
    .at(-1);
  receipt.aggressorPosition = aggressor ? positionOf(aggressor.seat) : null;
  receipt.eligible = true;
  receipt.fired = true;
  receipt.confidence = 'explicit_variant_heuristic';
  // Pot-limit geometry the proposal enforces, computed once and recorded.
  const chipUnit: 0.01 | 1 = tournamentTable ? 1 : 0.01;
  const potLimitRaiseTo = s.currentBet + s.pot + callCost;
  const stackRaiseTo = hero.bet + hero.stack;
  const wagerCap =
    s.maxRaiseTo == null ? null : Math.min(s.maxRaiseTo, stackRaiseTo, potLimitRaiseTo);
  // Copy the census now: the receipt never aliases the caller's arrays.
  const seatsOf = (rows: readonly SeatPlayer[]) =>
    Object.freeze(rows.map((p) => p.seat).sort((a, b) => a - b));
  const census = Object.freeze({
    source: s.dealtSeatIds === undefined ? 'legacy_player_list' : 'dealt_seat_ids',
    dealerSeat: s.dealerSeat!,
    heroSeat: hero.seat,
    dealtSeats: Object.freeze([...dealt]),
    blindSeats,
    contestingOpponentSeats: seatsOf(active),
    actingOpponentSeats: seatsOf(active.filter((p) => !p.is_all_in)),
    foldedSeats: seatsOf(seats.filter((p) => p.is_folded)),
    awaySeats: seatsOf(seats.filter((p) => p.is_sitting_out)),
    allInSeats: seatsOf(seats.filter((p) => p.is_all_in)),
  } as const);
  const positions = Object.freeze({
    hero: receipt.position,
    heroOffset: plo4ButtonOffset(hero.seat, s.dealerSeat!, dealt),
    role: receipt.role,
    aggressor: receipt.aggressorPosition,
    aggressorSeat: aggressor ? aggressor.seat : null,
    straddle: s.straddleActive ? 'table_enabled_utg_2bb' : 'none',
  } as const);
  const rakeBinding = Object.freeze({
    percent: rake.percent,
    cap: rake.cap,
    noFlopNoDrop: rake.noFlopNoDrop === true,
    playerCountCaps: rake.playerCountCaps?.length
      ? Object.freeze(
          rake.playerCountCaps.map((tier) =>
            Object.freeze({ players: tier.players, cap: tier.cap })
          )
        )
      : null,
    dealtCount: seats.length,
  });
  const scalars = {
    bigBlind: s.bigBlind,
    pot: s.pot,
    currentBet: s.currentBet,
    heroBet: hero.bet,
    heroStack: hero.stack,
    minRaiseTo: s.minRaiseTo ?? null,
    maxRaiseTo: s.maxRaiseTo ?? null,
    ante: s.ante ?? 0,
  };
  const street = s.stage as 'preflop' | 'flop' | 'turn' | 'river';
  let postflop: NonNullable<OmahaVariantInputBinding['geometry']['postflop']> | null = null;
  let boardFacts: {
    paired: boolean | null;
    flushBoard: boolean | null;
    lowPossible: boolean | null;
  } = { paired: null, flushBoard: null, lowPossible: null };
  const notConsumed = (status: OmahaVariantRangeStatus): OmahaVariantInputBinding['range'] =>
    Object.freeze({
      status,
      equity: null,
      highEquity: null,
      lowEquity: null,
      samples: null,
      standardError: null,
      confidence99: null,
      scoopProbability: null,
      quarterOrLessProbability: null,
      sixthOrLessProbability: null,
      pots: null,
      decisionEquityCeiling: null,
      provenance: null,
    });
  let range = notConsumed('not_consumed_preflop');
  bind = () =>
    Object.freeze({
      version: 'omaha-variant-input-binding-v1',
      variant,
      pack: Object.freeze({
        version: pack.version,
        holes: pack.holes,
        splitPot: pack.splitPot,
        source: OMAHA_VARIANT_DOMAIN.source,
        calibratedConfidence: null,
        seats: Object.freeze([OMAHA_VARIANT_DOMAIN.minSeats, seatCap]) as readonly [number, number],
        seatCapOwner: tournamentTable ? 'tournament_deck_capacity' : 'cash_table_seating',
        maxStackBB: OMAHA_VARIANT_DOMAIN.maxStackBB,
        maxAnteBB: OMAHA_VARIANT_DOMAIN.maxAnteBB,
        maxRakePercent: OMAHA_VARIANT_DOMAIN.maxRakePercent,
      }),
      approximation: Object.freeze({
        status:
          range.status === 'consumed' || range.status === 'consumed_unattributed'
            ? 'explicit_variant_heuristic_with_uncalibrated_range_sample'
            : 'explicit_variant_heuristic',
        solverInput: false,
        handShape: Object.freeze({
          score: shape.quality,
          highScore: shape.highQuality,
          lowScore: pack.splitPot ? shape.lowQuality : null,
          kind: 'heuristic_entry_score',
          probability: false,
        }),
      }),
      census,
      positions,
      geometry: Object.freeze({
        bettingStructure: 'pot_limit',
        chipUnit,
        ...scalars,
        callCost,
        potLimitRaiseTo,
        stackRaiseTo,
        wagerCap,
        anteBB: scalars.ante / s.bigBlind,
        rake: rakeBinding,
        postflop,
      }),
      depth: Object.freeze({
        effectiveBB: depth,
        heroCoverBB: stackRaiseTo / s.bigBlind,
        deepestOpponentCoverBB: deepestOpponentCover / s.bigBlind,
        basis: 'stack_plus_street_bet_vs_deepest_contesting_opponent',
      }),
      board: Object.freeze({
        street,
        cards: s.communityCards.length,
        ...boardFacts,
        features: Object.freeze([...receipt.features]),
      }),
      range,
    } satisfies OmahaVariantInputBinding);
  const passive = (): HorseDecision => ({
    action: callCost > 0 ? 'fold' : 'check',
    thinkTime: baseline.thinkTime,
  });
  const call = (): HorseDecision => ({
    action: callCost > 0 ? 'call' : 'check',
    ...(callCost ? { amount: callCost } : {}),
    thinkTime: baseline.thinkTime,
  });
  const wager = (fraction: number): HorseDecision => {
    const action = s.currentBet > 0 ? 'raise' : 'bet';
    if (!s.legalActions!.includes(action) || s.minRaiseTo == null || wagerCap === null) {
      if (s.legalActions!.includes('all_in') && stackRaiseTo <= potLimitRaiseTo + 0.001)
        return { action: 'all_in', thinkTime: baseline.thinkTime };
      return call();
    }
    if (wagerCap < s.minRaiseTo) return call();
    const amount =
      Math.floor(
        Math.max(s.minRaiseTo, Math.min(wagerCap, s.currentBet + (s.pot + callCost) * fraction)) /
          chipUnit +
          1e-7
      ) * chipUnit;
    if (amount < s.minRaiseTo) return call();
    return { action, amount: Math.round(amount * 100) / 100, thinkTime: baseline.thinkTime };
  };
  /**
   * P11-A (audit 2026-10-07). The pot-share price below cannot express a side
   * pot hero is not eligible for, an uncalled-bet refund, the BBJ fee or a
   * PLO8 quarter, so a fired river node also carries an explicit net chip
   * result for every legal candidate.
   *
   * It runs on the showdowns the sampler ALREADY scored (no extra sample,
   * card or deck draw) and STRICTLY AFTER `finish`, on its own budget, the
   * order P12-B proved necessary: `finish` has already fixed the reason, the
   * proposal, `changed`, `applied` and `latencyMs`, so no cost incurred here
   * can turn a firing proposal into a `work_budget` fallback. A refused node
   * is not priced at all, and an unavailable pass is NAMED.
   *
   * The wager sizes priced are the controller's minimum and the largest the
   * pot-limit, stack and controller bounds allow, each in the owner's legal
   * form; a size the legalizer would turn into another action is not priced.
   */
  let terminal: OmahaVariantTerminalShowdowns | null = null;
  const finishPriced = (reason: string, proposal = baseline) => {
    const out = finish(reason, proposal);
    if (!out.receipt.fired || s.stage !== 'river') return out;
    const economicsStart = now();
    const wagerAction = s.currentBet > 0 ? 'raise' : 'bet';
    const sizes: number[] = [];
    if (
      s.legalActions!.includes(wagerAction) &&
      s.minRaiseTo != null &&
      wagerCap !== null &&
      wagerCap >= s.minRaiseTo
    )
      for (const target of [s.minRaiseTo, Math.floor(wagerCap / chipUnit + 1e-7) * chipUnit]) {
        const raw: HorseDecision = {
          action: wagerAction,
          amount: Math.round(target * 100) / 100,
          thinkTime: baseline.thinkTime,
        };
        const legal = legalForm ? legalForm(raw) : raw;
        if (legal.action === wagerAction && typeof legal.amount === 'number')
          sizes.push(legal.amount);
      }
    const showdowns = terminal as OmahaVariantTerminalShowdowns | null;
    const economics = omahaVariantActionEconomics({
      variant,
      stage: s.stage,
      hero,
      players: seats,
      opponentIds: showdowns ? showdowns.opponentIds : [],
      samples: showdowns ? showdowns.samples : [],
      currentBet: s.currentBet,
      legalActions: s.legalActions!,
      minRaiseTo: s.minRaiseTo ?? null,
      maxRaiseTo: s.maxRaiseTo ?? null,
      wagerSizes: sizes,
      chipUnit: s.chipUnit === 1 || s.chipUnit === 0.01 ? s.chipUnit : chipUnit,
      asset: s.asset === 'diamonds' ? 'diamonds' : 'chips',
      gameMode: s.gameMode === 'tournament' ? 'tournament' : 'cash',
      bigBlind: s.bigBlind,
      dealerSeat: s.dealerSeat!,
      rakeConfig: rake,
      bbjConfig: s.bbjConfig ?? null,
      withinBudget: () => now() - economicsStart < OMAHA_VARIANT_NET_ACTION_BUDGET_MS,
      now,
    });
    out.receipt.netActionEconomics = economics;
    if (economics.unavailable === null) out.receipt.features.push('net_action_economics');
    return out;
  };
  if (s.stage === 'preflop') {
    const bars = omahaVariantEntryBars(variant, {
      position: receipt.position,
      aggressorPosition: receipt.aggressorPosition,
      role: receipt.role,
      seats: seats.length,
      depthBB: depth,
      rakePercent: rake.percent,
      anteBB: (s.ante ?? 0) / s.bigBlind,
      straddle: Boolean(s.straddleActive),
    });
    const choice = plo4PreflopChoice(
      shape.quality,
      bars,
      receipt.role,
      callCost / s.bigBlind,
      hero.stack / s.bigBlind
    );
    return finish(
      choice.reason,
      choice.action === 'wager'
        ? wager(choice.fraction)
        : choice.action === 'call'
          ? call()
          : passive()
    );
  }

  if (!evidence && sampleWhenMissing) {
    evidence = sampleOmahaVariantEquity(
      variant,
      hero,
      s,
      () => now() - start < 3,
      (showdowns) => {
        terminal = showdowns;
      }
    );
    if (evidence) evidence.decisionEquityCeiling = decisionEquityCeiling;
  }
  const made = omahaNutStatus(hero.cards, s.communityCards);
  const pairedBoard = new Set(s.communityCards.map((c) => c.rank)).size < s.communityCards.length;
  const flushBoard = ['clubs', 'diamonds', 'hearts', 'spades'].some(
    (suit) => s.communityCards.filter((c) => c.suit === suit).length >= 3
  );
  const highNuts =
    facts.nutStraightFlush ||
    (!pairedBoard &&
      ((made.category === 6 &&
        facts.opponentStraightFlushHigh === 0 &&
        facts.flushes.some((f) => f.made && !f.higherFlushPossible)) ||
        (made.category === 5 && facts.nutStraight && !flushBoard)));
  const highStrong = made.category >= 7 || facts.setRanks.length > 0;
  const nutDraw = facts.flushes.some((f) => f.draw && !f.higherFlushPossible);
  const dominatedDraw = facts.flushes.some((f) => f.draw && f.higherFlushPossible);
  const nutWrap = facts.nutStraightOutCards.length >= (variant === 'plo6' ? 10 : 8);
  const lowBoardRanks = new Set(
    s.communityCards
      .map((c) => (c.rank === 'A' ? 1 : '23456789TJQKA'.indexOf(c.rank) + 2))
      .filter((v) => v <= 8)
  );
  const lowPossible = pack.splitPot && lowBoardRanks.size + 5 - s.communityCards.length >= 3;
  boardFacts = {
    paired: pairedBoard,
    flushBoard,
    lowPossible: pack.splitPot ? lowPossible : null,
  };
  const contestable = calculateContestablePot(s.players, hero.user_id, callCost);
  const eligibleAfterCall = contestable + callCost;
  const chargedRake = calculateRake(s.pot + callCost, true, rake, seats.length);
  const netPot = Math.max(
    0,
    eligibleAfterCall - (chargedRake * eligibleAfterCall) / Math.max(0.01, s.pot + callCost)
  );
  const price = callCost / Math.max(0.01, netPot);
  receipt.callPrice = price;
  const spr = hero.stack / Math.max(s.bigBlind, contestable);
  postflop = Object.freeze({
    contestablePot: contestable,
    eligibleAfterCall,
    chargedRake,
    netPotAfterCall: netPot,
    callPrice: price,
    spr,
  });
  const numbersValid = validOmahaVariantEquity(evidence, eligibleAfterCall);
  // A sample drawn against any population other than this decision's
  // contesting opponents and dealt deck is refused, like a malformed one.
  const populationValid =
    !numbersValid ||
    evidence!.range === undefined ||
    omahaVariantRangeProvenanceIsValid(evidence!.range, {
      contesting: active.map((p) => ({ userId: p.user_id, seat: p.seat })),
      dealtOpponents: seats.length - 1,
      samples: evidence!.samples,
      requestedSamples: evidence!.requestedSamples,
    });
  if (evidence && (!numbersValid || !populationValid)) {
    range = notConsumed(!numbersValid ? 'rejected_malformed' : 'rejected_population');
    receipt.fired = false;
    return finish('invalid_equity_evidence');
  }
  const e = numbersValid ? copyEvidence(evidence!) : null;
  if (e) receipt.confidence = 'range_sample';
  receipt.equity = e;
  range = !e
    ? notConsumed('unavailable')
    : Object.freeze({
        status: e.range === undefined ? 'consumed_unattributed' : 'consumed',
        equity: e.equity,
        highEquity: e.highEquity,
        lowEquity: e.lowEquity,
        samples: e.samples,
        standardError: e.standardError,
        confidence99: e.confidence99 as unknown as readonly [number, number],
        scoopProbability: e.scoopProbability,
        quarterOrLessProbability: e.quarterOrLessProbability,
        sixthOrLessProbability: e.sixthOrLessProbability,
        pots: e.perPot.length,
        decisionEquityCeiling: e.decisionEquityCeiling ?? null,
        provenance: e.range ?? null,
      });
  const ceiling = e?.decisionEquityCeiling == null ? 1 : e.decisionEquityCeiling;
  const usableCeiling = Number.isFinite(ceiling) && ceiling >= 0 && ceiling <= 1 ? ceiling : 0;
  const equity = e ? Math.min(e.equity, usableCeiling) : null;
  const lower = e ? Math.min(e.confidence99[0], usableCeiling) : null;
  const upper = e ? Math.min(e.confidence99[1], usableCeiling) : null;
  const quarterRisk = pack.splitPot && !!e && e.quarterOrLessProbability >= 0.2;
  const sixthRisk = pack.splitPot && !!e && e.sixthOrLessProbability >= 0.1;
  const lowOnly =
    pack.splitPot && facts.nutLow && !highNuts && !highStrong && (!e || e.highEquity < 0.15);
  const counterfeit = facts.counterfeitTransitions.some((t) => t.nutLowAfter === false);
  const scoopStructure = highNuts && (!lowPossible || facts.nutLow) && !quarterRisk && !sixthRisk;
  const pressure =
    Math.max(0, active.length - 1) * pack.multiwayAdjustment +
    Number(receipt.role === 'facing_raise') * pack.raiseFacingAdjustment;
  receipt.features = [
    highNuts && 'nut_high',
    highStrong && 'strong_high',
    nutDraw && 'nut_flush_draw',
    dominatedDraw && 'dominated_flush_draw',
    nutWrap && 'nut_wrap',
    facts.nutLow && pack.splitPot && 'nut_low',
    shape.backupLow && pack.splitPot && 'backup_low',
    counterfeit && pack.splitPot && 'counterfeit_exposure',
    lowOnly && 'low_only',
    lowPossible && highNuts && !facts.nutLow && 'high_only_on_split_board',
    quarterRisk && 'quarter_risk',
    sixthRisk && 'sixth_risk',
    e && e.scoopProbability >= 0.3 && 'sampled_scoop_potential',
    e &&
      e.minimumObservedShare >= 0.5 &&
      e.maximumObservedShare > 0.5 &&
      'sampled_freeroll_potential',
    e && e.perPot.length > 1 && 'separate_pot_eligibility',
    active.length > 1 && 'multiway',
    receipt.role === 'facing_raise' && 'raise_facing',
  ].filter(Boolean) as string[];
  if (!callCost) {
    if (
      scoopStructure ||
      (lower !== null && lower > pack.valueEquity + pressure) ||
      (highStrong && !lowPossible && equity !== null && equity > pack.protectionEquity + pressure)
    )
      return finishPriced('variant_value_bet', wager(spr < 2 ? 1 : 0.66));
    if (
      !lowOnly &&
      !quarterRisk &&
      !sixthRisk &&
      active.length === 1 &&
      receipt.position === 'button' &&
      (nutDraw || nutWrap) &&
      (!pack.splitPot || shape.backupLow)
    )
      return finishPriced('variant_draw_pressure', wager(0.5));
    return finishPriced(
      lowOnly ? 'low_only_protected_check' : 'variant_protected_check',
      passive()
    );
  }
  if (upper !== null && upper < price + pressure)
    return finishPriced('variant_price_fold', passive());
  if (scoopStructure && (s.stage === 'river' || spr <= 2))
    return finishPriced('variant_scoop_raise', wager(1));
  // Low-only strength must not turn a quarter/sixth into an expensive raise.
  // The actual combined, per-pot distribution still decides whether to call.
  if (quarterRisk || sixthRisk || lowOnly) {
    if (equity !== null)
      return finishPriced(
        equity >= price + pressure ? 'split_price_call' : 'split_price_fold',
        equity >= price + pressure ? call() : passive()
      );
    if (facts.nutLow && !counterfeit && price <= 0.125 && receipt.role !== 'facing_raise')
      return finishPriced('unmeasured_nut_low_small_call', call());
    return finishPriced('split_equity_unavailable', passive());
  }
  if (
    dominatedDraw &&
    !highNuts &&
    !highStrong &&
    spr > 3 &&
    price > 0.2 &&
    (lower === null || lower < price + 0.08)
  )
    return finishPriced('variant_dominated_draw_fold', passive());
  if (
    lower !== null &&
    lower > Math.max(price + pressure, pack.valueEquity + pressure) &&
    receipt.role !== 'call_off'
  )
    return finishPriced('variant_value_raise', wager(0.66));
  if (
    (equity !== null && equity >= price + pressure) ||
    (highNuts && !lowPossible) ||
    (!e && !lowPossible && price <= 0.2 && (highStrong || nutDraw || nutWrap))
  )
    return finishPriced('variant_price_call', call());
  return finishPriced(e ? 'variant_bluff_catcher_fold' : 'variant_uncalibrated_texture', passive());
}
