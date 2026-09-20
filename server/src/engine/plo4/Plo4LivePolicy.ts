import type { HorseDecision, SeatPlayer } from '../../types.js';
import type { HorseGameStateV2 } from '../HorseLogic.js';
import { omahaNutStatus } from '../HorseEval.js';
import { omahaCardFacts } from '../omaha/OmahaCardFacts.js';
import { calculateContestablePot, calculateRake } from '../PokerEngine.js';
import { horsePolicyDealtPlayers } from '../multiway/DealtSeatCensus.js';
import {
  PLO4_POLICY_PACK,
  plo4HandShape,
  type Plo4Position,
  type Plo4NodeRole,
} from './Plo4PolicyPack.js';

export type Plo4LiveMode = 'off' | 'shadow' | 'candidate';
export interface Plo4EquityEvidence {
  equity: number;
  samples: number;
  standardError: number;
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
  equity: Plo4EquityEvidence | null;
  callPrice: number | null;
  shadowUtility?: import('../../types.js').HorseTournamentUtilityLedger;
  utilityOwner: 'cash' | 'phase7_pending' | 'phase7_evaluated' | 'phase7_unavailable';
  utilityLatencyMs?: number;
  utilityUnavailableReason?: string;
  latencyMs: number;
  executionStatus: 'pending' | 'intended' | 'coerced' | 'fallback' | 'not_executed';
  executedAction: HorseDecision['action'] | null;
  executedAmount: number | null;
}
export function plo4Position(seat: number, state: HorseGameStateV2): Plo4Position {
  const seats = horsePolicyDealtPlayers(state.players, seat, state.dealtSeatIds)
    .map((p) => p.seat)
    .sort((a, b) => a - b);
  const offset =
    (seats.indexOf(seat) - seats.indexOf(state.dealerSeat!) + seats.length) % seats.length;
  if (offset === 0) return 'button';
  if (seats.length === 2 || offset === 2) return 'big_blind';
  if (offset === 1) return 'small_blind';
  if (offset === seats.length - 1) return 'cutoff';
  return offset === 3 ? 'early' : 'middle';
}
export function plo4Role(hero: SeatPlayer, state: HorseGameStateV2): Plo4NodeRole {
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
    return ['small_blind', 'big_blind'].includes(plo4Position(hero.seat, state))
      ? 'defense'
      : 'three_bet';
  }
  if (
    line.some((a) => a.action === 'call' || (a.action === 'all_in' && a.isFullRaise === undefined))
  )
    return 'isolation';
  if (plo4Position(hero.seat, state) === 'small_blind' || !state.toCall) return 'limp_option';
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

const same = (a: HorseDecision, b: HorseDecision) =>
  a.action === b.action && (!['bet', 'raise'].includes(a.action) || a.amount === b.amount);

/** Only in-memory facts and a decision-local equity sample are consumed here.
 * Candidate activation remains an offline control until promotion evidence exists.
 */
