import type { HorseDecision, SeatPlayer } from '../../types.js';
import { horsePolicyDealtPlayers } from '../multiway/DealtSeatCensus.js';
import type { HorseGameStateV2 } from '../HorseLogic.js';
import { calculateContestablePot, calculateRake } from '../PokerEngine.js';
import { nlhNutStatus } from '../HorseEval.js';
import { fixedLimitStreetBounds } from '../BettingStructure.js';
import { omahaCardFacts } from '../omaha/OmahaCardFacts.js';
import {
  validOmahaVariantEquity,
  type OmahaVariantEquityEvidence,
} from '../omaha/OmahaVariantEquity.js';
import type { OmahaVariantMode, OmahaVariantReceipt } from '../omaha/OmahaVariantLivePolicy.js';
import { plo4Position, plo4Role, plo4PreflopChoice } from '../plo4/Plo4LivePolicy.js';
import {
  REMAINING_VARIANT_PACKS,
  REMAINING_VARIANT_DOMAIN,
  isRemainingPolicyVariant,
  remainingVariantSeatCap,
  remainingVariantHandShape,
  remainingVariantEntryBars,
} from './RemainingVariantPolicyPack.js';
import { sampleRemainingVariantEquity } from './RemainingVariantSampler.js';

// Receipt shape and public geometry are common contracts. Hand shape, ranges,
// thresholds, card rules and wager sizing are supplied by the actual variant.
export type RemainingVariantMode = OmahaVariantMode;
export type RemainingVariantReceipt = OmahaVariantReceipt;
const same = (a: HorseDecision, b: HorseDecision) =>
  a.action === b.action && (!['bet', 'raise'].includes(a.action) || a.amount === b.amount);

