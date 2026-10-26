import type { Card } from '../../types.js';
import type { FastHorseDecisionRequest } from '../../engine/horseDecision/protocol.js';
import { scoreHoldemReference } from '../../engine/HorseEval.js';
import {
  horseTournamentProvenanceMatchesSnapshot,
  HORSE_TOURNAMENT_CONTEXT_STALE_MS,
} from '../../engine/HorseTournamentContextProvenance.js';
import { validHorseTournamentPayoutTerms } from '../../engine/HorseTournamentPayoutTerms.js';
import { evidenceDigest } from './authority.js';

export interface ClosedHeadsUpTournamentRiverInput {
  version: 'horse-closed-hu-ladder-river-reference-v1';
  original: { snapshot: FastHorseDecisionRequest; readFrame: unknown };
  /** Explicit finite model range, never observed opponent hole cards. */
  range: Array<{ cards: Card[]; weight: number }>;
  rangeReadFrameDigest: string;
}
export interface PricedTournamentAction {
  /** Hero first, opponent second; tournament chips, not prize money. */
  stacks: [number, number];
  expectedPrizeShare: number;
}
export type ClosedHeadsUpTournamentRiverResult =
  | { status: 'unavailable'; reason: string }
  | {
      status: 'priced';
      objective: 'closed_hu_ladder_icm_prize_share_v1';
      utilityUnit: 'prize_share';
      qualified: false;
      activationAllowed: false;
      conditionalOnDeclaredRange: true;
      inputDigest: string;
      readFrameDigest: string;
      tournamentContextDigest: string;
      rangeDigest: string;
      rangeReadFrameDigest: string;
      prizePoolCents: number;
      /** Full original ladder, including previously paid places. Never normalized. */
      prizesCents: number[];
      fold: PricedTournamentAction;
      call: {
        expectedPrizeShare: number;
        outcomes: Array<
          PricedTournamentAction & {
            cards: Card[];
            weight: number;
            result: 'win' | 'loss' | 'tie';
          }
        >;
      };
    };

const whole = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const cardKey = (c: Card) => `${c.rank}:${c.suit}`;
const validCard = (c: Card) =>
  c &&
  typeof c.rank === 'string' &&
  c.rank.length === 1 &&
  '23456789TJQKA'.includes(c.rank) &&
  ['hearts', 'diamonds', 'clubs', 'spades'].includes(c.suit);

/** Validate every place explicitly. Its bound is the observed original field,
 * matching canonical capture's place-count <= final-field requirement. */
function completeCurve(value: unknown, field: number): value is number[] {
  if (!Array.isArray(value) || !value.length || value.length > field) return false;
  for (let i = 0; i < value.length; i++) {
    if (!Object.hasOwn(value, i) || !Number.isFinite(value[i]) || value[i] < 0) return false;
  }
  return value[0] > 0;
}

/** Unsigned, pure original-state reference for a closed HU NLH MTT/SNG field.
 * First settle each legal fold/call outcome in tournament chips. Then apply
 * the DECLARED two-player ICM finishing-order model: P(first)=heroChipShare,
 * P(second)=1-P(first). Previously paid places remain in the original pool
 * denominator; this is not a cash EV conversion or a realized prize receipt.
 * No sampler, RNG, network, keys, promotion, controller or hidden cards read.
 * The owner's independent model/holdout and .05 support qualification remain
 * separate from this conditional finite-range arithmetic. */