export function evaluatePlo4LivePolicy(
  hero: SeatPlayer,
  s: HorseGameStateV2,
  baseline: HorseDecision,
  evidence: Plo4EquityEvidence | null,
  mode: Plo4LiveMode = 'shadow',
  now = () => performance.now()
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
    equity: evidence,
    callPrice: null,
    utilityOwner: s.gameMode === 'tournament' ? 'phase7_pending' : 'cash',
    latencyMs: 0,
    executionStatus: 'pending',
    executedAction: null,
    executedAmount: null,
  };
  const finish = (reason: string, proposal = baseline) => {
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
  if (
    s.stateSchemaVersion !== 1 ||
    s.bettingStructure !== 'pot_limit' ||
    seats.length < 2 ||
    seats.length > 8 ||
    !['cash', 'tournament'].includes(s.gameMode ?? '') ||
    !seats.some(
      (p) =>
        p.user_id === hero.user_id &&
        p.seat === hero.seat &&
        p.stack === hero.stack &&
        p.bet === hero.bet &&
        p.totalInvested === hero.totalInvested
    ) ||
    !seats.some((p) => p.seat === s.dealerSeat) ||
    new Set(seats.map((p) => p.seat)).size !== seats.length ||
    new Set(seats.map((p) => p.user_id)).size !== seats.length ||
    !s.legalActions?.includes(baseline.action)
  )
    return finish('canonical_state_unavailable');
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
  const depth =
    Math.min(hero.stack + hero.bet, Math.max(...active.map((p) => p.stack + p.bet))) / s.bigBlind;
  receipt.depthBB = depth;
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
  receipt.position = plo4Position(hero.seat, s);
  receipt.role = plo4Role(hero, s);
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
  receipt.aggressorPosition = aggressor ? plo4Position(aggressor.seat, s) : null;
  receipt.eligible = true;
  receipt.fired = true;
  receipt.confidence = 'explicit_heuristic';
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
    if (!s.legalActions!.includes(action) || s.minRaiseTo == null || s.maxRaiseTo == null) {
      if (
        s.legalActions!.includes('all_in') &&
        hero.bet + hero.stack <= s.currentBet + s.pot + callCost + 0.001
      )
        return { action: 'all_in', thinkTime: baseline.thinkTime };
      return call();
    }
    const maximum = Math.min(s.maxRaiseTo, hero.bet + hero.stack, s.currentBet + s.pot + callCost);
    if (maximum < s.minRaiseTo) return call();
    const unit = s.gameMode === 'tournament' ? 1 : 0.01;
    const amount =
      Math.floor(
        Math.max(s.minRaiseTo, Math.min(maximum, s.currentBet + (s.pot + callCost) * fraction)) /
          unit +
          1e-7
      ) * unit;
    if (amount < s.minRaiseTo) return call();
    return { action, amount: Math.round(amount * 100) / 100, thinkTime: baseline.thinkTime };
  };
  if (s.stage === 'preflop') {
    const bars = plo4EntryBars({
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

  const nuts = omahaNutStatus(hero.cards, s.communityCards);
  const paired = new Set(s.communityCards.map((c) => c.rank)).size < s.communityCards.length;
  const flushBoard = ['clubs', 'diamonds', 'hearts', 'spades'].some(
    (suit) => s.communityCards.filter((c) => c.suit === suit).length >= 3
  );
  const isNut =
    facts.nutStraightFlush ||
    (!paired &&
      ((nuts.category === 6 &&
        facts.opponentStraightFlushHigh === 0 &&
        facts.flushes.some((f) => f.made && !f.higherFlushPossible)) ||
        (nuts.category === 5 && facts.nutStraight && !flushBoard)));
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
  const strongMade = nuts.category >= 7;
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
  const e =
    evidence &&
    Number.isInteger(evidence.samples) &&
    evidence.samples > 0 &&
    [evidence.equity, evidence.standardError].every(Number.isFinite) &&
    evidence.equity >= 0 &&
    evidence.equity <= 1 &&
    evidence.standardError >= 0 &&
    evidence.standardError <= 1
      ? evidence
      : null;
  if (e) receipt.confidence = 'range_sample';
  const lower = e ? Math.max(0, e.equity - 2.576 * e.standardError) : null;
  const upper = e ? Math.min(1, e.equity + 2.576 * e.standardError) : null;
  const pressure = (active.length - 1) * 0.025 + Number(receipt.role === 'facing_raise') * 0.04;
  if (!callCost) {
    if (
      isNut ||
      ((set || strongMade) && (!e || e.equity > 0.55)) ||
      (lower !== null && lower > 0.58 + pressure)
    )
      return finish('postflop_value', wager(spr < 2 ? 1 : 0.66));
    if ((nutDraw || nutWrap) && active.length === 1 && receipt.position === 'button')
      return finish('postflop_nut_draw_pressure', wager(0.5));
    return finish('postflop_protected_check', passive());
  }
  if (isNut && (s.stage === 'river' || spr <= 2 || nutDraw))
    return finish('postflop_nut_raise', wager(1));
  if (upper !== null && upper < price + pressure) return finish('postflop_price_fold', passive());
  if (
    dominatedDraw &&
    !strongMade &&
    !set &&
    !facts.nutStraight &&
    spr > 3 &&
    price > 0.2 &&
    (lower === null || lower < price + 0.08)
  )
    return finish('postflop_dominated_draw_fold', passive());
  if (
    lower !== null &&
    lower > Math.max(price + pressure, 0.6 + pressure) &&
    receipt.role !== 'call_off'
  )
    return finish('postflop_value_raise', wager(0.66));
  if (isNut || strongMade || set || nutDraw || nutWrap || (e && e.equity >= price + pressure))
    return finish('postflop_price_call', call());
  // No equity available is explicit; bounded own-card texture still owns the node.
  return finish(e ? 'postflop_bluff_catcher_fold' : 'postflop_uncalibrated_texture', passive());
}
