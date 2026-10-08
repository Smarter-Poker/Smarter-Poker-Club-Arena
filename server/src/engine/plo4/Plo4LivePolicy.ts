import type { HorseDecision, SeatPlayer } from '../../types.js';
import type { HorseGameStateV2 } from '../HorseLogic.js';
import type { ReadScope } from '../HorseMind.js';
import { omahaNutStatus } from '../HorseEval.js';
import { omahaCardFacts } from '../omaha/OmahaCardFacts.js';
import { calculateContestablePot, calculateRake } from '../PokerEngine.js';
import { horsePolicyDealtPlayers } from '../multiway/DealtSeatCensus.js';
import {
  mergeHorseObservationWindows,
  normalizeHorseObservationWindow,
  type HorseObservationWindow,
} from '../HorseObservationWindow.js';
import {
  captureHorseTournamentUtilityObservations,
  horseCanonicalMaterialSha256,
  horseObservationSelection,
} from '../HorseTournamentUtilityEvidence.js';
import {
  PLO4_POLICY_PACK,
  PLO4_POSITIONS,
  PLO4_POSTFLOP_ROLES,
  PLO4_PREFLOP_ROLES,
  plo4HandShape,
  type OmahaReferenceDeviationRules,
  type Plo4Position,
  type Plo4NodeRole,
} from './Plo4PolicyPack.js';

export type Plo4LiveMode = 'off' | 'shadow' | 'candidate';

/**
 * P10.3 selection outcome, the same vocabulary as Phase 8's: `none`,
 * `shadow_change` (a counterfactual, never applied), `selected` (worker
 * selection under usable Phase 10 authority), and the acceptance-time
 * `controller_accepted` or `withdrawn_before_acceptance` set by the table.
 */
export type Plo4Selection =
  | 'none'
  | 'shadow_change'
  | 'selected'
  | 'controller_accepted'
  | 'withdrawn_before_acceptance';

/** Where the opponent ranges behind a postflop equity sample came from. The
 * bands are HorseMind's public-action-line heuristic, optionally adjusted by
 * its observed statistics. Nothing here is calibrated or solver input. */
export interface Plo4RangeOpponent {
  readonly userId: string;
  /** HorseMind.bandFor percentile band, or null for an unconditioned range. */
  readonly band: readonly [number, number] | null;
  /** HorseMind.readStats' actual selection for this opponent. */
  readonly statistics: 'family_size' | 'pooled' | 'unavailable' | 'disabled';
  readonly scope: ReadScope | null;
  /** Contribution envelope of the selected statistics row, never freshness. */
  readonly sourceWindow: HorseObservationWindow;
}
export interface Plo4RangeProvenance {
  readonly version: 'plo4-range-provenance-v1';
  readonly source: 'horse_mind_public_line' | 'uniform_no_public_read' | 'uniform_mind_disabled';
  readonly calibration: 'uncalibrated';
  readonly solverInput: false;
  readonly publicLine: Readonly<{
    window: 'full_hand' | 'preflop_only';
    actions: number;
    sizeReads: boolean;
    boardContact: boolean;
  }>;
  readonly equity: Readonly<{
    basis: 'horse_monte_carlo_after_structural_caps';
    structuralCapApplied: boolean;
    samples: 'adaptive_first_checkpoint' | 'requested_budget';
  }>;
  readonly scope: ReadScope | null;
  /** Merged envelope of the statistics rows that contributed a band input. */
  readonly window: HorseObservationWindow;
  readonly opponents: readonly Plo4RangeOpponent[];
}
export interface Plo4EquityEvidence {
  equity: number;
  samples: number;
  standardError: number;
  /** Already captured provenance (offline callers and tests); may be omitted. */
  range?: Plo4RangeProvenance;
  /** The live HorseLogic path: the provenance capture itself, run only when
   * the proposal consumes it, inside this policy's timed region, so it counts
   * against `liveBudgetMs` (P10 audit F7). A throw leaves the sample
   * unattributed, as an eager capture failure did. Ignored when `range` is set. */
  captureRange?: () => Plo4RangeProvenance;
}

export type Plo4RangeStatus =
  | 'not_consumed_preflop'
  | 'unavailable'
  | 'rejected_malformed'
  | 'rejected_population'
  | 'consumed_unattributed'
  | 'consumed';

/** The seats that posted the blinds this hand, as HandController posted them
 * (HorseGameStateV2.blindSeats). `smallBlind` is null when the small blind is
 * DEAD under the tournament dead-button rule (deadButton.ts): nobody posts it. */
export interface Plo4BlindSeats {
  readonly smallBlind: number | null;
  readonly bigBlind: number;
}

/** The facts the proposal actually consumed, copied and frozen when it was
 * computed. A private receipt field: never public state or telemetry.
 *
 * v2 records the posted blind seats in the census and its positions are
 * derived from them. v1 (retained receipts only) inferred the blinds from the
 * button and is still read by the binding validator, with v1's own checks. */
export interface Plo4InputBinding {
  readonly version: 'plo4-input-binding-v2';
  readonly pack: Readonly<{
    version: string;
    source: 'explicit_heuristic_baseline';
    calibratedConfidence: null;
    seats: readonly [number, number];
    maxStackBB: number;
    maxAnteBB: number;
    maxRakePercent: number;
  }>;
  readonly approximation: Readonly<{
    status: 'explicit_heuristic' | 'explicit_heuristic_with_uncalibrated_range_sample';
    solverInput: false;
    /** The hand-shape value is an entry score compared with atlas bars. */
    handShape: Readonly<{ score: number; kind: 'heuristic_entry_score'; probability: false }>;
  }>;
  readonly census: Readonly<{
    source: 'dealt_seat_ids' | 'legacy_player_list';
    dealerSeat: number;
    heroSeat: number;
    dealtSeats: readonly number[];
    /** The engine's posted blind seats this hand; positions are derived from them. */
    blindSeats: Plo4BlindSeats;
    /** Unfolded opponents still contesting the pot: present, or all-in while away. */
    contestingOpponentSeats: readonly number[];
    /** Contesting opponents who can still act (not all-in). */
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
    /** The product's only straddle is the single UTG 2BB post. */
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
    /** currentBet + pot + call: the pot-limit raise-to the proposal enforces. */
    potLimitRaiseTo: number;
    stackRaiseTo: number;
    /** min(engine maximum, stack, pot limit); null when no wager is legal. */
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
    features: readonly string[];
  }>;
  readonly range: Readonly<{
    status: Plo4RangeStatus;
    equity: number | null;
    samples: number | null;
    standardError: number | null;
    provenance: Plo4RangeProvenance | null;
  }>;
}

