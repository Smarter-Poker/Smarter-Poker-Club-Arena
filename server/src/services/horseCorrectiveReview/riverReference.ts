import type { Card } from '../../types.js';
import type {
  AlternativeActionReference,
  CorrectiveReferenceBinding,
  CorrectiveReferenceDomain,
} from './contract.js';
import {
  scoreHoldemReference,
  scoreOmahaHi,
  scoreOmahaLow,
  variantInfo,
} from '../../engine/HorseEval.js';
import { correctiveDomainIsValid } from './domain.js';
import { chipCents } from './eligibility.js';
import { evidenceDigest, sha256 } from './authority.js';
import type { FastHorseDecisionRequest } from '../../engine/horseDecision/protocol.js';
import { correctiveDecisionDomain } from './domain.js';
import { correctiveUtilityContextDigest, correctiveActionIsLegal } from './originalAction.js';
import { calculateContestablePot } from '../../engine/PokerEngine.js';
import { prepareJointPots, settleJointScores } from '../../engine/multiway/JointPotDistribution.js';
import { applyJointDeductions } from '../../engine/multiway/JointDeductions.js';

export interface RiverDecisionInput {
  domain: CorrectiveReferenceDomain;
  stage: string;
  boardCount: number;
  opponents: number;
  opponentAllIn: boolean;
  hero: Card[];
  board: Card[];
  range: Array<{ cards: Card[]; weight: number }>;
  /** Pin from the declared range-model input, independently reviewed with it. */
  rangeDigest: string;
  rangeReadFrameDigest: string;
  contestablePot: number;
  toCall: number;
  stack: number;
  bigBlind: number;
  /** Optional decision-time quote; the calculator derives it from original
   * settings. Retrospective evidence must pin the resulting quote explicitly. */
  finalRake?: number;
  utilityContextDigest: string;
  original: { snapshot: FastHorseDecisionRequest; readFrame: unknown };
}
export interface RiverReferenceInput extends RiverDecisionInput {
  finalRake: number;
  evidenceClass: AlternativeActionReference['evidenceClass'];
  sourceId: string;
  qualificationId: string;
  producerDigest: string;
  binding: CorrectiveReferenceBinding;
}
export type RiverDecisionPrices =
  | {
      status: 'priced';
      inputDigest: string;
      readFrameDigest: string;
      samplingContractDigest: string;
      finalRake: number;
      alternatives: AlternativeActionReference['alternatives'];
    }
  | { status: 'unavailable'; reason: string };
export type RiverReferenceResult =
  | {
      status: 'produced';
      reference: AlternativeActionReference;
      qualified: false;
      activationAllowed: false;
    }
  | { status: 'unavailable'; reason: string };

/** Offline finite-menu arithmetic, conditional on the entire declared range.
 * No observed opponent hole cards, future board, sampler, network, RNG or key
 * store is read. Exact intervals concern enumeration error only: the range
 * model and producer still require independent qualification and signature.
 * Creating this unsigned reference neither qualifies nor activates it. */
