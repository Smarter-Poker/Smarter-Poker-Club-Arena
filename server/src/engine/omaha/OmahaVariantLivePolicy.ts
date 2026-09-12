import { sampleOmahaVariantEquity } from './OmahaVariantSampler.js';
import type { HorseDecision, SeatPlayer } from '../../types.js';
import type { HorseGameStateV2 } from '../HorseLogic.js';
import { omahaNutStatus } from '../HorseEval.js';
import { omahaCardFacts } from './OmahaCardFacts.js';
import { calculateContestablePot, calculateRake } from '../PokerEngine.js';
// Shared public seat/action geometry and legal choice kernel. No Phase 10
// hand-quality model, entry threshold or equity calibration is imported.
import { plo4Position, plo4Role, plo4PreflopChoice } from '../plo4/Plo4LivePolicy.js';
import {
  isOmahaPolicyVariant,
  OMAHA_VARIANT_PACKS,
  OMAHA_VARIANT_DOMAIN,
  omahaVariantHandShape,
  omahaVariantEntryBars,
  omahaVariantSeatCap,
  type OmahaPolicyPosition,
  type OmahaPolicyRole,
} from './OmahaVariantPolicyPack.js';
import { validOmahaVariantEquity, type OmahaVariantEquityEvidence } from './OmahaVariantEquity.js';

export type OmahaVariantMode = 'off' | 'shadow' | 'candidate';
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
  equity: OmahaVariantEquityEvidence | null;
  callPrice: number | null;
  shadowUtility?: import('../../types.js').HorseTournamentUtilityLedger;
  utilityOwner: 'cash' | 'phase7_pending' | 'phase7_evaluated' | 'phase7_unavailable';
  utilityLatencyMs?: number;
  latencyMs: number;
  executionStatus: 'pending' | 'intended' | 'coerced' | 'fallback' | 'not_executed';
  executedAction: HorseDecision['action'] | null;
  executedAmount: number | null;
}
const same = (a: HorseDecision, b: HorseDecision) =>
  a.action === b.action && (!['bet', 'raise'].includes(a.action) || a.amount === b.amount);

/** Only in-memory facts and a decision-local equity sample are consumed here.
 * Candidate activation remains an offline control until promotion evidence exists.
 */
export function evaluateOmahaVariantPolicy(
  hero: SeatPlayer,
  s: HorseGameStateV2,
  baseline: HorseDecision,
  evidence: OmahaVariantEquityEvidence | null,
  mode: OmahaVariantMode = 'shadow',
  now = () => performance.now(),
  decisionEquityCeiling = 1,
  sampleWhenMissing = true
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
    equity: evidence,
    callPrice: null,
    utilityOwner: s.gameMode === 'tournament' ? 'phase7_pending' : 'cash',
    latencyMs: 0,
    executionStatus: 'pending',
    executedAction: null,
    executedAmount: null,
  };
  const finish = (reason: string, proposal = baseline) => {
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
  const seats = s.players.filter((p) => !p.is_sitting_out);
  if (
    s.stateSchemaVersion !== 1 ||
    s.bettingStructure !== 'pot_limit' ||
    seats.length < 2 ||
    seats.length >
      omahaVariantSeatCap(variant, s.gameMode === 'tournament' ? 'tournament' : 'cash') ||
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
  if (s.players.some((p) => p.cards.length > 0)) return finish('private_state_rejected');
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
  const active = seats.filter((p) => p.user_id !== hero.user_id && !p.is_folded);
  const depth =
    Math.min(hero.stack + hero.bet, Math.max(...active.map((p) => p.stack + p.bet))) / s.bigBlind;
  receipt.depthBB = depth;
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
  try {
    facts = omahaCardFacts(hero.cards, s.communityCards, true, pack.splitPot);
  } catch {
    return finish('invalid_cards');
  }
  const shape = omahaVariantHandShape(variant, hero.cards);
  receipt.position = plo4Position(hero.seat, s);
  receipt.role = plo4Role(hero, s);
  const aggressor = (s.actionHistory ?? [])
    .filter(
      (a) =>
        a.userId !== hero.user_id &&
        a.stage === s.stage &&
        ['bet', 'raise', 'all_in'].includes(a.action)
    )
    .at(-1);
  receipt.aggressorPosition = aggressor ? plo4Position(aggressor.seat, s) : null;
  receipt.eligible = true;
  receipt.fired = true;
  receipt.confidence = 'explicit_variant_heuristic';
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
    evidence = sampleOmahaVariantEquity(variant, hero, s, () => now() - start < 3);
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
  const contestable = calculateContestablePot(s.players, hero.user_id, callCost);
  const eligibleAfterCall = contestable + callCost;
  const chargedRake = calculateRake(s.pot + callCost, true, rake, seats.length);
  const netPot = Math.max(
    0,
    eligibleAfterCall - (chargedRake * eligibleAfterCall) / Math.max(0.01, s.pot + callCost)
  );
  const price = callCost / Math.max(0.01, netPot);
  receipt.callPrice = price;
  const e = validOmahaVariantEquity(evidence, eligibleAfterCall) ? evidence : null;
  if (evidence && !e) {
    receipt.fired = false;
    receipt.equity = null;
    return finish('invalid_equity_evidence');
  }
  if (e) receipt.confidence = 'range_sample';
  receipt.equity = e;
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
  const spr = hero.stack / Math.max(s.bigBlind, contestable);
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
      return finish('variant_value_bet', wager(spr < 2 ? 1 : 0.66));
    if (
      !lowOnly &&
      !quarterRisk &&
      !sixthRisk &&
      active.length === 1 &&
      receipt.position === 'button' &&
      (nutDraw || nutWrap) &&
      (!pack.splitPot || shape.backupLow)
    )
      return finish('variant_draw_pressure', wager(0.5));
    return finish(lowOnly ? 'low_only_protected_check' : 'variant_protected_check', passive());
  }
  if (upper !== null && upper < price + pressure) return finish('variant_price_fold', passive());
  if (scoopStructure && (s.stage === 'river' || spr <= 2))
    return finish('variant_scoop_raise', wager(1));
  // Low-only strength must not turn a quarter/sixth into an expensive raise.
  // The actual combined, per-pot distribution still decides whether to call.
  if (quarterRisk || sixthRisk || lowOnly) {
    if (equity !== null)
      return finish(
        equity >= price + pressure ? 'split_price_call' : 'split_price_fold',
        equity >= price + pressure ? call() : passive()
      );
    if (facts.nutLow && !counterfeit && price <= 0.125 && receipt.role !== 'facing_raise')
      return finish('unmeasured_nut_low_small_call', call());
    return finish('split_equity_unavailable', passive());
  }
  if (
    dominatedDraw &&
    !highNuts &&
    !highStrong &&
    spr > 3 &&
    price > 0.2 &&
    (lower === null || lower < price + 0.08)
  )
    return finish('variant_dominated_draw_fold', passive());
  if (
    lower !== null &&
    lower > Math.max(price + pressure, pack.valueEquity + pressure) &&
    receipt.role !== 'call_off'
  )
    return finish('variant_value_raise', wager(0.66));
  if (
    (equity !== null && equity >= price + pressure) ||
    (highNuts && !lowPossible) ||
    (!e && !lowPossible && price <= 0.2 && (highStrong || nutDraw || nutWrap))
  )
    return finish('variant_price_call', call());
  return finish(e ? 'variant_bluff_catcher_fold' : 'variant_uncalibrated_texture', passive());
}