export interface Plo4LiveReceipt {
  version: string;
  mode: Plo4LiveMode;
  eligible: boolean;
  fired: boolean;
  changed: boolean;
  applied: boolean;
  reason: string;
  street: string;
  position: Plo4Position | null;
  aggressorPosition: Plo4Position | null;
  role: Plo4NodeRole | null;
  depthBB: number | null;
  confidence: 'explicit_heuristic' | 'range_sample' | 'unavailable';
  baselineAction: HorseDecision['action'];
  baselineAmount: number | null;
  proposalAction: HorseDecision['action'];
  proposalAmount: number | null;
  finalAction: HorseDecision['action'];
  finalAmount: number | null;
  features: string[];
  /** The validated equity sample actually consumed, copied; null otherwise. */
  equity: Readonly<{ equity: number; samples: number; standardError: number }> | null;
  callPrice: number | null;
  /** P10.1: frozen inputs of an eligible proposal; null when it was refused. */
  inputs: Plo4InputBinding | null;
  /** Bound by the worker to the private read frame captured for this decision. */
  readFrameSha256?: string | null;
  shadowUtility?: import('../../types.js').HorseTournamentUtilityLedger;
  utilityOwner: 'cash' | 'phase7_pending' | 'phase7_evaluated' | 'phase7_unavailable';
  utilityLatencyMs?: number;
  utilityUnavailableReason?: string;
  latencyMs: number;
  executionStatus: 'pending' | 'intended' | 'coerced' | 'fallback' | 'not_executed';
  executedAction: HorseDecision['action'] | null;
  executedAmount: number | null;
  /** P10.3 selection outcome. Absent on receipts retained before P10.3. */
  selection?: Plo4Selection;
  /** P10.3: why an authority-backed candidate was not selected (the
   * reference was retained); null otherwise. */
  selectionRefusal?: 'illegal_candidate' | null;
  /** P10.3: the worker's Phase 10 authority receipt for this decision;
   * null outside the live worker; absent on retained receipts. */
  authority?: import('../HorseQualifiedAuthority.js').HorseAuthorityReceipt | null;
  /** P10.3: main-scheduler verdict immediately before acceptance; null in the worker. */
  authorityVerdict?: import('../HorseQualifiedAuthority.js').HorseAuthorityVerdict | null;
}
/**
 * P10.1 DEFECT 3: THE TOURNAMENT DEAD BUTTON (natural evidence, engine 46bb9cf6).
 *
 * A tournament table of three or more plays TDA Rule 30 (deadButton.ts): the
 * button is the seat that held the small blind last hand, whether or not
 * anyone still sits there. When that player has busted the dealer seat is an
 * empty physical seat and never one of the dealt seats. Positions then count
 * clockwise from that empty seat, as the engine deals and acts: the first
 * dealt seat after it is offset 1, and the last dealt seat before it acts
 * last on every street, the button's action slot, offset 0. With an occupied
 * button this is exactly the dealer-relative offset it always was.
 */
export function plo4ButtonOffset(
  seat: number,
  dealerSeat: number,
  dealtSeats: readonly number[]
): number {
  const sorted = [...dealtSeats].sort((a, b) => a - b);
  const clockwise = [
    ...sorted.filter((s) => s > dealerSeat),
    ...sorted.filter((s) => s <= dealerSeat),
  ];
  return (clockwise.indexOf(seat) + 1) % sorted.length;
}

const physicalSeat = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 10;

/**
 * Whether the dealer seat is one the engine could have dealt this hand: a
 * dealt seat (every cash hand, every heads-up hand, every tournament hand
 * whose button did not bust), or an empty physical seat on a tournament table
 * of three or more, the only place the engine leaves a dead button
 * (tournamentDeadButtonSeats is null on a cash table and heads-up).
 */
export function plo4DealerSeatIsValid(
  dealerSeat: unknown,
  dealtSeats: readonly number[],
  tournament: boolean
): boolean {
  if (dealtSeats.includes(dealerSeat as number)) return true;
  return tournament && dealtSeats.length >= 3 && physicalSeat(dealerSeat);
}

/**
 * P10.1 F3/F5: the blind seats the engine actually posted this hand, checked
 * against the button and the dealt census.
 *
 * The census alone cannot say who posted: under the tournament dead-button
 * rule (deadButton.ts, TDA Rule 30) the small blind can be DEAD, so the first
 * dealt seat after the button is the big blind, and the button itself can be
 * an empty seat. HandController records the seats it posted from and the
 * decision state carries them (HorseGameStateV2.blindSeats), so nothing is
 * inferred from seat numbers or from the table's physical size.
 *
 * `missing`: the state carries no blind seats (a legacy snapshot, or a hand
 * that posted none). `invalid`: blind seats the engine could not have posted
 * with this button and census: heads-up the button posts the small blind and
 * the other seat the big blind; at three or more the first dealt seat
 * clockwise of the button (excluding an occupied button) is the live small
 * blind, then the big blind, or the big blind alone when the small blind is
 * dead. A dead small blind exists only at a tournament table of three or more.
 */
export function plo4BlindSeatsStatus(
  dealerSeat: unknown,
  dealtSeats: readonly number[],
  blinds: unknown,
  tournament: boolean
): 'valid' | 'missing' | 'invalid' {
  if (blinds === undefined || blinds === null) return 'missing';
  if (!exact(blinds, ['smallBlind', 'bigBlind']) || !physicalSeat(dealerSeat)) return 'invalid';
  const { smallBlind, bigBlind } = blinds;
  if (
    !physicalSeat(bigBlind) ||
    !dealtSeats.includes(bigBlind) ||
    !(
      smallBlind === null ||
      (physicalSeat(smallBlind) && dealtSeats.includes(smallBlind) && smallBlind !== bigBlind)
    ) ||
    !plo4DealerSeatIsValid(dealerSeat, dealtSeats, tournament)
  )
    return 'invalid';
  if (dealtSeats.length === 2) return smallBlind === dealerSeat ? 'valid' : 'invalid';
  if (smallBlind === null && !tournament) return 'invalid';
  // Action order from the button: offsets 1..n-1, then the button's slot (0).
  const slot = (seat: number) =>
    plo4ButtonOffset(seat, dealerSeat, dealtSeats) || dealtSeats.length;
  const order = dealtSeats.filter((seat) => seat !== dealerSeat).sort((a, b) => slot(a) - slot(b));
  const posted = smallBlind === null ? [bigBlind] : [smallBlind, bigBlind];
  return posted.every((seat, i) => order[i] === seat) ? 'valid' : 'invalid';
}