export function priceRiverCallFoldDecision(input: RiverDecisionInput): RiverDecisionPrices {
  const no = (reason: string): RiverDecisionPrices => ({ status: 'unavailable', reason });
  try {
    const i = input;
    if (
      !correctiveDomainIsValid(i?.domain) ||
      i.domain.mode !== 'cash' ||
      i.domain.format !== 'cash'
    )
      return no('unsupported_utility_domain');
    if (i.stage !== 'river' || i.boardCount !== 1 || i.opponents !== 1 || i.opponentAllIn !== true)
      return no('unsupported_future_action_or_board');
    if (!sha256(i.utilityContextDigest) || !sha256(i.rangeReadFrameDigest))
      return no('original_information_binding_invalid');
    const money = [
      i.contestablePot,
      i.toCall,
      i.stack,
      i.bigBlind,
      ...(i.finalRake === undefined ? [] : [i.finalRake]),
    ].map(chipCents);
    if (
      money.some((x) => x === null) ||
      i.bigBlind <= 0 ||
      i.toCall <= 0 ||
      i.toCall > i.stack ||
      (i.finalRake !== undefined && i.finalRake > i.contestablePot + i.toCall)
    )
      return no('original_price_invalid');
    const snapshot = i.original?.snapshot,
      gs = snapshot?.gameState,
      hero = snapshot?.player;
    const same = (a: unknown, b: unknown) => evidenceDigest(a) === evidenceDigest(b);
    if (
      !snapshot ||
      !gs ||
      !hero ||
      hero.is_folded ||
      hero.is_all_in ||
      !correctiveActionIsLegal(snapshot, { action: 'fold', amount: 0 }) ||
      !correctiveActionIsLegal(snapshot, { action: 'call', amount: i.toCall }) ||
      evidenceDigest(i.original.readFrame) !== i.rangeReadFrameDigest ||
      correctiveUtilityContextDigest(snapshot) !== i.utilityContextDigest ||
      !same(correctiveDecisionDomain(gs), i.domain) ||
      !same(hero.cards, i.hero) ||
      !same(gs.communityCards, i.board) ||
      gs.stage !== 'river' ||
      gs.boardCount !== 1 ||
      (gs.communityCards2?.length ?? 0) > 0 ||
      (gs.communityCards3?.length ?? 0) > 0 ||
      gs.asset !== 'chips' ||
      gs.chipUnit !== 0.01 ||
      Math.min(gs.toCall!, hero.stack) !== i.toCall ||
      Math.min(gs.currentBet - hero.bet, hero.stack) !== i.toCall ||
      hero.stack !== i.stack ||
      gs.bigBlind !== i.bigBlind ||
      gs.contestablePot !== i.contestablePot ||
      calculateContestablePot(gs.players, hero.user_id, i.toCall) !== i.contestablePot ||
      !Array.isArray(gs.legalActions) ||
      new Set(gs.legalActions).size !== gs.legalActions.length ||
      gs.legalActions.some((action) => !['fold', 'call', 'raise', 'all_in'].includes(action)) ||
      !gs.legalActions.includes('fold') ||
      !gs.legalActions.includes('call') ||
      !gs.rakeConfig ||
      !Array.isArray(gs.dealtSeatIds) ||
      !gs.dealtSeatIds.includes(hero.seat) ||
      new Set(gs.dealtSeatIds).size !== gs.dealtSeatIds.length ||
      gs.players.some((p) => p.cards.length > 0) ||
      !sha256(i.rangeDigest) ||
      i.rangeDigest !== evidenceDigest(i.range)
    )
      return no('original_snapshot_or_range_pin_mismatch');
    const publicHeroes = gs.players.filter((p) => p.user_id === hero.user_id);
    if (
      publicHeroes.length !== 1 ||
      !['seat', 'stack', 'bet', 'totalInvested', 'is_folded', 'is_all_in', 'is_sitting_out'].every(
        (field) => publicHeroes[0]![field as keyof typeof hero] === hero[field as keyof typeof hero]
      ) ||
      (publicHeroes[0]!.deadInvested ?? 0) !== (hero.deadInvested ?? 0) ||
      (publicHeroes[0]!.individualAnteInvested ?? 0) !== (hero.individualAnteInvested ?? 0)
    )
      return no('original_public_hero_mismatch');
    const opponents = gs.players.filter((p) => p.user_id !== hero.user_id && !p.is_folded);
    if (opponents.length !== 1 || !opponents[0]!.is_all_in || opponents[0]!.stack !== 0)
      return no('original_opponent_not_all_in');
    const prepared = prepareJointPots(
      gs.players.map((p) =>
        p.user_id === hero.user_id
          ? {
              ...p,
              stack: p.stack - i.toCall,
              bet: p.bet + i.toCall,
              totalInvested: p.totalInvested + i.toCall,
              is_all_in: p.stack === i.toCall,
            }
          : p
      ),
      0.01
    );
    const vi = variantInfo(i.domain.variant);
    const count = i.domain.variant === 'pineapple' ? 2 : vi.holeCount;
    const key = (c: Card) => `${c.rank}:${c.suit}`;
    const valid = (c: Card) =>
      c &&
      typeof c === 'object' &&
      ['hearts', 'diamonds', 'clubs', 'spades'].includes(c.suit) &&
      (vi.isShortDeck
        ? ['6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A']
        : ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A']
      ).includes(c.rank);
    if (
      !Array.isArray(i.hero) ||
      i.hero.length !== count ||
      !Array.isArray(i.board) ||
      i.board.length !== 5 ||
      ![...i.hero, ...i.board].every(valid) ||
      new Set([...i.hero, ...i.board].map(key)).size !== count + 5
    )
      return no('original_cards_invalid');
    if (!Array.isArray(i.range) || !i.range.length || i.range.length > 4096)
      return no('declared_range_bounds');
    const dead = new Set([...i.hero, ...i.board].map(key));
    const seen = new Set<string>();
    let weight = 0,
      weightedReturn = 0;
    let finalRake: number | undefined;
    const high = (hole: Card[]) =>
      vi.isOmaha
        ? scoreOmahaHi(hole, i.board)
        : scoreHoldemReference([...hole, ...i.board], hole.length + 5, vi.isShortDeck);
    const heroHigh = high(i.hero);
    const heroLow = vi.isHiLo ? scoreOmahaLow(i.hero, i.board) : Infinity;
    for (const row of i.range) {
      if (
        !row ||
        !Array.isArray(row.cards) ||
        row.cards.length !== count ||
        !row.cards.every(valid) ||
        new Set(row.cards.map(key)).size !== count ||
        row.cards.some((c) => dead.has(key(c))) ||
        !Number.isFinite(row.weight) ||
        row.weight <= 0 ||
        row.weight > 1_000_000
      )
        return no('declared_range_invalid');
      const combination = row.cards.map(key).sort().join('|');
      if (seen.has(combination)) return no('duplicate_range_combination');
      seen.add(combination);
      const otherLow = vi.isHiLo ? scoreOmahaLow(row.cards, i.board) : Infinity;
      const settlement = settleJointScores({
        prepared,
        heroId: hero.user_id,
        opponentIds: [opponents[0]!.user_id],
        splitLow: vi.isHiLo,
        dealerSeat: gs.dealerSeat!,
        sample: {
          boards: [
            {
              heroHigh,
              opponentHigh: [high(row.cards)],
              heroLow: Number.isFinite(heroLow) ? heroLow : null,
              opponentLow: [Number.isFinite(otherLow) ? otherLow : null],
              // No future opponent decision exists in this all-in domain.
              opponentDecisionStrength: [0],
            },
          ],
        },
      });
      const paid = applyJointDeductions({
        settlement,
        rakeConfig: gs.rakeConfig,
        bbjConfig: gs.bbjConfig ?? null,
        asset: 'chips',
        gameMode: 'cash',
        bigBlind: i.bigBlind,
        dealtPlayers: gs.dealtSeatIds.length,
        sawFlop: true,
      });
      const deduction = paid.rake + paid.bbjFee;
      if (
        (i.finalRake !== undefined && deduction !== i.finalRake) ||
        (finalRake !== undefined && deduction !== finalRake)
      )
        return no('original_deduction_mismatch');
      finalRake = deduction;
      weight += row.weight;
      weightedReturn += (paid.netTotals[hero.user_id]! + paid.refunds[hero.user_id]!) * row.weight;
    }
    const call = (weightedReturn / weight - i.toCall) / i.bigBlind;
    if (!Number.isFinite(call)) return no('enumeration_arithmetic_invalid');
    const samplingContractDigest = evidenceDigest({
      version: 'horse-river-call-fold-reference-v2',
      menuScope: 'fold_call_only_other_baseline_actions_unchanged',
      domain: i.domain,
      hero: i.hero,
      board: i.board,
      range: i.range,
      rangeReadFrameDigest: i.rangeReadFrameDigest,
      contestablePot: i.contestablePot,
      toCall: i.toCall,
      stack: i.stack,
      bigBlind: i.bigBlind,
      finalRake,
      utilityContextDigest: i.utilityContextDigest,
      scope: 'entire_declared_range_only',
      maxCombinations: 4096,
    });
    return {
      status: 'priced',
      finalRake: finalRake!,
      inputDigest: evidenceDigest(snapshot),
      readFrameDigest: evidenceDigest(i.original.readFrame),
      samplingContractDigest,
      alternatives: [
        { choice: { action: 'fold', amount: 0 }, mean: 0, lower: 0, upper: 0 },
        { choice: { action: 'call', amount: i.toCall }, mean: call, lower: call, upper: call },
      ],
    };
  } catch {
    return no('original_information_unreadable');
  }
}

