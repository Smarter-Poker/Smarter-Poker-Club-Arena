import type { HorseDecision, SeatPlayer } from '../../types.js';
import { horsePolicyDealtPlayers } from '../multiway/DealtSeatCensus.js';
import type { HorseGameStateV2 } from '../HorseLogic.js';
import {
  calculateBettingState,
  calculateContestablePot,
  calculateRake,
  validateAction,
} from '../PokerEngine.js';
import { nlhNutStatus } from '../HorseEval.js';
import { FIXED_LIMIT_MAX_WAGERS, fixedLimitStreetBounds } from '../BettingStructure.js';
import { omahaCardFacts } from '../omaha/OmahaCardFacts.js';
import {
  validOmahaVariantEquity,
  type OmahaVariantEquityEvidence,
} from '../omaha/OmahaVariantEquity.js';
import type {
  OmahaVariantMode,
  OmahaVariantRangeStatus,
  OmahaVariantReceipt,
} from '../omaha/OmahaVariantLivePolicy.js';
import { horseCanonicalMaterialSha256 } from '../HorseTournamentUtilityEvidence.js';
// Shared public seat/action geometry and legal choice kernel only. No Phase 10
// or Phase 11 hand-quality model, entry threshold or equity calibration.
import {
  plo4BlindSeatsStatus,
  plo4ButtonOffset,
  plo4CanonicalPosition,
  plo4DealerSeatIsValid,
  plo4Role,
  plo4SelectionOf,
  type Plo4BlindSeats,
} from '../plo4/Plo4LivePolicy.js';
import {
  PLO4_POSITIONS,
  PLO4_POSTFLOP_ROLES,
  PLO4_PREFLOP_ROLES,
  type Plo4NodeRole,
  type Plo4Position,
} from '../plo4/Plo4PolicyPack.js';
import {
  REMAINING_VARIANT_PACKS,
  REMAINING_VARIANT_DOMAIN,
  isRemainingPolicyVariant,
  remainingVariantSeatCap,
  remainingVariantHandShape,
  remainingVariantEntryBars,
  type RemainingPolicyVariant,
} from './RemainingVariantPolicyPack.js';
import {
  sampleRemainingVariantEquity,
  type RemainingVariantEquityEvidence,
  type RemainingVariantRangeProvenance,
  type RemainingVariantTerminalShowdowns,
} from './RemainingVariantSampler.js';
import {
  remainingVariantActionEconomics,
  remainingVariantActionEconomicsIsValid,
  type RemainingVariantActionEconomics,
} from './RemainingVariantActionEconomics.js';

// Receipt shape and public geometry are common contracts. Hand shape, ranges,
// thresholds, card rules and wager sizing are supplied by the actual variant.
export type RemainingVariantMode = OmahaVariantMode;
/** P12.1: the Phase 10/11 range-status vocabulary, applied to this sampler. */
export type RemainingVariantRangeStatus = OmahaVariantRangeStatus;

/**
 * The complete budget-refusal vocabulary for an eligible decision that never
 * reaches a firing proposal. The sampler can exhaust its own earlier deadline
 * before it produces equity, while the overall policy can exhaust the later
 * live-work deadline. Both outcomes are safe reference-action refusals and
 * both must remain named for receipts, validators and release evidence.
 */
export const REMAINING_VARIANT_UNFIRED_BUDGET_REFUSALS = Object.freeze([
  'equity_budget_unavailable',
  'work_budget',
] as const);

export type RemainingVariantUnfiredBudgetRefusal =
  (typeof REMAINING_VARIANT_UNFIRED_BUDGET_REFUSALS)[number];

export function remainingVariantUnfiredBudgetRefusalIsValid(
  value: unknown
): value is RemainingVariantUnfiredBudgetRefusal {
  return REMAINING_VARIANT_UNFIRED_BUDGET_REFUSALS.some((reason) => reason === value);
}

/**
 * P12.1: the facts a Short Deck, Crazy Pineapple, Fixed Limit Hold'em or
 * Fixed Limit Omaha Eight-or-Better proposal actually consumed, copied and
 * frozen when it was computed. A private receipt field: never public state or
 * telemetry, and it holds no card value of any kind (board and hole cards are
 * counted, never listed). The census, positions and depth have the meaning of
 * the Phase 11 binding: positions come from the blind seats the engine posted,
 * never from the button alone. Variant-specific: the deck, the betting
 * structure's own geometry (no-limit wager cap, or the fixed-limit street bet,
 * completion increment, wager count and cap), the Pineapple private-card
 * counts, and the variant sampler's own range provenance.
 */
export interface RemainingVariantInputBinding {
  readonly version: 'remaining-variant-input-binding-v1';
  readonly variant: RemainingPolicyVariant;
  readonly mode: 'cash' | 'tournament';
  readonly pack: Readonly<{
    version: string;
    holes: 2 | 3 | 4;
    deck: 36 | 52;
    splitPot: boolean;
    bettingStructure: 'no_limit' | 'fixed_limit';
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
      /** The cards the score was computed from: Pineapple's three before the
       * discard and its retained pair after it. */
      cardsScored: 2 | 3 | 4;
      kind: 'heuristic_entry_score';
      probability: false;
    }>;
  }>;
  /** Counts only; never a card value. */
  readonly privateCards: Readonly<{
    heroHoleCards: 2 | 3 | 4;
    /** Pineapple after the discard: the hero's own accepted discard (1). */
    heroKnownDeadCards: 0 | 1;
    postDiscard: boolean;
    cardValues: 'not_recorded';
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
    hero: Plo4Position;
    heroOffset: number;
    role: Plo4NodeRole;
    aggressor: Plo4Position | null;
    aggressorSeat: number | null;
    straddle: 'table_enabled_utg_2bb' | 'none';
  }>;
  readonly geometry: Readonly<{
    bettingStructure: 'no_limit' | 'fixed_limit';
    /** The unit the proposal's wagers land on: the horse legalizer's own unit,
     * whole chips whenever the big blind is whole, cents otherwise. */
    chipUnit: 0.01 | 1;
    bigBlind: number;
    pot: number;
    currentBet: number;
    heroBet: number;
    heroStack: number;
    callCost: number;
    minRaiseTo: number | null;
    maxRaiseTo: number | null;
    stackRaiseTo: number;
    ante: number;
    anteBB: number;
    rake: Readonly<{
      percent: number;
      cap: number;
      noFlopNoDrop: boolean;
      playerCountCaps: ReadonlyArray<Readonly<{ players: number; cap: number }>> | null;
      dealtCount: number;
    }>;
    /** No limit only: the largest wager the proposal may reach. */
    noLimit: Readonly<{ wagerCap: number | null }> | null;
    /** Fixed limit only: the controller's canonical street geometry. */
    fixedLimit: Readonly<{
      /** The hand's effective small bet (a kill hand's own, else the big blind). */
      smallBet: number;
      streetBet: number;
      /** `fixedLimitStreetBounds.raiseSize`: the street bet, or the completion
       * of a short opening below half a bet. */
      completionIncrement: number;
      completion: boolean;
      wagersThisStreet: number;
      maxWagers: number;
      wagersCapped: boolean;
      /** Whether the controller's own menu offers a sized wager (cap and
       * reopening already applied). */
      wagerOpen: boolean;
      /** The one legal wager amount when open; null otherwise. */
      canonicalWagerTo: number | null;
    }> | null;
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
    /** FLO8 postflop: whether a qualifying low can still be made. */
    lowPossible: boolean | null;
    features: readonly string[];
  }>;
  readonly range: Readonly<{
    status: RemainingVariantRangeStatus;
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
    provenance: RemainingVariantRangeProvenance | null;
  }>;
}