/**
 * P10.1 F3: the canonical position of a dealt seat, from the button and the
 * blinds the engine actually posted (valid per plo4BlindSeatsStatus). The
 * button's action slot (offset 0) is the button; the posting seats are the
 * blinds; the seats after the big blind are early, middle and, last before
 * the button, the cutoff. With an occupied button and a live small blind this
 * is exactly the dealer-offset formula (plo4Position); with a dead small
 * blind the big blind is offset 1 and the next seat is the first to act,
 * where the offset formula called them the small and the big blind.
 */
export function plo4CanonicalPosition(
  seat: number,
  dealerSeat: number,
  dealtSeats: readonly number[],
  blinds: Plo4BlindSeats
): Plo4Position {
  const offset = plo4ButtonOffset(seat, dealerSeat, dealtSeats);
  if (offset === 0) return 'button';
  if (seat === blinds.bigBlind) return 'big_blind';
  if (seat === blinds.smallBlind) return 'small_blind';
  const bigBlindOffset = plo4ButtonOffset(blinds.bigBlind, dealerSeat, dealtSeats);
  const afterBigBlind = offset - bigBlindOffset;
  if (afterBigBlind === dealtSeats.length - 1 - bigBlindOffset) return 'cutoff';
  return afterBigBlind === 1 ? 'early' : 'middle';
}

/**
 * The dealer-offset position: blinds inferred as the first two dealt seats
 * after the button. The PLO4 pack labels from the posted blinds instead
 * (plo4CanonicalPosition); this inference remains for the Phase 11/12
 * policies that import it.
 */
export function plo4Position(seat: number, state: HorseGameStateV2): Plo4Position {
  const seats = horsePolicyDealtPlayers(state.players, seat, state.dealtSeatIds)
    .map((p) => p.seat)
    .sort((a, b) => a - b);
  const offset = plo4ButtonOffset(seat, state.dealerSeat!, seats);
  if (offset === 0) return 'button';
  if (seats.length === 2 || offset === 2) return 'big_blind';
  if (offset === 1) return 'small_blind';
  if (offset === seats.length - 1) return 'cutoff';
  return offset === 3 ? 'early' : 'middle';
}
export function plo4Role(
  hero: SeatPlayer,
  state: HorseGameStateV2,
  positionOf: (seat: number) => Plo4Position = (seat) => plo4Position(seat, state)
): Plo4NodeRole {
  const line = (state.actionHistory ?? []).filter((a) => a.stage === state.stage);
  const raises = line.filter(
    (a) =>
      a.action === 'raise' ||
      a.action === 'bet' ||
      (a.action === 'all_in' && a.isFullRaise !== undefined)
  );
  if ((state.toCall ?? 0) >= hero.stack && hero.stack > 0) return 'call_off';
  if (state.stage !== 'preflop')
    return !state.toCall ? 'checked_to' : raises.length > 1 ? 'facing_raise' : 'facing_bet';
  if (raises.length > 0 && hero.stack / state.bigBlind <= 12) return 'reshove';
  // The blind is the first bet: open, three-bet and four-bet are three
  // recorded raises. The next decision belongs to the five-bet-plus node.
  if (raises.length >= 3) return 'five_bet_plus';
  if (raises.length >= 2) return 'four_bet';
  if (raises.length === 1) {
    const callers = line.filter(
      (a) =>
        (a.action === 'call' || (a.action === 'all_in' && a.isFullRaise === undefined)) &&
        a.timestamp >= raises[0].timestamp
    );
    if (callers.length >= 2) return 'overcall';
    if (callers.length === 1) return 'squeeze';
    return ['small_blind', 'big_blind'].includes(positionOf(hero.seat)) ? 'defense' : 'three_bet';
  }
  if (
    line.some((a) => a.action === 'call' || (a.action === 'all_in' && a.isFullRaise === undefined))
  )
    return 'isolation';
  if (positionOf(hero.seat) === 'small_blind' || !state.toCall) return 'limp_option';
  return 'rfi';
}
/** Continuous heuristic atlas. Values are entry-quality bars, never equities. */
export function plo4EntryBars(node: {
  position: Plo4Position;
  aggressorPosition: Plo4Position | null;
  role: Plo4NodeRole;
  seats: number;
  depthBB: number;
  rakePercent: number;
  anteBB: number;
  straddle: boolean;
}) {
  const depth = Math.max(0, Math.min(1, (node.depthBB - 8) / 92));
  const positionPressure =
    node.aggressorPosition === 'early' ? 0.06 : node.aggressorPosition === 'button' ? -0.03 : 0;
  const price =
    node.rakePercent / 250 + Math.max(0, node.seats - 4) * 0.006 - Math.min(1, node.anteBB) * 0.025;
  const highBet = node.role === 'five_bet_plus' ? 0.14 : node.role === 'four_bet' ? 0.08 : 0;
  return {
    open:
      PLO4_POLICY_PACK.openQuality[node.position] +
      price +
      depth * 0.02 +
      Number(node.straddle) * 0.01,
    call: 0.5 + price + depth * 0.1 + highBet + positionPressure,
    raise: 0.77 + depth * 0.05 + highBet + positionPressure,
    callOff: 0.52 + depth * 0.39 + price + positionPressure,
  };
}
/** Shared atlas decision kernel; the caller applies the authoritative legal wager cap. */
export function plo4PreflopChoice(
  quality: number,
  bars: ReturnType<typeof plo4EntryBars>,
  role: Plo4NodeRole,
  callBB: number,
  stackBB: number
):
  | { action: 'wager'; fraction: number; reason: string }
  | { action: 'call' | 'passive'; reason: string } {
  if (role === 'reshove' && quality >= bars.callOff)
    return { action: 'wager', fraction: 1, reason: 'preflop_reshove' };
  if (role === 'call_off')
    return { action: quality >= bars.callOff ? 'call' : 'passive', reason: 'preflop_call_off' };
  if (['rfi', 'isolation', 'limp_option'].includes(role)) {
    const bar = bars.open + Number(role === 'isolation') * 0.05;
    if (quality >= bar) return { action: 'wager', fraction: 0.75, reason: 'preflop_entry' };
    if (role === 'limp_option' && quality >= bar - 0.1 && callBB <= 0.5)
      return { action: 'call', reason: 'preflop_complete' };
    return { action: 'passive', reason: 'preflop_entry_declined' };
  }
  if (quality >= bars.raise) return { action: 'wager', fraction: 1, reason: 'preflop_reraise' };
  return {
    action: quality >= (callBB > stackBB * 0.35 ? bars.callOff : bars.call) ? 'call' : 'passive',
    reason: 'preflop_defense',
  };
}