export function evaluateRemainingVariantPolicy(
  hero: SeatPlayer,
  s: HorseGameStateV2,
  baseline: HorseDecision,
  evidence: OmahaVariantEquityEvidence | null,
  mode: RemainingVariantMode = 'shadow',
  now = () => performance.now(),
  decisionEquityCeiling = 1,
  sampleWhenMissing = true
) {
  const start = now(),
    variant = isRemainingPolicyVariant(s.gameVariant) ? s.gameVariant : null;
  const pack = variant ? REMAINING_VARIANT_PACKS[variant] : null;
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
    equity: evidence,
    callPrice: null,
    utilityOwner: s.gameMode === 'tournament' ? 'phase7_pending' : 'cash',
    latencyMs: 0,
    executionStatus: 'pending',
    executedAction: null,
    executedAmount: null,
  };
  const finish = (reason: string, proposal = baseline) => {
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
  if (
    s.stateSchemaVersion !== 1 ||
    s.bettingStructure !== pack.structure ||
    !['cash', 'tournament'].includes(s.gameMode ?? '') ||
    seats.length < 2 ||
    seats.length >
      remainingVariantSeatCap(variant, s.gameMode === 'tournament' ? 'tournament' : 'cash') ||
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
  const fixedSize = s.bigBlind * (['turn', 'river'].includes(s.stage) ? 2 : 1);
  const fixedRaise = limit
    ? fixedLimitStreetBounds(s.actionHistory ?? [], s.stage, fixedSize, s.currentBet).raiseSize
    : 0;
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
  const depth =
    Math.min(hero.stack + hero.bet, Math.max(...active.map((p) => p.stack + p.bet))) / s.bigBlind;
  receipt.depthBB = depth;
  if (
    !Number.isFinite(depth) ||
    depth <= 0 ||
    depth >
      (limit
        ? REMAINING_VARIANT_DOMAIN.fixedLimitMaxStackBB
        : REMAINING_VARIANT_DOMAIN.maxStackBB) ||
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
    s.communityCards.length !==
    ({ preflop: 0, flop: 3, turn: 4, river: 5 } as Record<string, number>)[s.stage]
  )
    return finish('invalid_cards');
  const postDiscard = variant === 'pineapple' && s.stage !== 'preflop';
  let shape: ReturnType<typeof remainingVariantHandShape>;
  try {
    shape = remainingVariantHandShape(variant, hero.cards, postDiscard);
    const dead = hero.knownDeadCards ?? [];
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
  receipt.position = plo4Position(hero.seat, s);
  receipt.role = plo4Role(hero, s);
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
  receipt.aggressorPosition = aggressor ? plo4Position(aggressor.seat, s) : null;
  receipt.eligible = true;
  receipt.fired = true;
  receipt.confidence = 'explicit_variant_heuristic';
  const passive = (): HorseDecision => ({
    action: callCost ? 'fold' : 'check',
    thinkTime: baseline.thinkTime,
  });
  const call = (): HorseDecision => ({
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
        return { action: 'all_in', thinkTime: baseline.thinkTime };
      return call();
    }
    const maximum = Math.min(s.maxRaiseTo, hero.bet + hero.stack),
      unit = s.gameMode === 'tournament' ? 1 : 0.01;
    const target = limit
      ? s.minRaiseTo
      : Math.max(s.minRaiseTo, Math.min(maximum, s.currentBet + (s.pot + callCost) * fraction));
    const amount = Math.floor(target / unit + 1e-7) * unit;
    if (amount < s.minRaiseTo || amount > maximum) return call();
    return { action, amount: Math.round(amount * 100) / 100, thinkTime: baseline.thinkTime };
  };
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
      () => now() - start < REMAINING_VARIANT_DOMAIN.samplingDeadlineMs
    );
    if (evidence) evidence.decisionEquityCeiling = decisionEquityCeiling;
  }
  const contestable = calculateContestablePot(s.players, hero.user_id, callCost),
    eligibleAfterCall = contestable + callCost;
  const chargedRake = calculateRake(s.pot + callCost, true, rake, seats.length);
  const netPot = Math.max(
    0,
    eligibleAfterCall - (chargedRake * eligibleAfterCall) / Math.max(0.01, s.pot + callCost)
  );
  const price = callCost / Math.max(0.01, netPot);
  receipt.callPrice = price;
  const e = validOmahaVariantEquity(evidence, eligibleAfterCall) ? evidence : null;
  if (!e) {
    receipt.fired = false;
    receipt.equity = null;
    return finish(evidence ? 'invalid_equity_evidence' : 'equity_budget_unavailable');
  }
  receipt.equity = e;
  receipt.confidence = 'range_sample';
  const ceiling = e.decisionEquityCeiling ?? 1;
  if (!Number.isFinite(ceiling) || ceiling < 0 || ceiling > 1) {
    receipt.fired = false;
    return finish('invalid_equity_ceiling');
  }
  const equity = Math.min(e.equity, ceiling),
    lower = Math.min(e.confidence99[0], ceiling),
    upper = Math.min(e.confidence99[1], ceiling);
  const pressure =
    Math.max(0, active.length - 1) * pack.multiway +
    Number(receipt.role === 'facing_raise') * (limit ? 0.01 : 0.04);
  let lowOnly = false,
    quarterRisk = false,
    draw = false,
    dominated = false;
  if (variant === 'flo8') {
    const facts = splitFacts!;
    lowOnly = facts.nutLow && e.highEquity < 0.15;
    quarterRisk = e.quarterOrLessProbability >= 0.2 || e.sixthOrLessProbability >= 0.1;
    draw =
      facts.flushes.some((f) => f.draw && !f.higherFlushPossible) ||
      facts.nutStraightOutCards.length >= 8;
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
    draw = ['clubs', 'diamonds', 'hearts', 'spades'].some(
      (suit) =>
        all.filter((c) => c.suit === suit).length === 4 && hero.cards.some((c) => c.suit === suit)
    );
    const nuts = nlhNutStatus(hero.cards, s.communityCards, variant === 'short_deck');
    dominated = nuts.flushPossible && nuts.higherFlushRanks > 0;
    if (draw) receipt.features.push('flush_draw');
    if (dominated) receipt.features.push('higher_flush_available');
  }
  if (e.perPot.length > 1) receipt.features.push('separate_pot_eligibility');
  if (!callCost) {
    if (!lowOnly && !quarterRisk && lower > pack.value + pressure)
      return finish('variant_value_bet', wager(0.66));
    if (
      s.stage !== 'river' &&
      !limit &&
      !dominated &&
      draw &&
      active.length === 1 &&
      receipt.position === 'button' &&
      equity > 0.4
    )
      return finish('variant_draw_pressure', wager(0.5));
    return finish(lowOnly ? 'low_only_protected_check' : 'variant_protected_check', passive());
  }
  if (upper < price + pressure) return finish('variant_price_fold', passive());
  if (lowOnly || quarterRisk)
    return finish(
      equity >= price + pressure ? 'split_price_call' : 'split_price_fold',
      equity >= price + pressure ? call() : passive()
    );
  if (lower > Math.max(pack.value + pressure, price + pressure) && receipt.role !== 'call_off')
    return finish('variant_value_raise', wager(0.66));
  return finish(
    equity >= price + pressure ? 'variant_price_call' : 'variant_price_fold',
    equity >= price + pressure ? call() : passive()
  );
}