export type RemainingVariantReceipt = Omit<OmahaVariantReceipt, 'equity' | 'inputs'> & {
  /** The validated equity evidence actually consumed, copied; null otherwise. */
  equity: RemainingVariantEquityEvidence | null;
  /** P12.1: frozen inputs of an eligible proposal; null when it was refused.
   * Absent on retained receipts. */
  inputs?: RemainingVariantInputBinding | null;
  /**
   * P12-B (#6151): the explicit per-action net chip economics of the FLH/FLO8
   * river node, or a NAMED unavailable result; absent everywhere else and on
   * retained receipts. Diagnostic: nothing reads it to decide. Priced AFTER
   * the policy has finished, on its own budget (`netActionBudgetMs`), so its
   * cost is not in `latencyMs`; it reports its own `analysisMs`.
   */
  actionEconomics?: RemainingVariantActionEconomics | null;
};

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
const near = (a: unknown, b: number, tolerance = 1e-6) =>
  typeof a === 'number' && Math.abs(a - b) <= tolerance;

const RANGE_STATUSES: readonly RemainingVariantRangeStatus[] = [
  'not_consumed_preflop',
  'unavailable',
  'rejected_malformed',
  'rejected_population',
  'consumed_unattributed',
  'consumed',
];

// ── Legal form ────────────────────────────────────────────────────────────
// P12.1: every proposal is already in the form HorseLogic.legalize produces,
// so the legalizer leaves it unchanged. These mirror that function for the two
// structures this pack proposes in (no limit and fixed limit; pot limit never
// reaches this policy): wagers land on the legalizer's chip step and its
// near-stack all-in rules, a call that covers the stack is the all-in the
// menu accepts, and the final clamp is the controller's own [minRaiseTo,
// maxRaiseTo]. RemainingVariantLegalForm.test.ts runs the real legalizer over
// real controller spots for every variant and refuses any rewrite.
const toCents = (n: number) => Math.round(n * 100) / 100;
const ceilCents = (n: number) => Math.ceil(n * 100 - 1e-9) / 100;
const snapDown = (n: number, step: number) =>
  step === 1 ? Math.floor(n + 1e-9) : Math.floor(n * 100 + 1e-9) / 100;
const snapUp = (n: number, step: number) =>
  step === 1 ? Math.ceil(n - 1e-9) : Math.ceil(n * 100 - 1e-9) / 100;
const snapBetSize = (amount: number, min: number, max: number, step: number) => {
  if (!Number.isFinite(amount)) return min;
  let out = snapDown(amount, step);
  if (out < min) out = snapUp(min, step);
  if (out > max) {
    const capped = snapDown(max, step);
    out = capped >= min ? capped : min;
  }
  return out;
};

/** The legalizer's chip step: whole chips whenever the big blind is whole. */
export function remainingVariantChipUnit(bigBlind: number): 0.01 | 1 {
  return typeof bigBlind === 'number' && bigBlind >= 1 && Number.isInteger(bigBlind) ? 1 : 0.01;
}

/** The decision HorseLogic.legalize would make of `d` at this state, for the
 * no-limit and fixed-limit structures. Think time is carried, not reset. */
export function remainingVariantLegalForm(
  d: HorseDecision,
  hero: SeatPlayer,
  s: HorseGameStateV2
): HorseDecision {
  const thinkTime = d.thinkTime;
  const currentBet = Number.isFinite(s.currentBet) ? Math.max(0, s.currentBet) : 0;
  const pot = Number.isFinite(s.pot) ? Math.max(0, s.pot) : 0;
  const playerBet = Number.isFinite(hero.bet) ? Math.max(0, hero.bet) : 0;
  const stack = Number.isFinite(hero.stack) ? Math.max(0, hero.stack) : 0;
  const toCall = Math.max(0, currentBet - playerBet);
  const step = remainingVariantChipUnit(s.bigBlind);
  const verify = (wager: HorseDecision, fallback: HorseDecision): HorseDecision => {
    const bs = calculateBettingState(
      s.pot,
      s.currentBet,
      hero.bet,
      s.bigBlind || 0.02,
      s.lastRaise ?? s.minRaise,
      false
    );
    const amounts =
      step === 1
        ? [
            wager.amount!,
            wager.amount! + 1,
            wager.amount! - 1,
            toCents(wager.amount! + 0.01),
            toCents(wager.amount! - 0.01),
          ]
        : [wager.amount!, toCents(wager.amount! + 0.01), toCents(wager.amount! - 0.01)];
    for (const amount of amounts)
      if (amount > 0 && validateAction(wager.action, amount, hero.stack, bs).valid)
        return { action: wager.action, amount, thinkTime: 0 };
    return fallback;
  };
  // The structural pass (HorseLogic.legalizeInner, no pot limit).
  const structural = (): HorseDecision => {
    let x = d;
    if (x.action === 'check' && toCall > 0) x = { action: 'fold', thinkTime: 0 };
    if (x.action === 'fold' && toCall === 0) x = { action: 'check', thinkTime: 0 };
    if (x.action === 'call' && toCall === 0) x = { action: 'check', thinkTime: 0 };
    if (x.action === 'bet' && currentBet > 0)
      x = { action: 'raise', amount: x.amount, thinkTime: 0 };
    if (x.action === 'raise' && currentBet === 0)
      x = { action: 'bet', amount: x.amount, thinkTime: 0 };
    if (x.action === 'call')
      return toCall >= stack
        ? { action: 'all_in', thinkTime: 0 }
        : { action: 'call', amount: toCents(toCall), thinkTime: 0 };
    if (x.action === 'bet') {
      let amt = x.amount ?? s.minRaise;
      if (!Number.isFinite(amt) || amt <= 0) return { action: 'check', thinkTime: 0 };
      const minBet = ceilCents(Math.max(s.minRaise || 0, 0.01));
      if (minBet >= stack) return { action: 'all_in', thinkTime: 0 };
      amt = snapBetSize(amt, minBet, stack, step);
      if (amt >= stack * 0.92) return { action: 'all_in', thinkTime: 0 };
      return verify(
        { action: 'bet', amount: toCents(amt), thinkTime: 0 },
        {
          action: 'check',
          thinkTime: 0,
        }
      );
    }
    if (x.action === 'raise') {
      let amt = x.amount ?? 0;
      const fallback = (): HorseDecision =>
        toCall > 0
          ? toCall >= stack
            ? { action: 'all_in', thinkTime: 0 }
            : { action: 'call', amount: toCents(toCall), thinkTime: 0 }
          : { action: 'check', thinkTime: 0 };
      if (!Number.isFinite(amt) || amt <= 0) return fallback();
      const minRaiseTo = ceilCents(currentBet + Math.max(s.minRaise || 0, 0.01));
      const maxRaiseTo = playerBet + stack;
      if (minRaiseTo > maxRaiseTo)
        return amt >= maxRaiseTo ? { action: 'all_in', thinkTime: 0 } : fallback();
      amt = snapBetSize(amt, minRaiseTo, maxRaiseTo, step);
      if (amt >= maxRaiseTo * 0.95) return { action: 'all_in', thinkTime: 0 };
      return verify({ action: 'raise', amount: toCents(amt), thinkTime: 0 }, fallback());
    }
    return x;
  };
  // The authoritative menu pass (HorseLogic enforceAuthoritativeDecision).
  const decision = structural();
  const out = ((): HorseDecision => {
    if (s.stateSchemaVersion !== 1 || !Array.isArray(s.legalActions)) return decision;
    const legal = new Set(s.legalActions);
    const owed = Number.isFinite(s.toCall)
      ? Math.max(0, s.toCall as number)
      : Math.max(0, s.currentBet - hero.bet);
    const safe = (): HorseDecision => {
      if (owed <= 0.005 && legal.has('check')) return { action: 'check', thinkTime: 0 };
      if (legal.has('fold')) return { action: 'fold', thinkTime: 0 };
      if (legal.has('check')) return { action: 'check', thinkTime: 0 };
      if (legal.has('call'))
        return { action: 'call', amount: toCents(Math.min(owed, stack)), thinkTime: 0 };
      return { action: 'fold', thinkTime: 0 };
    };
    const call = (): HorseDecision => {
      if (!legal.has('call')) return safe();
      if (owed >= stack - 0.005 && legal.has('all_in')) return { action: 'all_in', thinkTime: 0 };
      return { action: 'call', amount: toCents(Math.min(owed, stack)), thinkTime: 0 };
    };
    if (decision.action === 'call') return call();
    if (decision.action === 'check') return legal.has('check') ? decision : safe();
    if (decision.action === 'fold') {
      const normalized =
        owed <= 0.005 && legal.has('check') ? { action: 'check' as const, thinkTime: 0 } : safe();
      return normalized.action === 'fold' ? { ...decision, ...normalized } : normalized;
    }
    if (decision.action === 'all_in' && legal.has('all_in')) return decision;
    let wagerAction: 'bet' | 'raise' | null = null;
    if (decision.action === 'bet' || decision.action === 'raise' || decision.action === 'all_in') {
      const contextual = s.currentBet > 0 ? 'raise' : 'bet';
      if (legal.has(contextual)) wagerAction = contextual;
    }
    if (!wagerAction)
      return decision.action === 'raise' || decision.action === 'all_in' ? call() : safe();
    const minTo = s.minRaiseTo;
    const maxTo = s.maxRaiseTo;
    if (
      typeof minTo !== 'number' ||
      !Number.isFinite(minTo) ||
      typeof maxTo !== 'number' ||
      !Number.isFinite(maxTo) ||
      maxTo < minTo - 0.005
    )
      return wagerAction === 'raise' ? call() : safe();
    const requested =
      decision.action === 'all_in'
        ? maxTo
        : Number.isFinite(decision.amount)
          ? decision.amount!
          : minTo;
    return {
      action: wagerAction,
      amount: toCents(Math.max(minTo, Math.min(maxTo, requested))),
      thinkTime: 0,
    };
  })();
  return { ...out, thinkTime };
}