/**
 * Round 3 (2026-10-08): the shared reference-anchored deviation kernel of the
 * Omaha packs (PLO4, PLO5, PLO6, PLO8). Given the reference action and the
 * public node, it names the one deviation the pack's rules make, or null when
 * the reference action is retained. Every deviation turns a reference fold or
 * check into a wager, and only heads-up: at a table dealt exactly two seats,
 * with one live opponent. The caller applies the authoritative legal wager
 * cap; a fraction of 0 is the controller's minimum raise.
 */
export function plo4ReferenceDeviation(
  node: {
    street: string;
    dealtSeats: number;
    liveOpponents: number;
    role: Plo4NodeRole | null;
    position: Plo4Position | null;
    baseline: HorseDecision;
    callCost: number;
  },
  rules: OmahaReferenceDeviationRules
): { reason: string; fraction: number } | null {
  if (node.dealtSeats !== 2 || node.liveOpponents !== 1) return null;
  if (node.baseline.action !== 'fold' && node.baseline.action !== 'check') return null;
  if (node.street === 'preflop') {
    if (rules.headsUpButtonOpen && node.role === 'rfi' && node.position === 'button')
      return { reason: 'heads_up_button_open', fraction: 0 };
    return null;
  }
  if (
    (rules.headsUpPositionStab as readonly string[]).includes(node.street) &&
    node.role === 'checked_to' &&
    node.position === 'button' &&
    node.callCost === 0
  )
    return { reason: 'heads_up_position_stab', fraction: 1 };
  return null;
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
const seatList = (value: unknown, max = 10): value is number[] =>
  Array.isArray(value) &&
  value.length <= max &&
  value.every(
    (seat, i) =>
      Number.isSafeInteger(seat) && seat >= 1 && seat <= 10 && (i === 0 || seat > value[i - 1])
  );
const scopeValid = (value: unknown): value is ReadScope | null =>
  value === null ||
  (typeof value === 'string' && /^(holdem|omaha|sixplus):(hu|short|full)$/.test(value));
const windowValid = (value: unknown): value is HorseObservationWindow =>
  exact(value, ['version', 'coverage', 'fromMs', 'toMs']) &&
  Object.keys(value).every(
    (key) =>
      value[key] === normalizeHorseObservationWindow(value)[key as keyof HorseObservationWindow]
  );
const STATISTICS = ['family_size', 'pooled', 'unavailable', 'disabled'] as const;
const RANGE_SOURCES = ['horse_mind_public_line', 'uniform_no_public_read', 'uniform_mind_disabled'];

/** Capture the provenance of the live equity pass from HorseLogic's own
 * values: the same live opponents bandsForOpponents iterated (table order),
 * the bands it returned and the HorseMind read view, never a second cache. */
export function capturePlo4RangeProvenance(input: {
  opponents: readonly SeatPlayer[];
  bands: ReadonlyArray<readonly [number, number] | null> | undefined;
  mindEnabled: boolean;
  publicLine: 'full_hand' | 'preflop_only';
  actions: number;
  sizeReads: boolean;
  boardContact: boolean;
  structuralCapApplied: boolean;
  adaptiveSamples: boolean;
}): Plo4RangeProvenance {
  const observations = captureHorseTournamentUtilityObservations(
    input.opponents as SeatPlayer[],
    input.mindEnabled
  );
  const opponents = input.opponents.map((opponent, index) => {
    const band = input.mindEnabled ? (input.bands?.[index] ?? null) : null;
    const selected = horseObservationSelection(observations, opponent.user_id);
    return Object.freeze({
      userId: opponent.user_id,
      band: band === null ? null : (Object.freeze([band[0], band[1]]) as readonly [number, number]),
      statistics: selected.source,
      scope: selected.scope,
      sourceWindow: normalizeHorseObservationWindow(selected.selected?.sourceWindow),
    });
  });
  return Object.freeze({
    version: 'plo4-range-provenance-v1',
    source: !input.mindEnabled
      ? 'uniform_mind_disabled'
      : opponents.some((row) => row.band !== null)
        ? 'horse_mind_public_line'
        : 'uniform_no_public_read',
    calibration: 'uncalibrated',
    solverInput: false,
    publicLine: Object.freeze({
      window: input.publicLine,
      actions: input.actions,
      sizeReads: input.sizeReads,
      boardContact: input.boardContact,
    }),
    equity: Object.freeze({
      basis: 'horse_monte_carlo_after_structural_caps',
      structuralCapApplied: input.structuralCapApplied,
      samples: input.adaptiveSamples ? 'adaptive_first_checkpoint' : 'requested_budget',
    }),
    scope: observations.scope,
    window: mergeHorseObservationWindows(
      ...opponents
        .filter((row) => row.statistics === 'family_size' || row.statistics === 'pooled')
        .map((row) => row.sourceWindow)
    ),
    opponents: Object.freeze(opponents),
  } satisfies Plo4RangeProvenance);
}

/** Labels, shape and internal consistency. With `contesting`, the sampled
 * population must be exactly the contesting opponents of this decision. */
export function plo4RangeProvenanceIsValid(
  value: unknown,
  contesting?: readonly string[]
): value is Plo4RangeProvenance {
  if (
    !exact(value, [
      'version',
      'source',
      'calibration',
      'solverInput',
      'publicLine',
      'equity',
      'scope',
      'window',
      'opponents',
    ]) ||
    value.version !== 'plo4-range-provenance-v1' ||
    !RANGE_SOURCES.includes(value.source as string) ||
    value.calibration !== 'uncalibrated' ||
    value.solverInput !== false ||
    !exact(value.publicLine, ['window', 'actions', 'sizeReads', 'boardContact']) ||
    !['full_hand', 'preflop_only'].includes(value.publicLine.window as string) ||
    !Number.isSafeInteger(value.publicLine.actions) ||
    (value.publicLine.actions as number) < 0 ||
    (value.publicLine.actions as number) > 10_000 ||
    typeof value.publicLine.sizeReads !== 'boolean' ||
    typeof value.publicLine.boardContact !== 'boolean' ||
    !exact(value.equity, ['basis', 'structuralCapApplied', 'samples']) ||
    value.equity.basis !== 'horse_monte_carlo_after_structural_caps' ||
    typeof value.equity.structuralCapApplied !== 'boolean' ||
    !['adaptive_first_checkpoint', 'requested_budget'].includes(value.equity.samples as string) ||
    !scopeValid(value.scope) ||
    !windowValid(value.window) ||
    !Array.isArray(value.opponents) ||
    value.opponents.length < 1 ||
    value.opponents.length > 9
  )
    return false;
  const rows = value.opponents as unknown[];
  const ids = new Set<string>();
  for (const row of rows) {
    if (
      !exact(row, ['userId', 'band', 'statistics', 'scope', 'sourceWindow']) ||
      typeof row.userId !== 'string' ||
      !row.userId.length ||
      row.userId.length > 256 ||
      ids.has(row.userId) ||
      !(
        row.band === null ||
        (Array.isArray(row.band) &&
          row.band.length === 2 &&
          row.band.every(finite) &&
          row.band[0] < row.band[1] &&
          row.band[1] <= 1)
      ) ||
      !STATISTICS.includes(row.statistics as (typeof STATISTICS)[number]) ||
      !scopeValid(row.scope) ||
      (row.scope !== null && (row.statistics !== 'family_size' || row.scope !== value.scope)) ||
      (row.statistics === 'family_size' && row.scope === null) ||
      !windowValid(row.sourceWindow)
    )
      return false;
    ids.add(row.userId);
  }
  const typed = rows as Plo4RangeOpponent[];
  const disabled = value.source === 'uniform_mind_disabled';
  if (
    typed.some((row) => (row.statistics === 'disabled') !== disabled) ||
    (disabled && typed.some((row) => row.band !== null)) ||
    (value.source === 'uniform_no_public_read' && typed.some((row) => row.band !== null)) ||
    (value.source === 'horse_mind_public_line' && typed.every((row) => row.band === null))
  )
    return false;
  const merged = mergeHorseObservationWindows(
    ...typed
      .filter((row) => row.statistics === 'family_size' || row.statistics === 'pooled')
      .map((row) => row.sourceWindow)
  );
  if (
    Object.keys(merged).some(
      (key) =>
        merged[key as keyof HorseObservationWindow] !==
        (value.window as HorseObservationWindow)[key as keyof HorseObservationWindow]
    )
  )
    return false;
  return (
    contesting === undefined ||
    (contesting.length === ids.size && contesting.every((id) => ids.has(id)))
  );
}

function freezeProvenance(value: Plo4RangeProvenance): Plo4RangeProvenance {
  return Object.freeze({
    ...value,
    publicLine: Object.freeze({ ...value.publicLine }),
    equity: Object.freeze({ ...value.equity }),
    window: normalizeHorseObservationWindow(value.window),
    opponents: Object.freeze(
      value.opponents.map((row) =>
        Object.freeze({
          ...row,
          band:
            row.band === null
              ? null
              : (Object.freeze([row.band[0], row.band[1]]) as readonly [number, number]),
          sourceWindow: normalizeHorseObservationWindow(row.sourceWindow),
        })
      )
    ),
  });
}

const RANGE_STATUSES: readonly Plo4RangeStatus[] = [
  'not_consumed_preflop',
  'unavailable',
  'rejected_malformed',
  'rejected_population',
  'consumed_unattributed',
  'consumed',
];
const nullableFinite = (value: unknown) => value === null || finite(value);

/** v1 bindings (retained receipts) inferred the small blind: an empty dealer
 * was accepted only when the first dealt seat sat physically next to it, the
 * check #5992 applied. Read-only: no binding is written at v1 any more. */
function v1DeadButtonProven(dealerSeat: unknown, dealtSeats: readonly number[]): boolean {
  if (dealtSeats.includes(dealerSeat as number)) return true;
  if (dealtSeats.length < 3 || !physicalSeat(dealerSeat)) return false;
  const first = dealtSeats.find((s) => s > dealerSeat) ?? Math.min(...dealtSeats);
  return first === dealerSeat + 1 || (dealerSeat === 10 && first === 1);
}

/** Worker-boundary shape check of a returned binding. It does not recompute
 * the proposal; the journal reviewer binds it to the original request. A v2
 * binding's positions must be the canonical positions of its recorded button,
 * census and posted blind seats. */
export function plo4InputBindingIsValid(value: unknown): value is Plo4InputBinding {
  if (
    !exact(value, [
      'version',
      'pack',
      'approximation',
      'census',
      'positions',
      'geometry',
      'depth',
      'board',
      'range',
    ]) ||
    (value.version !== 'plo4-input-binding-v1' && value.version !== 'plo4-input-binding-v2')
  )
    return false;
  const v2 = value.version === 'plo4-input-binding-v2';
  const { pack, approximation, census, positions, geometry, depth, board, range } = value;
  if (
    !exact(pack, [
      'version',
      'source',
      'calibratedConfidence',
      'seats',
      'maxStackBB',
      'maxAnteBB',
      'maxRakePercent',
    ]) ||
    pack.version !== PLO4_POLICY_PACK.version ||
    pack.source !== PLO4_POLICY_PACK.source ||
    pack.calibratedConfidence !== null ||
    !Array.isArray(pack.seats) ||
    pack.seats[0] !== PLO4_POLICY_PACK.domain.minSeats ||
    pack.seats[1] !== PLO4_POLICY_PACK.domain.maxSeats ||
    pack.seats.length !== 2 ||
    pack.maxStackBB !== PLO4_POLICY_PACK.domain.maxStackBB ||
    pack.maxAnteBB !== PLO4_POLICY_PACK.domain.maxAnteBB ||
    pack.maxRakePercent !== PLO4_POLICY_PACK.domain.maxRakePercent ||
    !exact(approximation, ['status', 'solverInput', 'handShape']) ||
    !['explicit_heuristic', 'explicit_heuristic_with_uncalibrated_range_sample'].includes(
      approximation.status as string
    ) ||
    approximation.solverInput !== false ||
    !exact(approximation.handShape, ['score', 'kind', 'probability']) ||
    !finite(approximation.handShape.score) ||
    (approximation.handShape.score as number) > 1 ||
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
      ...(v2 ? ['blindSeats'] : []),
      'contestingOpponentSeats',
      'actingOpponentSeats',
      'foldedSeats',
      'awaySeats',
      'allInSeats',
    ]) ||
    !['dealt_seat_ids', 'legacy_player_list'].includes(census.source as string) ||
    !seatList(census.dealtSeats, PLO4_POLICY_PACK.domain.maxSeats) ||
    census.dealtSeats.length < PLO4_POLICY_PACK.domain.minSeats ||
    !(census.dealtSeats as number[]).includes(census.heroSeat as number) ||
    // v2: the posted blind seats are ones the engine could have posted with
    // this button and census (P10.1 F3/F5). v1: an empty dealer only with the
    // live small blind proven by adjacency (#5992).
    (v2
      ? plo4BlindSeatsStatus(
          census.dealerSeat,
          census.dealtSeats as number[],
          census.blindSeats,
          true
        ) !== 'valid'
      : !v1DeadButtonProven(census.dealerSeat, census.dealtSeats as number[])) ||
    // An empty dealer or a dead small blind exists only at a tournament table,
    // whose chips are whole.
    ((!(census.dealtSeats as number[]).includes(census.dealerSeat as number) ||
      (v2 && (census.blindSeats as Plo4BlindSeats).smallBlind === null)) &&
      !(object(geometry) && geometry.chipUnit === 1)) ||
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
  if (
    !exact(positions, ['hero', 'heroOffset', 'role', 'aggressor', 'aggressorSeat', 'straddle']) ||
    !PLO4_POSITIONS.includes(positions.hero as Plo4Position) ||
    !Number.isSafeInteger(positions.heroOffset) ||
    (positions.heroOffset as number) < 0 ||
    (positions.heroOffset as number) >= (census.dealtSeats as number[]).length ||
    positions.heroOffset !==
      plo4ButtonOffset(
        census.heroSeat as number,
        census.dealerSeat as number,
        census.dealtSeats as number[]
      ) ||
    !roles.includes(positions.role as string) ||
    (positions.aggressor === null) !== (positions.aggressorSeat === null) ||
    (positions.aggressor !== null &&
      (!PLO4_POSITIONS.includes(positions.aggressor as Plo4Position) ||
        !(census.dealtSeats as number[]).includes(positions.aggressorSeat as number))) ||
    !['table_enabled_utg_2bb', 'none'].includes(positions.straddle as string)
  )
    return false;
  if (v2) {
    // P10.1 F3: the recorded positions are those of the recorded posted blinds.
    const positionOf = (seat: number) =>
      plo4CanonicalPosition(
        seat,
        census.dealerSeat as number,
        census.dealtSeats as number[],
        census.blindSeats as Plo4BlindSeats
      );
    if (
      positions.hero !== positionOf(census.heroSeat as number) ||
      (positions.aggressorSeat !== null &&
        positions.aggressor !== positionOf(positions.aggressorSeat as number))
    )
      return false;
  }
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
    (geometry.chipUnit !== 0.01 && geometry.chipUnit !== 1) ||
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
    (geometry.anteBB as number) > PLO4_POLICY_PACK.domain.maxAnteBB ||
    ![geometry.minRaiseTo, geometry.maxRaiseTo, geometry.wagerCap].every(nullableFinite) ||
    !exact(geometry.rake, ['percent', 'cap', 'noFlopNoDrop', 'playerCountCaps', 'dealtCount']) ||
    !finite(geometry.rake.percent) ||
    (geometry.rake.percent as number) > PLO4_POLICY_PACK.domain.maxRakePercent ||
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
  const street = board && object(board) ? board.street : undefined;
  if (
    !exact(depth, ['effectiveBB', 'heroCoverBB', 'deepestOpponentCoverBB', 'basis']) ||
    ![depth.effectiveBB, depth.heroCoverBB, depth.deepestOpponentCoverBB].every(finite) ||
    !(depth.effectiveBB as number) ||
    (depth.effectiveBB as number) > PLO4_POLICY_PACK.domain.maxStackBB ||
    depth.basis !== 'stack_plus_street_bet_vs_deepest_contesting_opponent' ||
    !exact(board, ['street', 'cards', 'paired', 'flushBoard', 'features']) ||
    !['preflop', 'flop', 'turn', 'river'].includes(street as string) ||
    board.cards !== { preflop: 0, flop: 3, turn: 4, river: 5 }[street as 'flop'] ||
    (street === 'preflop') !== (board.paired === null) ||
    (street === 'preflop') !== (board.flushBoard === null) ||
    (street === 'preflop') !== (geometry.postflop === null) ||
    (board.paired !== null && typeof board.paired !== 'boolean') ||
    (board.flushBoard !== null && typeof board.flushBoard !== 'boolean') ||
    !Array.isArray(board.features) ||
    board.features.length > 16 ||
    board.features.some((f) => typeof f !== 'string' || !/^[a-z][a-z_]{0,63}$/.test(f))
  )
    return false;
  if (
    !exact(range, ['status', 'equity', 'samples', 'standardError', 'provenance']) ||
    !RANGE_STATUSES.includes(range.status as Plo4RangeStatus)
  )
    return false;
  const consumed = range.status === 'consumed' || range.status === 'consumed_unattributed';
  return (
    (street === 'preflop') === (range.status === 'not_consumed_preflop') &&
    (approximation.status === 'explicit_heuristic_with_uncalibrated_range_sample') === consumed &&
    (consumed
      ? finite(range.equity) &&
        (range.equity as number) <= 1 &&
        Number.isSafeInteger(range.samples) &&
        (range.samples as number) > 0 &&
        finite(range.standardError) &&
        (range.standardError as number) <= 1
      : range.equity === null && range.samples === null && range.standardError === null) &&
    (range.status === 'consumed') === (range.provenance !== null) &&
    (range.provenance === null || plo4RangeProvenanceIsValid(range.provenance))
  );
}