export function priceClosedHeadsUpTournamentLadderRiver(
  input: ClosedHeadsUpTournamentRiverInput
): ClosedHeadsUpTournamentRiverResult {
  const no = (reason: string): ClosedHeadsUpTournamentRiverResult => ({
    status: 'unavailable',
    reason,
  });
  try {
    if (input?.version !== 'horse-closed-hu-ladder-river-reference-v1') return no('input_version');
    const { snapshot } = input.original;
    const gs = snapshot.gameState,
      hero = snapshot.player,
      t = gs.tournament;
    if (
      snapshot.type !== 'DECIDE_FAST' ||
      gs.gameVariant !== 'nlh' ||
      !['mtt', 'sng', 'hu_sng'].includes(gs.format ?? '') ||
      gs.gameMode !== 'tournament' ||
      gs.stage !== 'river' ||
      gs.bettingStructure !== 'no_limit' ||
      gs.asset !== 'chips' ||
      gs.chipUnit !== 1 ||
      gs.ante !== 0 ||
      gs.heroSeat !== hero.seat ||
      gs.currentPlayerSeat !== hero.seat ||
      (gs.communityCards2?.length ?? 0) !== 0 ||
      (gs.communityCards3?.length ?? 0) !== 0
    )
      return no('unsupported_tournament_family');
    if (
      !t ||
      t.schemaVersion !== 1 ||
      t.contextStatus !== 'complete' ||
      t.contextIssues?.length !== 0 ||
      t.tournamentStatus !== 'RUNNING' ||
      t.gameVariant !== 'nlh' ||
      t.tournamentType !== (gs.format === 'mtt' ? 'MTT' : 'SNG') ||
      t.playersLeft !== 2 ||
      t.playersAtTable !== 2 ||
      !whole(t.entrants) ||
      t.entrants < 2 ||
      !whole(t.spotsPaid) ||
      t.spotsPaid < 1 ||
      t.spotsPaid > t.entrants ||
      !completeCurve(t.payoutPct, t.entrants) ||
      t.payoutPct.filter((p) => p > 0).length !== t.spotsPaid ||
      t.registrationOpen !== false ||
      t.lateRegistrationOpen !== false ||
      t.reentryOpen !== false ||
      t.rebuyOpen !== false ||
      t.addOnPeriodOpen !== false ||
      t.reentryAllowed !== false ||
      t.rebuyAllowed !== false ||
      t.addOnAvailable !== false ||
      t.isPko !== false ||
      t.isBounty !== false ||
      t.isMysteryBounty !== false ||
      t.satellite !== false ||
      t.bountyPoolCents !== 0 ||
      t.onBreak !== false
    )
      return no('incomplete_or_open_tournament_context');
    const provenance = t.contextProvenance;
    if (
      !provenance ||
      provenance.status !== 'complete' ||
      !provenance.source ||
      !horseTournamentProvenanceMatchesSnapshot(snapshot) ||
      !whole(snapshot.decisionTimeMs) ||
      provenance.readAtMs > snapshot.decisionTimeMs ||
      snapshot.decisionTimeMs - provenance.source.readCompletedAtMs >
        HORSE_TOURNAMENT_CONTEXT_STALE_MS ||
      provenance.source.readStartedAtMs > provenance.source.readCompletedAtMs ||
      provenance.source.readCompletedAtMs > snapshot.decisionTimeMs
    )
      return no('original_context_provenance');
    const ladder = t.finalizedPrizeLadder;
    if (
      !validHorseTournamentPayoutTerms(t) ||
      !ladder ||
      ladder.unitCents !== 1 ||
      ladder.poolCents !== t.prizePoolCents ||
      ladder.bubbleProtection !== false ||
      ladder.bubbleReserveCents !== 0 ||
      !completeCurve(ladder.prizesCents, t.entrants) ||
      ladder.prizesCents.filter((p) => p > 0).length !== t.spotsPaid
    )
      return no('finalized_original_prize_ladder_missing');
    if (
      !Array.isArray(gs.players) ||
      gs.players.length !== 2 ||
      new Set(gs.players.map((p) => p.user_id)).size !== 2 ||
      !Array.isArray(gs.dealtSeatIds) ||
      gs.dealtSeatIds.length !== 2 ||
      new Set(gs.dealtSeatIds).size !== 2 ||
      gs.players.some(
        (p) =>
          !gs.dealtSeatIds!.includes(p.seat) ||
          !Array.isArray(p.cards) ||
          p.cards.length !== 0 ||
          p.is_folded ||
          p.is_sitting_out ||
          !whole(p.stack) ||
          !whole(p.bet) ||
          !whole(p.totalInvested) ||
          p.bet > p.totalInvested ||
          (p.deadInvested ?? 0) !== 0 ||
          (p.individualAnteInvested ?? 0) !== 0
      )
    )
      return no('ambiguous_seats_or_contributions');
    const publicHero = gs.players.find((p) => p.user_id === hero.user_id);
    const opponent = gs.players.find((p) => p.user_id !== hero.user_id)!;
    if (
      !publicHero ||
      !['seat', 'stack', 'bet', 'totalInvested', 'is_folded', 'is_all_in', 'is_sitting_out'].every(
        (k) => publicHero[k as keyof typeof hero] === hero[k as keyof typeof hero]
      ) ||
      (hero.deadInvested ?? 0) !== 0 ||
      (hero.individualAnteInvested ?? 0) !== 0 ||
      !opponent.is_all_in ||
      opponent.stack !== 0 ||
      hero.is_all_in ||
      !whole(gs.toCall) ||
      gs.toCall <= 0 ||
      gs.toCall >= hero.stack ||
      !whole(gs.currentBet) ||
      gs.currentBet !== opponent.bet ||
      gs.currentBet - hero.bet !== gs.toCall ||
      hero.totalInvested + gs.toCall !== opponent.totalInvested ||
      gs.pot !== hero.totalInvested + opponent.totalInvested ||
      !Array.isArray(gs.legalActions) ||
      !gs.legalActions.includes('fold') ||
      !gs.legalActions.includes('call')
    )
      return no('unsupported_call_or_side_pot');
    const total = hero.stack + hero.totalInvested + opponent.totalInvested;
    if (
      !whole(total) ||
      total <= 0 ||
      !t.stackByUser ||
      Object.keys(t.stackByUser).length !== 2 ||
      t.stackByUser[hero.user_id] !== hero.stack + hero.totalInvested ||
      t.stackByUser[opponent.user_id] !== opponent.totalInvested ||
      t.stacks?.length !== 2 ||
      [...t.stacks].sort((a, b) => a - b).join(',') !==
        Object.values(t.stackByUser)
          .sort((a, b) => a - b)
          .join(',')
    )
      return no('field_stack_conservation');
    const known = [...hero.cards, ...gs.communityCards];
    if (
      hero.cards.length !== 2 ||
      gs.communityCards.length !== 5 ||
      !known.every(validCard) ||
      new Set(known.map(cardKey)).size !== 7 ||
      !Array.isArray(input.range) ||
      !input.range.length ||
      // The physical NLH universe contains C(52,2)=1326 combinations.
      input.range.length > 1326 ||
      input.rangeReadFrameDigest !== evidenceDigest(input.original.readFrame)
    )
      return no('range_binding');
    const seen = new Set<string>();
    for (const row of input.range) {
      if (
        !row ||
        row.cards?.length !== 2 ||
        !row.cards.every(validCard) ||
        !Number.isFinite(row.weight) ||
        row.weight <= 0 ||
        new Set([...known, ...row.cards].map(cardKey)).size !== 9
      )
        return no('invalid_declared_range');
      const combo = row.cards.map(cardKey).sort().join('|');
      if (seen.has(combo)) return no('duplicate_range_combination');
      seen.add(combo);
    }
    const weight = input.range.reduce((sum, row) => sum + row.weight, 0);
    if (!Number.isFinite(weight)) return no('range_weight_overflow');
    const first = ladder.prizesCents[0],
      second = ladder.prizesCents[1] ?? 0;
    const price = (stacks: [number, number]): number => {
      if (!stacks.every(whole) || stacks[0] + stacks[1] !== total)
        throw new Error('nonconserving_outcome');
      return (second + (first - second) * (stacks[0] / total)) / ladder.poolCents;
    };
    const foldStacks: [number, number] = [hero.stack, hero.totalInvested + opponent.totalInvested];
    const heroScore = scoreHoldemReference(known, 7, false),
      invested = opponent.totalInvested,
      behind = hero.stack - gs.toCall;
    const outcomes = input.range.map((row) => {
      const score = scoreHoldemReference([...row.cards, ...gs.communityCards], 7, false);
      const result: 'win' | 'loss' | 'tie' =
        heroScore > score ? 'win' : heroScore < score ? 'loss' : 'tie';
      const stacks: [number, number] =
        result === 'win'
          ? [behind + 2 * invested, 0]
          : result === 'loss'
            ? [behind, 2 * invested]
            : [behind + invested, invested];
      return {
        cards: row.cards.map((c) => ({ ...c })),
        weight: row.weight,
        result,
        stacks,
        expectedPrizeShare: price(stacks),
      };
    });
    return {
      status: 'priced',
      objective: 'closed_hu_ladder_icm_prize_share_v1',
      utilityUnit: 'prize_share',
      qualified: false,
      activationAllowed: false,
      conditionalOnDeclaredRange: true,
      inputDigest: evidenceDigest(snapshot),
      readFrameDigest: evidenceDigest(input.original.readFrame),
      tournamentContextDigest: evidenceDigest(t),
      rangeDigest: evidenceDigest(input.range),
      rangeReadFrameDigest: input.rangeReadFrameDigest,
      prizePoolCents: ladder.poolCents,
      prizesCents: [...ladder.prizesCents],
      fold: { stacks: foldStacks, expectedPrizeShare: price(foldStacks) },
      call: {
        outcomes,
        expectedPrizeShare: outcomes.reduce(
          (sum, row) => sum + row.expectedPrizeShare * (row.weight / weight),
          0
        ),
      },
    };
  } catch {
    return no('malformed_original_input');
  }
}