/**
 * Labels, shape and internal consistency of the Phase 12 sampler's
 * provenance. With `population`, the scored opponents must be exactly this
 * decision's contesting opponents (seat and user), the deck must be this
 * variant's deck occupied by every other dealt seat with the hero's own known
 * discard excluded, and the work must be the sample's own work.
 */
export function remainingVariantRangeProvenanceIsValid(
  value: unknown,
  population?: Readonly<{
    variant: RemainingPolicyVariant;
    contesting: ReadonlyArray<Readonly<{ userId: string; seat: number }>>;
    dealtOpponents: number;
    heroKnownDeadCards: number;
    samples: number;
    requestedSamples: number | undefined;
  }>
): value is RemainingVariantRangeProvenance {
  if (
    !exact(value, [
      'version',
      'source',
      'calibration',
      'solverInput',
      'reads',
      'prior',
      'deck',
      'discard',
      'work',
      'opponents',
    ]) ||
    value.version !== 'remaining-variant-range-provenance-v1' ||
    value.source !== 'variant_public_line_sequential_prior' ||
    value.calibration !== 'uncalibrated' ||
    value.solverInput !== false ||
    value.reads !== 'public_action_line_only' ||
    !exact(value.prior, ['attemptsPerSeat', 'finalAttempt', 'seatDraws', 'uniformEscapes']) ||
    value.prior.attemptsPerSeat !== 3 ||
    value.prior.finalAttempt !== 'uniform_escape' ||
    !count(value.prior.seatDraws, 4096 * 9) ||
    !count(value.prior.uniformEscapes, value.prior.seatDraws as number) ||
    !exact(value.deck, ['physical', 'size', 'dealtOpponents', 'heroKnownDeadCards']) ||
    value.deck.physical !== 'single_deck_excluding_hero_known_and_board' ||
    (value.deck.size !== 36 && value.deck.size !== 52) ||
    !count(value.deck.dealtOpponents, 9) ||
    (value.deck.dealtOpponents as number) < 1 ||
    (value.deck.heroKnownDeadCards !== 0 && value.deck.heroKnownDeadCards !== 1) ||
    !(
      value.discard === null ||
      (exact(value.discard, ['opponents', 'hero', 'actualOpponentDiscardsRead']) &&
        value.discard.opponents === 'declared_flop_only_structural_prior' &&
        (value.discard.hero === 'declared_flop_only_structural_prior'
          ? value.deck.heroKnownDeadCards === 0
          : value.discard.hero === 'accepted_private_discard' &&
            value.deck.heroKnownDeadCards === 1) &&
        value.discard.actualOpponentDiscardsRead === false)
    ) ||
    (value.discard === null && value.deck.heroKnownDeadCards !== 0) ||
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
      !count(row.raises, REMAINING_VARIANT_DOMAIN.maxActionsPerHand) ||
      !count(row.calls, REMAINING_VARIANT_DOMAIN.maxActionsPerHand)
    )
      return false;
    ids.add(row.userId);
    seats.add(row.seat as number);
  }
  if (!population) return true;
  const rows = value.opponents as ReadonlyArray<{ userId: string; seat: number }>;
  return (
    value.deck.size === REMAINING_VARIANT_PACKS[population.variant].deck &&
    (value.discard !== null) === (population.variant === 'pineapple') &&
    value.deck.heroKnownDeadCards === population.heroKnownDeadCards &&
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
 * the caller's object (the P11.1 defect 4 class). */
function copyEvidence(e: RemainingVariantEquityEvidence): RemainingVariantEquityEvidence {
  return Object.freeze({
    ...e,
    confidence99: Object.freeze([e.confidence99[0], e.confidence99[1]]) as unknown as [
      number,
      number,
    ],
    distribution: Object.freeze(
      e.distribution.map((b) => Object.freeze({ share: b.share, probability: b.probability }))
    ) as unknown as RemainingVariantEquityEvidence['distribution'],
    perPot: Object.freeze(
      e.perPot.map((p) =>
        Object.freeze({
          ...p,
          eligiblePlayers: Object.freeze([...p.eligiblePlayers]) as unknown as string[],
        })
      )
    ) as unknown as RemainingVariantEquityEvidence['perPot'],
  });
}

/** Worker-boundary shape check of a returned Phase 12 binding. It does not
 * recompute the proposal; the journal reviewer binds it to the original
 * request. Positions must be the canonical positions of the recorded button,
 * census and posted blind seats, and the betting geometry must be the one the
 * pack's structure defines. */
export function remainingVariantInputBindingIsValid(
  value: unknown
): value is RemainingVariantInputBinding {
  if (
    !exact(value, [
      'version',
      'variant',
      'mode',
      'pack',
      'approximation',
      'privateCards',
      'census',
      'positions',
      'geometry',
      'depth',
      'board',
      'range',
    ]) ||
    value.version !== 'remaining-variant-input-binding-v1' ||
    !isRemainingPolicyVariant(value.variant) ||
    (value.mode !== 'cash' && value.mode !== 'tournament')
  )
    return false;
  const variant = value.variant;
  const packDef = REMAINING_VARIANT_PACKS[variant];
  const limit = packDef.structure === 'fixed_limit';
  const tournament = value.mode === 'tournament';
  const cap = remainingVariantSeatCap(variant, value.mode);
  const { pack, approximation, privateCards, census, positions, geometry, depth, board, range } =
    value;
  const maxStackBB = limit
    ? REMAINING_VARIANT_DOMAIN.fixedLimitMaxStackBB
    : REMAINING_VARIANT_DOMAIN.maxStackBB;
  if (
    cap < 2 ||
    !exact(pack, [
      'version',
      'holes',
      'deck',
      'splitPot',
      'bettingStructure',
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
    pack.deck !== packDef.deck ||
    pack.splitPot !== packDef.splitLow ||
    pack.bettingStructure !== packDef.structure ||
    pack.source !== REMAINING_VARIANT_DOMAIN.source ||
    pack.calibratedConfidence !== null ||
    !Array.isArray(pack.seats) ||
    pack.seats.length !== 2 ||
    pack.seats[0] !== 2 ||
    pack.seats[1] !== cap ||
    pack.seatCapOwner !== (tournament ? 'tournament_deck_capacity' : 'cash_table_seating') ||
    pack.maxStackBB !== maxStackBB ||
    pack.maxAnteBB !== REMAINING_VARIANT_DOMAIN.maxAnteBB ||
    pack.maxRakePercent !== REMAINING_VARIANT_DOMAIN.maxRakePercent ||
    !exact(approximation, ['status', 'solverInput', 'handShape']) ||
    ![
      'explicit_variant_heuristic',
      'explicit_variant_heuristic_with_uncalibrated_range_sample',
    ].includes(approximation.status as string) ||
    approximation.solverInput !== false ||
    !exact(approximation.handShape, ['score', 'cardsScored', 'kind', 'probability']) ||
    !unit(approximation.handShape.score) ||
    approximation.handShape.kind !== 'heuristic_entry_score' ||
    approximation.handShape.probability !== false
  )
    return false;
  const street = object(board) ? board.street : undefined;
  if (!['preflop', 'flop', 'turn', 'river'].includes(street as string)) return false;
  const postDiscard = variant === 'pineapple' && street !== 'preflop';
  if (
    !exact(privateCards, ['heroHoleCards', 'heroKnownDeadCards', 'postDiscard', 'cardValues']) ||
    privateCards.postDiscard !== postDiscard ||
    privateCards.heroHoleCards !== (postDiscard ? 2 : packDef.holes) ||
    privateCards.heroKnownDeadCards !== (postDiscard ? 1 : 0) ||
    privateCards.cardValues !== 'not_recorded' ||
    approximation.handShape.cardsScored !== privateCards.heroHoleCards
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
    census.dealtSeats.length < 2 ||
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
  // An empty dealer or a dead small blind exists only at a tournament table.
  if (
    (!(census.dealtSeats as number[]).includes(census.dealerSeat as number) ||
      (census.blindSeats as Plo4BlindSeats).smallBlind === null) &&
    !tournament
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
    !PLO4_POSITIONS.includes(positions.hero as Plo4Position) ||
    positions.heroOffset !==
      plo4ButtonOffset(
        census.heroSeat as number,
        census.dealerSeat as number,
        census.dealtSeats as number[]
      ) ||
    positions.hero !== positionOf(census.heroSeat as number) ||
    !roles.includes(positions.role as string) ||
    // A small fixed-limit stack has no no-limit reshove branch.
    (limit && positions.role === 'reshove') ||
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
      'stackRaiseTo',
      'ante',
      'anteBB',
      'rake',
      'noLimit',
      'fixedLimit',
      'postflop',
    ]) ||
    geometry.bettingStructure !== packDef.structure ||
    ![
      geometry.bigBlind,
      geometry.pot,
      geometry.currentBet,
      geometry.heroBet,
      geometry.heroStack,
      geometry.callCost,
      geometry.stackRaiseTo,
      geometry.ante,
      geometry.anteBB,
    ].every(finite) ||
    !(geometry.bigBlind as number) ||
    !(geometry.heroStack as number) ||
    geometry.chipUnit !== remainingVariantChipUnit(geometry.bigBlind as number) ||
    (geometry.anteBB as number) > REMAINING_VARIANT_DOMAIN.maxAnteBB ||
    !near(geometry.anteBB, (geometry.ante as number) / (geometry.bigBlind as number)) ||
    ![geometry.minRaiseTo, geometry.maxRaiseTo].every(nullableFinite) ||
    (geometry.minRaiseTo === null) !== (geometry.maxRaiseTo === null) ||
    !near(
      geometry.callCost,
      Math.min(
        geometry.heroStack as number,
        Math.max(0, (geometry.currentBet as number) - (geometry.heroBet as number))
      )
    ) ||
    !near(geometry.stackRaiseTo, (geometry.heroBet as number) + (geometry.heroStack as number)) ||
    !exact(geometry.rake, ['percent', 'cap', 'noFlopNoDrop', 'playerCountCaps', 'dealtCount']) ||
    !finite(geometry.rake.percent) ||
    (geometry.rake.percent as number) > REMAINING_VARIANT_DOMAIN.maxRakePercent ||
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
  if (limit) {
    const f = geometry.fixedLimit;
    if (
      geometry.noLimit !== null ||
      !exact(f, [
        'smallBet',
        'streetBet',
        'completionIncrement',
        'completion',
        'wagersThisStreet',
        'maxWagers',
        'wagersCapped',
        'wagerOpen',
        'canonicalWagerTo',
      ]) ||
      ![f.smallBet, f.streetBet, f.completionIncrement].every(finite) ||
      !(f.smallBet as number) ||
      !near(
        f.streetBet,
        (f.smallBet as number) * (street === 'turn' || street === 'river' ? 2 : 1)
      ) ||
      !(f.completionIncrement as number) ||
      (f.completionIncrement as number) > (f.streetBet as number) + 1e-9 ||
      f.completion !==
        Math.abs((f.completionIncrement as number) - (f.streetBet as number)) > 0.005 ||
      // A completion finishes an opening below half a bet, so it is more than half.
      (f.completion && (f.completionIncrement as number) <= (f.streetBet as number) / 2) ||
      !count(f.wagersThisStreet, REMAINING_VARIANT_DOMAIN.maxActionsPerHand) ||
      f.maxWagers !== FIXED_LIMIT_MAX_WAGERS ||
      typeof f.wagersCapped !== 'boolean' ||
      typeof f.wagerOpen !== 'boolean' ||
      (f.wagerOpen && f.wagersCapped) ||
      f.wagerOpen !== (f.canonicalWagerTo !== null) ||
      (f.wagerOpen &&
        (!finite(f.canonicalWagerTo) ||
          !near(
            f.canonicalWagerTo,
            (geometry.currentBet as number) + (f.completionIncrement as number),
            0.011
          ) ||
          !near(geometry.minRaiseTo, f.canonicalWagerTo as number, 0.011) ||
          !near(geometry.maxRaiseTo, f.canonicalWagerTo as number, 0.011)))
    )
      return false;
  } else if (
    geometry.fixedLimit !== null ||
    !exact(geometry.noLimit, ['wagerCap']) ||
    (geometry.maxRaiseTo === null
      ? geometry.noLimit.wagerCap !== null
      : !near(
          geometry.noLimit.wagerCap,
          Math.min(geometry.maxRaiseTo as number, geometry.stackRaiseTo as number)
        ))
  )
    return false;
  if (
    !exact(depth, ['effectiveBB', 'heroCoverBB', 'deepestOpponentCoverBB', 'basis']) ||
    ![depth.effectiveBB, depth.heroCoverBB, depth.deepestOpponentCoverBB].every(finite) ||
    !(depth.effectiveBB as number) ||
    (depth.effectiveBB as number) > maxStackBB ||
    !near(
      depth.effectiveBB,
      Math.min(depth.heroCoverBB as number, depth.deepestOpponentCoverBB as number)
    ) ||
    !near(depth.heroCoverBB, (geometry.stackRaiseTo as number) / (geometry.bigBlind as number)) ||
    depth.basis !== 'stack_plus_street_bet_vs_deepest_contesting_opponent' ||
    !exact(board, ['street', 'cards', 'paired', 'flushBoard', 'lowPossible', 'features']) ||
    board.cards !== { preflop: 0, flop: 3, turn: 4, river: 5 }[street as 'flop'] ||
    (street === 'preflop') !== (board.paired === null) ||
    (street === 'preflop') !== (board.flushBoard === null) ||
    (street === 'preflop') !== (geometry.postflop === null) ||
    (street === 'preflop' || !packDef.splitLow) !== (board.lowPossible === null) ||
    (board.paired !== null && typeof board.paired !== 'boolean') ||
    (board.flushBoard !== null && typeof board.flushBoard !== 'boolean') ||
    (board.lowPossible !== null && typeof board.lowPossible !== 'boolean') ||
    !Array.isArray(board.features) ||
    board.features.length > 24 ||
    board.features.some((f) => typeof f !== 'string' || !/^[a-z0-9][a-z0-9_]{0,63}$/.test(f))
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
    !RANGE_STATUSES.includes(range.status as RemainingVariantRangeStatus)
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
    (packDef.splitLow || (range.lowEquity as number) === 0) &&
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
      (remainingVariantRangeProvenanceIsValid(range.provenance) &&
        range.provenance.work.completedSamples === range.samples &&
        range.provenance.opponents.length === (census.contestingOpponentSeats as number[]).length &&
        range.provenance.opponents.every((row) =>
          (census.contestingOpponentSeats as number[]).includes(row.seat)
        ) &&
        range.provenance.deck.dealtOpponents === (census.dealtSeats as number[]).length - 1 &&
        range.provenance.deck.size === packDef.deck &&
        range.provenance.deck.heroKnownDeadCards === privateCards.heroKnownDeadCards &&
        (range.provenance.discard !== null) === (variant === 'pineapple')))
  );
}

/** The returned receipt's P12.1 fields: an eligible proposal carries a valid
 * binding of its own variant and pack, and an ineligible one carries none. A
 * retained receipt without the field claims no binding and is not refused. */
export function remainingVariantReceiptBindingIsValid(value: unknown): boolean {
  if (!object(value)) return false;
  return inputBindingIsValid(value) && actionEconomicsBindingIsValid(value);
}

function inputBindingIsValid(value: Record<string, unknown>): boolean {
  if (!Object.hasOwn(value, 'inputs')) return true;
  if (value.inputs === null) return value.eligible === false;
  return (
    value.eligible === true &&
    remainingVariantInputBindingIsValid(value.inputs) &&
    value.inputs.variant === value.variant &&
    value.inputs.pack.version === value.version
  );
}

/**
 * P12-B (#6151): the net-action field is re-checked against this running
 * module, not merely carried: an eligible FLH/FLO8 river receipt must declare
 * the receipt's own variant and street and a result the economics validator
 * accepts, and the `net_action_economics` feature must be present exactly when
 * a result is available. A receipt without the field claims no economics.
 */
function actionEconomicsBindingIsValid(receipt: Record<string, unknown>): boolean {
  const features = Array.isArray(receipt.features) ? (receipt.features as unknown[]) : [];
  const tagged = features.includes('net_action_economics');
  if (!Object.hasOwn(receipt, 'actionEconomics')) return !tagged;
  const economics = receipt.actionEconomics;
  if (economics === null) return receipt.eligible === false && !tagged;
  if (!remainingVariantActionEconomicsIsValid(economics)) return false;
  const bound = economics as RemainingVariantActionEconomics;
  return (
    receipt.eligible === true &&
    bound.variant === receipt.variant &&
    bound.street === receipt.street &&
    receipt.street === 'river' &&
    tagged === (bound.unavailable === null)
  );
}

/** Canonical private commitment carried by the execution witness. */
export function remainingVariantInputBindingSha256(binding: RemainingVariantInputBinding): string {
  return horseCanonicalMaterialSha256(binding);
}

export function evaluateRemainingVariantPolicy(
  hero: SeatPlayer,
  s: HorseGameStateV2,
  baseline: HorseDecision,
  /** External evidence may arrive in the shared shape; its provenance must be
   * this sampler's own or absent (consumed but unattributed). */
  supplied: RemainingVariantEquityEvidence | OmahaVariantEquityEvidence | null,
  mode: RemainingVariantMode = 'shadow',
  now = () => performance.now(),
  decisionEquityCeiling = 1,
  sampleWhenMissing = true
) {
  const start = now(),
    variant = isRemainingPolicyVariant(s.gameVariant) ? s.gameVariant : null;
  const pack = variant ? REMAINING_VARIANT_PACKS[variant] : null;
  // A foreign provenance is refused below by the population check.
  let evidence = supplied as RemainingVariantEquityEvidence | null;
  const externalMs = evidence
    ? Number.isFinite(evidence.analysisMs) && evidence.analysisMs >= 0
      ? evidence.analysisMs
      : Infinity
    : 0;
  const receipt: RemainingVariantReceipt = {
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
    // P12.1: set only to a frozen copy of evidence the proposal consumed.
    equity: null,
    callPrice: null,
    inputs: null,
    utilityOwner: s.gameMode === 'tournament' ? 'phase7_pending' : 'cash',
    latencyMs: 0,
    executionStatus: 'pending',
    executedAction: null,
    executedAmount: null,
    // P12.3: the Phase 10/11 selection vocabulary; the worker binds its
    // authority receipt, the main scheduler its acceptance-time verdict.
    selection: 'none',
    selectionRefusal: null,
    authority: null,
    authorityVerdict: null,
  };
  /** Assembled only once every canonical check has passed. */
  let bind: (() => RemainingVariantInputBinding) | null = null;
  const finish = (reason: string, proposal = baseline) => {
    // Bound inside the timed region: recording the inputs is policy work.
    if (bind) receipt.inputs = bind();
    const elapsed = Math.max(0, now() - start) + externalMs;
    if (elapsed > REMAINING_VARIANT_DOMAIN.liveBudgetMs) {
      reason = 'work_budget';
      proposal = baseline;
      receipt.fired = false;
    }
    if (!s.legalActions?.includes(proposal.action)) {
      reason = 'proposal_outside_legal_menu';
      proposal = baseline;
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
  if (variant === 'pineapple' && s.gameMode === 'tournament')
    return finish('pineapple_tournament_unapproved');
  if (s.gameMode === 'tournament' && s.format === 'spin') return finish('variant_spin_unavailable');
  if (
    s.bombPot ||
    (s.boardCount ?? 1) !== 1 ||
    s.communityCards2?.length ||
    s.communityCards3?.length
  )
    return finish('multiboard_owned_by_phase13');
  if (s.stage === 'pineapple_discard') return finish('discard_owned_by_worker');
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
    s.bettingStructure !== pack.structure ||
    !['cash', 'tournament'].includes(s.gameMode ?? '') ||
    seats.length < 2 ||
    !seats.some(
      (p) =>
        p.user_id === hero.user_id &&
        p.seat === hero.seat &&
        p.stack === hero.stack &&
        p.bet === hero.bet &&
        p.totalInvested === hero.totalInvested
    ) ||
    // P12.1: a tournament dead button (an empty physical dealer seat at three
    // or more dealt) is a valid engine state, as P10.1 defect 3 and P11.1
    // defect 1 found for the Omaha packs.
    !plo4DealerSeatIsValid(s.dealerSeat, dealt, tournamentTable) ||
    new Set(seats.map((p) => p.seat)).size !== seats.length ||
    new Set(seats.map((p) => p.user_id)).size !== seats.length ||
    !s.legalActions?.includes(baseline.action)
  )
    return finish('canonical_state_unavailable');
  // P12.1: a valid census larger than the pack's ceiling for this mode is
  // outside the declared domain, not an unavailable canonical state.
  const seatCap = remainingVariantSeatCap(variant, tournamentTable ? 'tournament' : 'cash');
  if (seats.length > seatCap) return finish('seat_count_outside_pack');
  // Positions come from the blinds the engine posted (P10.1 F3/F5, P11.1). A
  // state without them is refused by name; blind seats the engine could not
  // have posted with this button are malformed.
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
    hero.is_all_in ||
    hero.is_sitting_out ||
    hero.stack <= 0 ||
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
    Math.abs(s.players.reduce((n, p) => n + p.totalInvested, 0) - s.pot) > 0.011
  )
    return finish('invalid_geometry');
  const canWager = s.legalActions.some((a) => a === 'bet' || a === 'raise');
  if (
    canWager &&
    (!Number.isFinite(s.minRaiseTo) ||
      !Number.isFinite(s.maxRaiseTo) ||
      s.minRaiseTo! <= s.currentBet ||
      s.maxRaiseTo! < s.minRaiseTo!)
  )
    return finish('invalid_wager_geometry');
  const limit = pack.structure === 'fixed_limit';
  // KILL POT (kill-v1): a kill hand is sized from its effective small bet.
  const smallBet = s.fixedLimitSmallBet ?? s.bigBlind;
  const fixedSize = smallBet * (['turn', 'river'].includes(s.stage) ? 2 : 1);
  const fixedBounds = limit
    ? fixedLimitStreetBounds(s.actionHistory ?? [], s.stage, fixedSize, s.currentBet)
    : null;
  const fixedRaise = fixedBounds?.raiseSize ?? 0;
  if (
    limit &&
    (s.fixedBetSize !== fixedSize ||
      (s.wagersCapped && canWager) ||
      (canWager &&
        (Math.abs(s.minRaiseTo! - (s.currentBet + fixedRaise)) > 0.011 ||
          Math.abs(s.maxRaiseTo! - s.minRaiseTo!) > 0.011)))
  )
    return finish('fixed_limit_geometry_unavailable');
  const active = seats.filter(
    (p) => p.user_id !== hero.user_id && !p.is_folded && (!p.is_sitting_out || p.is_all_in)
  );
  const deepestOpponentCover = Math.max(...active.map((p) => p.stack + p.bet));
  const depth = Math.min(hero.stack + hero.bet, deepestOpponentCover) / s.bigBlind;
  const maxStackBB = limit
    ? REMAINING_VARIANT_DOMAIN.fixedLimitMaxStackBB
    : REMAINING_VARIANT_DOMAIN.maxStackBB;
  // Reachability 2026-10-08: with every live opponent away (sitting out, not
  // all-in) no seat can cover, the depth is -Infinity and the pack refuses it
  // below. The receipt records that as an unavailable depth: a non-finite
  // number cannot be journaled, and the whole decision record was lost.
  receipt.depthBB = Number.isFinite(depth) ? depth : null;
  if (!Number.isFinite(depth) || depth <= 0 || depth > maxStackBB || (s.ante ?? 0) / s.bigBlind > 1)
    return finish('depth_or_ante_outside_pack');
  // Captured by the sampler below when the policy samples for itself; null
  // when evidence arrived already aggregated from outside.
  let terminal: RemainingVariantTerminalShowdowns | null = null;
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
    s.communityCards.length !==
    ({ preflop: 0, flop: 3, turn: 4, river: 5 } as Record<string, number>)[s.stage]
  )
    return finish('invalid_cards');
  /**
   * P12.1. The pot-share price below cannot express a side pot hero is not
   * eligible for, an uncalled-bet refund, the BBJ fee or an FLO8 quarter, so
   * the fixed-limit river node also carries an explicit net chip result.
   *
   * It runs on the showdowns the sampler ALREADY scored - no extra sample,
   * card or deck draw - and it runs STRICTLY AFTER `finish`, on its own
   * budget. That ordering is the point: `finish` has already fixed the reason,
   * the proposal, `changed`, `applied` and `latencyMs`, so no cost incurred
   * here can turn a firing proposal into a `work_budget` fallback. An earlier
   * version put this inside the policy budget and a shared CI runner proved it
   * could: the guard bounds work units rather than wall time, so one
   * settlement's overshoot past an in-budget deadline still crossed
   * `liveBudgetMs` and dropped the proposal.
   *
   * A refused node is not priced at all, and an unavailable pass is NAMED.
   */
  const finishPriced = (reason: string, proposal = baseline) => {
    const out = finish(reason, proposal);
    if (!out.receipt.fired || s.stage !== 'river' || (variant !== 'flh' && variant !== 'flo8'))
      return out;
    const economicsStart = now();
    const showdowns = terminal as RemainingVariantTerminalShowdowns | null;
    const economics = remainingVariantActionEconomics({
      variant,
      stage: s.stage,
      hero,
      players: seats,
      opponentIds: showdowns ? showdowns.opponentIds : [],
      samples: showdowns ? showdowns.samples : [],
      currentBet: s.currentBet,
      betSize: fixedSize,
      actionHistory: s.actionHistory ?? [],
      // Validated non-null by the canonical-state gate above; a closure
      // does not keep that narrowing.
      legalActions: s.legalActions!,
      wagersCapped: Boolean(s.wagersCapped),
      minRaiseTo: s.minRaiseTo ?? null,
      maxRaiseTo: s.maxRaiseTo ?? null,
      chipUnit: s.chipUnit === 1 ? 1 : 0.01,
      asset: s.asset === 'diamonds' ? 'diamonds' : 'chips',
      gameMode: s.gameMode === 'tournament' ? 'tournament' : 'cash',
      bigBlind: s.bigBlind,
      dealerSeat: s.dealerSeat!,
      rakeConfig: rake,
      bbjConfig: s.bbjConfig ?? null,
      withinBudget: () => now() - economicsStart < REMAINING_VARIANT_DOMAIN.netActionBudgetMs,
      now,
    });
    out.receipt.actionEconomics = economics;
    if (economics.unavailable === null) out.receipt.features.push('net_action_economics');
    return out;
  };
  const postDiscard = variant === 'pineapple' && s.stage !== 'preflop';
  let shape: ReturnType<typeof remainingVariantHandShape>;
  const dead = hero.knownDeadCards ?? [];
  try {
    shape = remainingVariantHandShape(variant, hero.cards, postDiscard);
    if (!Array.isArray(dead) || dead.length !== (postDiscard ? 1 : 0))
      return finish('known_discard_unavailable');
    const physical = [...hero.cards, ...dead, ...s.communityCards];
    if (
      physical.some(
        (c) =>
          !c ||
          typeof c.rank !== 'string' ||
          c.rank.length !== 1 ||
          !'23456789TJQKA'.includes(c.rank) ||
          !['clubs', 'diamonds', 'hearts', 'spades'].includes(c.suit) ||
          (variant === 'short_deck' && '2345'.includes(c.rank))
      ) ||
      new Set(physical.map((c) => c.rank + ':' + c.suit)).size !== physical.length
    )
      return finish('invalid_cards');
  } catch {
    return finish('invalid_cards');
  }
  receipt.position = positionOf(hero.seat);
  receipt.role = plo4Role(hero, s, positionOf);
  // A small fixed-limit stack does not create a no-limit reshove branch.
  if (limit && receipt.role === 'reshove') receipt.role = 'three_bet';
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
  // Geometry the proposal enforces, computed once and recorded.
  const chipUnit = remainingVariantChipUnit(s.bigBlind);
  const stackRaiseTo = hero.bet + hero.stack;
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
  const noLimit = limit
    ? null
    : Object.freeze({
        wagerCap: s.maxRaiseTo == null ? null : Math.min(s.maxRaiseTo, stackRaiseTo),
      });
  const fixedLimit = fixedBounds
    ? Object.freeze({
        smallBet,
        streetBet: fixedSize,
        completionIncrement: fixedBounds.raiseSize,
        completion: Math.abs(fixedBounds.raiseSize - fixedSize) > 0.005,
        wagersThisStreet: fixedBounds.wagers,
        maxWagers: FIXED_LIMIT_MAX_WAGERS,
        wagersCapped: s.wagersCapped === true,
        wagerOpen: canWager,
        canonicalWagerTo: canWager ? s.minRaiseTo! : null,
      })
    : null;
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
  let postflop: NonNullable<RemainingVariantInputBinding['geometry']['postflop']> | null = null;
  let boardFacts: {
    paired: boolean | null;
    flushBoard: boolean | null;
    lowPossible: boolean | null;
  } = { paired: null, flushBoard: null, lowPossible: null };
  const notConsumed = (
    status: RemainingVariantRangeStatus
  ): RemainingVariantInputBinding['range'] =>
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
      version: 'remaining-variant-input-binding-v1',
      variant,
      mode: tournamentTable ? 'tournament' : 'cash',
      pack: Object.freeze({
        version: pack.version,
        holes: pack.holes as 2 | 3 | 4,
        deck: pack.deck as 36 | 52,
        splitPot: pack.splitLow,
        bettingStructure: pack.structure,
        source: REMAINING_VARIANT_DOMAIN.source,
        calibratedConfidence: null,
        seats: Object.freeze([2, seatCap]) as readonly [number, number],
        seatCapOwner: tournamentTable ? 'tournament_deck_capacity' : 'cash_table_seating',
        maxStackBB,
        maxAnteBB: REMAINING_VARIANT_DOMAIN.maxAnteBB,
        maxRakePercent: REMAINING_VARIANT_DOMAIN.maxRakePercent,
      }),
      approximation: Object.freeze({
        status:
          range.status === 'consumed' || range.status === 'consumed_unattributed'
            ? 'explicit_variant_heuristic_with_uncalibrated_range_sample'
            : 'explicit_variant_heuristic',
        solverInput: false,
        handShape: Object.freeze({
          score: shape.quality,
          cardsScored: hero.cards.length as 2 | 3 | 4,
          kind: 'heuristic_entry_score',
          probability: false,
        }),
      }),
      privateCards: Object.freeze({
        heroHoleCards: hero.cards.length as 2 | 3 | 4,
        heroKnownDeadCards: dead.length as 0 | 1,
        postDiscard,
        cardValues: 'not_recorded',
      }),
      census,
      positions,
      geometry: Object.freeze({
        bettingStructure: pack.structure,
        chipUnit,
        ...scalars,
        callCost,
        stackRaiseTo,
        anteBB: scalars.ante / s.bigBlind,
        rake: rakeBinding,
        noLimit,
        fixedLimit,
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
    } satisfies RemainingVariantInputBinding);
  // P12.1: every proposal is in the legalizer's own form (see
  // remainingVariantLegalForm), so HorseLogic.legalize leaves it unchanged.
  const legalForm = (d: HorseDecision) => remainingVariantLegalForm(d, hero, s);
  const passive = (): HorseDecision =>
    legalForm({ action: callCost ? 'fold' : 'check', thinkTime: baseline.thinkTime });
  const call = (): HorseDecision =>
    legalForm({
      action: callCost ? 'call' : 'check',
      ...(callCost ? { amount: callCost } : {}),
      thinkTime: baseline.thinkTime,
    });
  const wager = (fraction: number): HorseDecision => {
    const action = s.currentBet > 0 ? 'raise' : 'bet';
    if (!s.legalActions!.includes(action) || s.minRaiseTo == null || s.maxRaiseTo == null) {
      if (
        !s.wagersCapped &&
        s.legalActions!.includes('all_in') &&
        (!limit || hero.bet + hero.stack <= s.currentBet + fixedSize)
      )
        return legalForm({ action: 'all_in', thinkTime: baseline.thinkTime });
      return call();
    }
    // Fixed limit: the canonical bet, raise or completion amount. No limit:
    // the pot fraction, inside the controller's interval; the legal form
    // then lands it on the chip step and applies the near-stack all-in rule.
    const target = limit
      ? s.minRaiseTo
      : Math.max(
          s.minRaiseTo,
          Math.min(s.maxRaiseTo, stackRaiseTo, s.currentBet + (s.pot + callCost) * fraction)
        );
    return legalForm({ action, amount: target, thinkTime: baseline.thinkTime });
  };
  // Round 3 retains the reference in its own legal form; HorseLogic hands
  // the policy an already legal reference, so this is that action unchanged.
  const retained = (): HorseDecision => legalForm(baseline);
  receipt.features = [
    limit && 'fixed_limit_wager',
    s.wagersCapped && 'wager_cap',
    variant === 'short_deck' && '36_card_flush_over_full_house',
    postDiscard && 'private_discard_excluded',
    active.length > 1 && 'multiway',
  ].filter(Boolean) as string[];
  if (s.stage === 'preflop') {
    const bars = remainingVariantEntryBars(variant, {
      position: receipt.position,
      aggressorPosition: receipt.aggressorPosition,
      role: receipt.role,
      seats: seats.length,
      depthBB: depth,
      rakePercent: rake.percent,
      anteBB: (s.ante ?? 0) / s.bigBlind,
      straddle: Boolean(s.straddleActive),
    });
    // Round 3 (see REMAINING_VARIANT_PACKS[variant].round3): the reference
    // keeps every preflop decision except the declared entry spots.
    const rules = pack.round3;
    const baselineWagers = ['bet', 'raise', 'all_in'].includes(baseline.action);
    if (
      receipt.role === 'rfi' &&
      baselineWagers &&
      seats.length >= rules.openTightenMinDealt &&
      (rules.openTighten as readonly string[]).includes(receipt.position) &&
      shape.quality < bars.open
    )
      return finish('round3_open_tightened', passive());
    if (
      rules.headsUpOpenBelowBar !== null &&
      seats.length === 2 &&
      receipt.role === 'rfi' &&
      receipt.position === 'button' &&
      !baselineWagers &&
      shape.quality >= bars.open - rules.headsUpOpenBelowBar
    )
      return finish('round3_heads_up_open', wager(0.75));
    if (
      rules.smallBlindStealBelowBar !== null &&
      seats.length >= 3 &&
      receipt.role === 'limp_option' &&
      receipt.position === 'small_blind' &&
      !baselineWagers &&
      shape.quality >= bars.open - rules.smallBlindStealBelowBar
    )
      return finish('round3_small_blind_steal', wager(0.75));
    if (
      rules.bigBlindDefendBelowCallBar !== null &&
      receipt.role === 'defense' &&
      receipt.position === 'big_blind' &&
      baseline.action === 'fold' &&
      shape.quality >= bars.call - rules.bigBlindDefendBelowCallBar
    )
      return finish('round3_big_blind_defended', call());
    return finish('round3_reference_retained', retained());
  }
  // Reserve the sampler's remaining time after computing exact card facts.
  // Doing the FLO8 facts after sampling spent a fresh millisecond after the
  // sampler's deadline on wide flops and discarded otherwise valid reads.
  const splitFacts =
    variant === 'flo8' ? omahaCardFacts(hero.cards, s.communityCards, true, true) : null;
  if (!evidence && sampleWhenMissing) {
    evidence = sampleRemainingVariantEquity(
      variant,
      hero,
      s,
      () => now() - start < REMAINING_VARIANT_DOMAIN.samplingDeadlineMs,
      (showdowns) => {
        terminal = showdowns;
      }
    );
    if (evidence) evidence.decisionEquityCeiling = decisionEquityCeiling;
  }
  const pairedBoard = new Set(s.communityCards.map((c) => c.rank)).size < s.communityCards.length;
  const flushBoard = ['clubs', 'diamonds', 'hearts', 'spades'].some(
    (suit) => s.communityCards.filter((c) => c.suit === suit).length >= 3
  );
  const lowBoardRanks = new Set(
    s.communityCards
      .map((c) => (c.rank === 'A' ? 1 : '23456789TJQKA'.indexOf(c.rank) + 2))
      .filter((v) => v <= 8)
  );
  boardFacts = {
    paired: pairedBoard,
    flushBoard,
    lowPossible: pack.splitLow ? lowBoardRanks.size + 5 - s.communityCards.length >= 3 : null,
  };
  const contestable = calculateContestablePot(s.players, hero.user_id, callCost),
    eligibleAfterCall = contestable + callCost;
  const chargedRake = calculateRake(s.pot + callCost, true, rake, seats.length);
  const netPot = Math.max(
    0,
    eligibleAfterCall - (chargedRake * eligibleAfterCall) / Math.max(0.01, s.pot + callCost)
  );
  const price = callCost / Math.max(0.01, netPot);
  receipt.callPrice = price;
  postflop = Object.freeze({
    contestablePot: contestable,
    eligibleAfterCall,
    chargedRake,
    netPotAfterCall: netPot,
    callPrice: price,
    spr: hero.stack / Math.max(s.bigBlind, contestable),
  });
  const numbersValid = validOmahaVariantEquity(
    evidence as OmahaVariantEquityEvidence | null,
    eligibleAfterCall
  );
  // A sample drawn against any population other than this decision's
  // contesting opponents, dealt deck and known discard is refused, like a
  // malformed one (P11.1, applied to Phase 12).
  const populationValid =
    !numbersValid ||
    evidence!.range === undefined ||
    remainingVariantRangeProvenanceIsValid(evidence!.range, {
      variant,
      contesting: active.map((p) => ({ userId: p.user_id, seat: p.seat })),
      dealtOpponents: seats.length - 1,
      heroKnownDeadCards: dead.length,
      samples: evidence!.samples,
      requestedSamples: evidence!.requestedSamples,
    });
  if (!numbersValid || !populationValid) {
    receipt.fired = false;
    receipt.equity = null;
    if (evidence) {
      range = notConsumed(!numbersValid ? 'rejected_malformed' : 'rejected_population');
      return finish('invalid_equity_evidence');
    }
    range = notConsumed('unavailable');
    return finish('equity_budget_unavailable');
  }
  const e = copyEvidence(evidence!);
  receipt.equity = e;
  receipt.confidence = 'range_sample';
  range = Object.freeze({
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
  const ceiling = e.decisionEquityCeiling ?? 1;
  if (!Number.isFinite(ceiling) || ceiling < 0 || ceiling > 1) {
    receipt.fired = false;
    return finish('invalid_equity_ceiling');
  }
  const equity = Math.min(e.equity, ceiling);
  // Receipt features only: round 3 decides nothing from them (see the pack).
  if (variant === 'flo8') {
    const facts = splitFacts!;
    const lowOnly = facts.nutLow && e.highEquity < 0.15;
    const quarterRisk = e.quarterOrLessProbability >= 0.2 || e.sixthOrLessProbability >= 0.1;
    receipt.features.push(
      ...([
        facts.nutLow && 'nut_low',
        shape.backupLow && 'backup_low',
        lowOnly && 'low_only',
        quarterRisk && 'quarter_or_sixth_risk',
        facts.counterfeitTransitions.some((t) => !t.nutLowAfter) && 'counterfeit_exposure',
        e.scoopProbability >= 0.3 && 'sampled_scoop_potential',
        e.minimumObservedShare >= 0.5 &&
          e.maximumObservedShare > 0.5 &&
          'sampled_freeroll_potential',
      ].filter(Boolean) as string[])
    );
  } else {
    const all = [...hero.cards, ...s.communityCards];
    const draw = ['clubs', 'diamonds', 'hearts', 'spades'].some(
      (suit) =>
        all.filter((c) => c.suit === suit).length === 4 && hero.cards.some((c) => c.suit === suit)
    );
    const nuts = nlhNutStatus(hero.cards, s.communityCards, variant === 'short_deck');
    const dominated = nuts.flushPossible && nuts.higherFlushRanks > 0;
    if (draw) receipt.features.push('flush_draw');
    if (dominated) receipt.features.push('higher_flush_available');
  }
  if (e.perPot.length > 1) receipt.features.push('separate_pot_eligibility');
  // Round 3: postflop the reference keeps every decision except, in no
  // limit, a flop bet into a checked pot below the declared equity.
  const checkBelow = pack.round3.flopCheckBelow;
  if (
    !callCost &&
    checkBelow !== null &&
    s.stage === 'flop' &&
    ['bet', 'raise', 'all_in'].includes(baseline.action) &&
    equity < checkBelow
  )
    return finishPriced('round3_flop_bet_checked', passive());
  return finishPriced('round3_reference_retained', retained());
}