/** Retrospective evidence wrapper. Execution/accepted-hand identity belongs
 * here, after the hand; the original-state calculator never requires it. */
export function produceRiverCallFoldReference(i: RiverReferenceInput): RiverReferenceResult {
  const no = (reason: string): RiverReferenceResult => ({ status: 'unavailable', reason });
  try {
    const id = (s: unknown) => typeof s === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(s);
    if (
      chipCents(i.finalRake) === null ||
      !['synthetic_fixture', 'reviewed_reference'].includes(i.evidenceClass) ||
      !id(i.sourceId) ||
      !id(i.qualificationId) ||
      !sha256(i.producerDigest) ||
      !i.binding ||
      !id(i.binding.decisionEventId) ||
      !/^[0-9a-f]{40}$/.test(i.binding.sourceRelease) ||
      ![
        'decisionDigest',
        'executionDigest',
        'acceptedHandDigest',
        'inputDigest',
        'readFrameDigest',
      ].every((k) => sha256(i.binding[k as keyof CorrectiveReferenceBinding])) ||
      i.rangeReadFrameDigest !== i.binding.readFrameDigest
    )
      return no('original_information_binding_invalid');
    const prices = priceRiverCallFoldDecision(i);
    if (prices.status !== 'priced') return prices;
    if (
      prices.inputDigest !== i.binding.inputDigest ||
      prices.readFrameDigest !== i.binding.readFrameDigest
    )
      return no('original_snapshot_or_range_pin_mismatch');
    const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
    return {
      status: 'produced',
      qualified: false,
      activationAllowed: false,
      reference: {
        version: 2,
        sourceId: i.sourceId,
        qualificationId: i.qualificationId,
        evidenceClass: i.evidenceClass,
        domain: copy(i.domain),
        samplingContractDigest: prices.samplingContractDigest,
        producerDigest: i.producerDigest,
        basis: 'counterfactual',
        method: 'exact_enumeration',
        causal: true,
        complete: true,
        informationSet: 'original_decision_only',
        utility: {
          unit: 'net_chip_bb',
          costsIncluded: true,
          contextDigest: i.utilityContextDigest,
        },
        binding: copy(i.binding),
        uncertainty: { familyWiseConfidence: 1, independentSamples: 1, simultaneous: true },
        alternatives: prices.alternatives,
      },
    };
  } catch {
    return no('original_information_unreadable');
  }
}
