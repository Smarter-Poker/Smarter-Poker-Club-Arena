import type { Card } from '../../types.js';
import type { FastHorseDecisionRequest } from '../../engine/horseDecision/protocol.js';
import { scoreHoldemReference } from '../../engine/HorseEval.js';
import {
  horseTournamentProvenanceMatchesSnapshot,
  HORSE_TOURNAMENT_CONTEXT_STALE_MS,
} from '../../engine/HorseTournamentContextProvenance.js';
import { evidenceDigest, sha256 } from './authority.js';
import {
  validHorseTournamentPayoutTerms,
  type HorseFinalizedPrizeLadder,
} from '../../engine/HorseTournamentPayoutTerms.js';

/** Original capture contract. An unsigned caller-supplied ladder is not an
 * admission credential: independent source custody and qualification remain
 * mandatory before this conditional arithmetic can become a live policy. */
export type FinalizedTournamentPrizeLadder = HorseFinalizedPrizeLadder;
export interface TournamentRiverReferenceInput {
  version: 'horse-wta-spin-river-reference-v1';
  original: { snapshot: FastHorseDecisionRequest; readFrame: unknown };
  range: Array<{ cards: Card[]; weight: number }>;
  rangeReadFrameDigest: string;
}
export type TournamentRiverReferenceResult =
  | { status: 'unavailable'; reason: string }
  | {
      status: 'priced';
      qualified: false;
      activationAllowed: false;
      inputDigest: string;
      readFrameDigest: string;
      tournamentContextDigest: string;
      rangeDigest: string;
      rangeReadFrameDigest: string;
      objective: 'wta_hu_icm_chip_share_v1';
      utilityUnit: 'prize_share';
      /** Original funded-pool fact; modeled utility is never a realized award. */
      prizePoolCents: number;
      /** Enumeration error is zero for this declared range; model error is unknown. */
      conditionalOnDeclaredRange: true;
      fold: { stacks: [number, number]; expectedPrizeShare: number };
      call: {
        expectedPrizeShare: number;
        outcomes: Array<{
          cards: Card[];
          weight: number;
          result: 'win' | 'loss' | 'tie';
          stacks: [number, number];
          expectedPrizeShare: number;
        }>;
      };
    };

const whole = (x: unknown): x is number =>
  typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
const key = (c: Card) => `${c.rank}:${c.suit}`;
const validCard = (c: Card) =>
  c &&
  '23456789TJQKA'.includes(c.rank) &&
  c.rank.length === 1 &&
  ['hearts', 'diamonds', 'clubs', 'spades'].includes(c.suit);

/** Pure bounded HU WTA tournament outcome oracle, deliberately separate from
 * cash EV. Each action first settles chips, then applies the declared WTA HU
 * ICM chip-share objective to the resulting field. A nonterminal chip share
 * is modeled tournament utility, never an authenticated final prize award.
 * No RNG, outcome history, hidden opponent cards, signing or activation. */