/** The returned receipt's P10.1 fields: an eligible proposal carries a valid
 * binding and an ineligible one carries none. A retained legacy receipt
 * without the field claims no binding and is not refused. */
export function plo4LiveReceiptBindingIsValid(value: unknown): boolean {
  if (!object(value)) return false;
  if (
    Object.hasOwn(value, 'readFrameSha256') &&
    value.readFrameSha256 !== null &&
    (typeof value.readFrameSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.readFrameSha256))
  )
    return false;
  if (!Object.hasOwn(value, 'inputs')) return !Object.hasOwn(value, 'readFrameSha256');
  if (value.inputs === null) return value.eligible === false;
  return value.eligible === true && plo4InputBindingIsValid(value.inputs);
}

/** The provenance an equity sample carries, capturing it now when deferred. */
function plo4EvidenceRange(evidence: Plo4EquityEvidence): Plo4RangeProvenance | undefined {
  if (evidence.range !== undefined || !evidence.captureRange) return evidence.range;
  try {
    return evidence.captureRange();
  } catch {
    return undefined;
  }
}

/** The worker-time selection a receipt's applied/changed facts imply. */
export function plo4SelectionOf(
  receipt: Pick<Plo4LiveReceipt, 'applied' | 'changed'>
): Plo4Selection {
  return receipt.applied ? 'selected' : receipt.changed ? 'shadow_change' : 'none';
}

/** Canonical private commitment carried by the execution witness. */
export function plo4InputBindingSha256(binding: Plo4InputBinding): string {
  return horseCanonicalMaterialSha256(binding);
}

/** Only in-memory facts and a decision-local equity sample are consumed here.
 * Candidate activation remains an offline control until promotion evidence exists.
 */
export function evaluatePlo4LivePolicy(
  hero: SeatPlayer,
  s: HorseGameStateV2,
  baseline: HorseDecision,
  evidence: Plo4EquityEvidence | null,
  mode: Plo4LiveMode = 'shadow',
  now = () => performance.now(),
  /** The owner's legalizer (HorseLogic passes its own): a changed proposal is
   * recorded and executed in its exact legal form (audit 2026-10-05). */
  legalForm?: (decision: HorseDecision) => HorseDecision
) {
  const start = now();
  const receipt: Plo4LiveReceipt = {
    version: PLO4_POLICY_PACK.version,
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
  let bind: (() => Plo4InputBinding) | null = null;
  const finish = (reason: string, proposal = baseline) => {
    // Bound inside the timed region: recording the inputs is policy work.
    if (bind) receipt.inputs = bind();
    if (legalForm && proposal !== baseline)
      proposal = { ...legalForm(proposal), thinkTime: proposal.thinkTime };
    const elapsed = Math.max(0, now() - start);
    if (elapsed > PLO4_POLICY_PACK.liveBudgetMs) {
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
  if (s.gameVariant !== 'plo4') return finish('variant_outside_pack');
  if (
    s.bombPot ||
    (s.boardCount ?? 1) !== 1 ||
    s.communityCards2?.length ||
    s.communityCards3?.length
  )
    return finish('multiboard_owned_by_phase13');
  // Seats dealt this hand determine position and rake, even after a sit-out.
  let seats: SeatPlayer[];
  try {
    seats = horsePolicyDealtPlayers(s.players, hero.seat, s.dealtSeatIds);
  } catch {
    return finish('canonical_state_unavailable');
  }
  const dealt = seats.map((p) => p.seat).sort((a, b) => a - b);
  const tournamentTable = s.gameMode === 'tournament';
  const blinds = plo4BlindSeatsStatus(s.dealerSeat, dealt, s.blindSeats, tournamentTable);
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
    !plo4DealerSeatIsValid(s.dealerSeat, dealt, tournamentTable) ||
    new Set(seats.map((p) => p.seat)).size !== seats.length ||
    new Set(seats.map((p) => p.user_id)).size !== seats.length ||
    !s.legalActions?.includes(baseline.action)
  )
    return finish('canonical_state_unavailable');
  // A valid census larger than the pack (a nine-handed PLO4 tournament table)
  // is outside the declared domain, not an unavailable canonical state.
  if (seats.length > PLO4_POLICY_PACK.domain.maxSeats) return finish('seat_count_outside_pack');
  // Positions come from the blinds the engine posted (P10.1 F3/F5). A state
  // without them is refused by name, never labeled from the button alone; blind
  // seats the engine could not have posted with this button are malformed.
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
    depth > PLO4_POLICY_PACK.domain.maxStackBB ||
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
    hero.cards.length !== 4 ||
    s.communityCards.length !==
      ({ preflop: 0, flop: 3, turn: 4, river: 5 } as Record<string, number>)[s.stage]
  )
    return finish('invalid_cards');
  let facts: ReturnType<typeof omahaCardFacts>;
  try {
    facts = omahaCardFacts(hero.cards, s.communityCards, true, false);
  } catch {
    return finish('invalid_cards');
  }
  const shape = plo4HandShape(hero.cards);
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
  receipt.confidence = 'explicit_heuristic';
  // Pot-limit geometry the proposal enforces, computed once and recorded.
  const chipUnit: 0.01 | 1 = s.gameMode === 'tournament' ? 1 : 0.01;
  const potLimitRaiseTo = s.currentBet + s.pot + callCost;
  const stackRaiseTo = hero.bet + hero.stack;
  const wagerCap =
    s.maxRaiseTo == null ? null : Math.min(s.maxRaiseTo, stackRaiseTo, potLimitRaiseTo);
  // Copy the census now: the receipt never aliases the caller's arrays.
  const dealtSeats = seats.map((p) => p.seat).sort((a, b) => a - b);
  const seatsOf = (rows: readonly SeatPlayer[]) =>
    Object.freeze(rows.map((p) => p.seat).sort((a, b) => a - b));
  const census = Object.freeze({
    source: s.dealtSeatIds === undefined ? 'legacy_player_list' : 'dealt_seat_ids',
    dealerSeat: s.dealerSeat!,
    heroSeat: hero.seat,
    dealtSeats: Object.freeze(dealtSeats),
    blindSeats,
    contestingOpponentSeats: seatsOf(active),
    actingOpponentSeats: seatsOf(active.filter((p) => !p.is_all_in)),
    foldedSeats: seatsOf(seats.filter((p) => p.is_folded)),
    awaySeats: seatsOf(seats.filter((p) => p.is_sitting_out)),
    allInSeats: seatsOf(seats.filter((p) => p.is_all_in)),
  } as const);
  const positions = Object.freeze({
    hero: receipt.position,
    heroOffset: plo4ButtonOffset(hero.seat, s.dealerSeat!, dealtSeats),
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
  const boardCards = s.communityCards.length;
  const contestingIds = active.map((p) => p.user_id);
  let postflop: NonNullable<Plo4InputBinding['geometry']['postflop']> | null = null;
  let boardFacts: { paired: boolean | null; flushBoard: boolean | null } = {
    paired: null,
    flushBoard: null,
  };
  let range: Plo4InputBinding['range'] = Object.freeze({
    status: 'not_consumed_preflop',
    equity: null,
    samples: null,
    standardError: null,
    provenance: null,
  });
  bind = () =>
    Object.freeze({
      version: 'plo4-input-binding-v2',
      pack: Object.freeze({
        version: PLO4_POLICY_PACK.version,
        source: PLO4_POLICY_PACK.source,
        calibratedConfidence: null,
        seats: Object.freeze([
          PLO4_POLICY_PACK.domain.minSeats,
          PLO4_POLICY_PACK.domain.maxSeats,
        ]) as readonly [number, number],
        maxStackBB: PLO4_POLICY_PACK.domain.maxStackBB,
        maxAnteBB: PLO4_POLICY_PACK.domain.maxAnteBB,
        maxRakePercent: PLO4_POLICY_PACK.domain.maxRakePercent,
      }),
      approximation: Object.freeze({
        status:
          range.status === 'consumed' || range.status === 'consumed_unattributed'
            ? 'explicit_heuristic_with_uncalibrated_range_sample'
            : 'explicit_heuristic',
        solverInput: false,
        handShape: Object.freeze({
          score: shape.quality,
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
        cards: boardCards,
        ...boardFacts,
        features: Object.freeze([...receipt.features]),
      }),
      range,
    } satisfies Plo4InputBinding);
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
  /** Round 3: a deviation is a wager or nothing; a wager the legal menu
   * cannot hold retains the reference instead of becoming a call. */
  const deviate = (reason: string, fraction: number) => {
    const proposal = wager(fraction);
    return finish(
      reason,
      proposal.action === 'bet' || proposal.action === 'raise' || proposal.action === 'all_in'
        ? proposal
        : baseline
    );
  };
  const deviation = () =>
    plo4ReferenceDeviation(
      {
        street: s.stage,
        dealtSeats: seats.length,
        liveOpponents: active.length,
        role: receipt.role,
        position: receipt.position,
        baseline,
        callCost,
      },
      PLO4_POLICY_PACK.deviations
    );
  if (s.stage === 'preflop') {
    const chosen = deviation();
    return chosen ? deviate(chosen.reason, chosen.fraction) : finish('reference_retained');
  }

  const nuts = omahaNutStatus(hero.cards, s.communityCards);
  const paired = new Set(s.communityCards.map((c) => c.rank)).size < s.communityCards.length;
  const flushBoard = ['clubs', 'diamonds', 'hearts', 'spades'].some(
    (suit) => s.communityCards.filter((c) => c.suit === suit).length >= 3
  );
  boardFacts = { paired, flushBoard };
  const contestable = calculateContestablePot(s.players, hero.user_id, callCost);
  const chargedRake = calculateRake(s.pot + callCost, true, rake, seats.length);
  const eligibleAfterCall = contestable + callCost;
  const netPotAfterCall = Math.max(
    0,
    eligibleAfterCall - (chargedRake * eligibleAfterCall) / Math.max(0.01, s.pot + callCost)
  );
  const price = callCost / Math.max(0.01, netPotAfterCall);
  receipt.callPrice = price;
  const nutDraw = facts.flushes.some((f) => f.draw && !f.higherFlushPossible);
  const nutWrap = facts.nutStraightOutCards.length >= 8;
  const dominatedDraw = facts.flushes.some((f) => f.draw && f.higherFlushPossible);
  const set = facts.setRanks.length > 0;
  receipt.features = [
    nutWrap && 'nut_wrap',
    facts.wrapOutCount > 0 && 'straight_redraw',
    nutDraw && 'nut_flush_draw',
    dominatedDraw && 'dominated_flush_draw',
    set && 'set',
    nuts.category === 7 && 'full_house',
    nuts.category === 8 && 'quads',
    nuts.category >= 9 && 'straight_flush',
    facts.nutStraight && 'nut_straight',
    facts.nutFlushBlockerSuits.length > 0 && 'nut_flush_blocker',
    active.length > 1 && 'multiway',
    receipt.role === 'facing_raise' && 'raise_facing',
  ].filter(Boolean) as string[];
  const spr = hero.stack / Math.max(s.bigBlind, contestable);
  postflop = Object.freeze({
    contestablePot: contestable,
    eligibleAfterCall,
    chargedRake,
    netPotAfterCall,
    callPrice: price,
    spr,
  });
  const numbersValid =
    !!evidence &&
    Number.isInteger(evidence.samples) &&
    evidence.samples > 0 &&
    [evidence.equity, evidence.standardError].every(Number.isFinite) &&
    evidence.equity >= 0 &&
    evidence.equity <= 1 &&
    evidence.standardError >= 0 &&
    evidence.standardError <= 1;
  // An equity sampled against any population other than this decision's
  // contesting opponents, or relabeled as calibrated/solver input, is refused.
  const provenance = numbersValid ? plo4EvidenceRange(evidence!) : undefined;
  const populationValid =
    provenance === undefined || plo4RangeProvenanceIsValid(provenance, contestingIds);
  const e =
    numbersValid && populationValid
      ? Object.freeze({
          equity: evidence!.equity,
          samples: evidence!.samples,
          standardError: evidence!.standardError,
        })
      : null;
  receipt.equity = e;
  range = Object.freeze({
    status: !evidence
      ? 'unavailable'
      : !numbersValid
        ? 'rejected_malformed'
        : !populationValid
          ? 'rejected_population'
          : provenance === undefined
            ? 'consumed_unattributed'
            : 'consumed',
    equity: e ? e.equity : null,
    samples: e ? e.samples : null,
    standardError: e ? e.standardError : null,
    provenance: e && provenance !== undefined ? freezeProvenance(provenance) : null,
  });
  if (e) receipt.confidence = 'range_sample';
  const chosen = deviation();
  return chosen ? deviate(chosen.reason, chosen.fraction) : finish('reference_retained');
}