export function priceClosedHeadsUpTournamentRiver(
  input: TournamentRiverReferenceInput
): TournamentRiverReferenceResult {
  const no = (reason: string): TournamentRiverReferenceResult => ({
    status: 'unavailable',
    reason,
  });
  try {
    if (input?.version !== 'horse-wta-spin-river-reference-v1') return no('input_version');
    const { snapshot } = input.original;
    const gs = snapshot.gameState,
      hero = snapshot.player,
      t = gs.tournament;
    if (
      snapshot.type !== 'DECIDE_FAST' ||
      gs.gameVariant !== 'nlh' ||
      gs.format !== 'spin' ||
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
      t.tournamentType !== 'SPIN' ||
      t.playersLeft !== 2 ||
      t.playersAtTable !== 2 ||
      t.spotsPaid !== 1 ||
      t.payoutPct?.length !== 1 ||
      t.payoutPct[0] !== 100 ||
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
      provenance.readAtMs > snapshot.decisionTimeMs ||
      snapshot.decisionTimeMs - provenance.source.readCompletedAtMs >
        HORSE_TOURNAMENT_CONTEXT_STALE_MS ||
      provenance.source.readStartedAtMs > provenance.source.readCompletedAtMs ||
      provenance.source.readCompletedAtMs > snapshot.decisionTimeMs
    )
      return no('original_context_provenance');
    const ladder = (t as typeof t & { finalizedPrizeLadder?: FinalizedTournamentPrizeLadder })
      .finalizedPrizeLadder;
    if (
      !validHorseTournamentPayoutTerms(t) ||
      !ladder ||
      ladder.version !== 'horse-finalized-prize-ladder-v1' ||
      ladder.finalized !== true ||
      ladder.tournamentId !== t.tournamentId ||
      ladder.unitCents !== 1 ||
      !whole(ladder.poolCents) ||
      ladder.poolCents <= 0 ||
      ladder.poolCents !== t.prizePoolCents ||
      ladder.prizesCents?.length !== 1 ||
      ladder.prizesCents[0] !== ladder.poolCents ||
      ladder.source !== 'tournaments+clubs/canonical-payout-v1' ||
      ladder.bubbleProtection !== false ||
      ladder.bubbleReserveCents !== 0 ||
      !sha256(ladder.sourceDigest)
    )
      return no('finalized_original_prize_ladder_missing');
    if (
      !Array.isArray(gs.players) ||
      gs.players.length !== 2 ||
      new Set(gs.players.map((p) => p.user_id)).size !== 2 ||
      !Array.isArray(gs.dealtSeatIds) ||
      gs.dealtSeatIds.length !== 2 ||
      new Set(gs.dealtSeatIds).size !== 2 ||
      gs.players.some((p) => !gs.dealtSeatIds!.includes(p.seat)) ||
      gs.players.some(
        (p) =>
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
      new Set(known.map(key)).size !== 7 ||
      !Array.isArray(input.range) ||
      input.range.length < 1 ||
      input.range.length > 1326 ||
      input.rangeReadFrameDigest !== evidenceDigest(input.original.readFrame)
    )
      return no('range_binding');
    const seen = new Set<string>();
    for (const r of input.range) {
      if (
        !r ||
        r.cards?.length !== 2 ||
        !r.cards.every(validCard) ||
        !Number.isFinite(r.weight) ||
        r.weight <= 0 ||
        new Set([...known, ...r.cards].map(key)).size !== 9
      )
        return no('invalid_declared_range');
      const combo = r.cards.map(key).sort().join('|');
      if (seen.has(combo)) return no('duplicate_range_combination');
      seen.add(combo);
    }
    const weight = input.range.reduce((s, r) => s + r.weight, 0);
    if (!Number.isFinite(weight)) return no('range_weight_overflow');
    const price = (stacks: [number, number]) => {
      if (!stacks.every(whole) || stacks[0] + stacks[1] !== total)
        throw new Error('nonconserving_outcome');
      return stacks[0] / total;
    };
    const foldStacks: [number, number] = [hero.stack, hero.totalInvested + opponent.totalInvested];
    const heroScore = scoreHoldemReference(known, 7, false);
    const invested = opponent.totalInvested;
    const behind = hero.stack - gs.toCall;
    const outcomes = input.range.map((r) => {
      const score = scoreHoldemReference([...r.cards, ...gs.communityCards], 7, false);
      const result: 'win' | 'loss' | 'tie' =
        heroScore > score ? 'win' : heroScore < score ? 'loss' : 'tie';
      const stacks: [number, number] =
        result === 'win'
          ? [behind + 2 * invested, 0]
          : result === 'loss'
            ? [behind, 2 * invested]
            : [behind + invested, invested];
      return {
        cards: r.cards.map((c) => ({ ...c })),
        weight: r.weight,
        result,
        stacks,
        expectedPrizeShare: price(stacks),
      };
    });
    return {
      status: 'priced',
      qualified: false,
      activationAllowed: false,
      inputDigest: evidenceDigest(snapshot),
      readFrameDigest: evidenceDigest(input.original.readFrame),
      tournamentContextDigest: evidenceDigest(t),
      rangeDigest: evidenceDigest(input.range),
      rangeReadFrameDigest: input.rangeReadFrameDigest,
      objective: 'wta_hu_icm_chip_share_v1',
      utilityUnit: 'prize_share',
      prizePoolCents: ladder.poolCents,
      conditionalOnDeclaredRange: true,
      fold: { stacks: foldStacks, expectedPrizeShare: price(foldStacks) },
      call: {
        outcomes,
        expectedPrizeShare: outcomes.reduce(
          (s, o) => s + o.expectedPrizeShare * (o.weight / weight),
          0
        ),
      },
    };
  } catch {
    return no('malformed_original_input');
  }
}
