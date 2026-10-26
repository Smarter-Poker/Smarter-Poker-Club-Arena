/** Independent conditional terminal chip settlement for the closed HU objectives.
 * This PURE function authenticates no source, JSON, key or callback. The
 * configured accepted-source reader must authenticate both inputs first. */
import type { Card } from '../../types.js';
import type { FastHorseDecisionRequest } from '../../engine/horseDecision/protocol.js';
import { settleJointBoardReference } from '../../benchmark/JointBoardReference.js';
import { validHorseTournamentPayoutTerms } from '../../engine/HorseTournamentPayoutTerms.js';
import {
  horseTournamentProvenanceMatchesSnapshot,
  HORSE_TOURNAMENT_CONTEXT_STALE_MS,
} from '../../engine/HorseTournamentContextProvenance.js';
import { evidenceDigest } from './authority.js';
import {
  TOURNAMENT_KERNEL_OBJECTIVE,
  CLOSED_HU_TOURNAMENT_KERNEL_OBJECTIVE,
  type TournamentKernelObjective,
} from './kernelTournamentDefinition.js';
export interface TournamentAcceptedUtilityInput {
  original: { snapshot: FastHorseDecisionRequest; readFrame: unknown };
  opponentCards: readonly Card[];
}
const flags = {
  qualified: false as const,
  activationAllowed: false as const,
  sourceAuthenticated: false as const,
};
export type TournamentAcceptedUtilityResult = typeof flags &
  (
    | { status: 'unavailable'; reason: string }
    | {
        status: 'priced';
        objective: TournamentKernelObjective;
        utilityUnit: 'prize_share';
        inputDigest: string;
        readFrameDigest: string;
        tournamentContextDigest: string;
        prizePoolCents: number;
        fold: { stacks: [number, number]; expectedPrizeShare: number };
        call: { stacks: [number, number]; expectedPrizeShare: number };
      }
  );
const whole = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
/** No cash fees or prize awards: this declared tournament family settles its
 * river pot in whole chips, then models each resulting field against the full original prize ladder. */
export function independentlyPriceAcceptedTournamentRiver(
  input: TournamentAcceptedUtilityInput
): TournamentAcceptedUtilityResult {
  const no = (reason: string): TournamentAcceptedUtilityResult => ({
    ...flags,
    status: 'unavailable',
    reason,
  });
  try {
    const s = input.original.snapshot,
      g = s.gameState,
      h = s.player,
      t = g.tournament;
    if (
      s.type !== 'DECIDE_FAST' ||
      g.gameVariant !== 'nlh' ||
      !['spin', 'mtt', 'sng', 'hu_sng'].includes(g.format as string) ||
      g.gameMode !== 'tournament' ||
      g.stage !== 'river' ||
      g.bettingStructure !== 'no_limit' ||
      g.asset !== 'chips' ||
      g.chipUnit !== 1 ||
      g.ante !== 0 ||
      g.boardCount !== 1 ||
      g.heroSeat !== h.seat ||
      g.currentPlayerSeat !== h.seat ||
      (g.communityCards2?.length ?? 0) !== 0 ||
      (g.communityCards3?.length ?? 0) !== 0
    )
      return no('unsupported_tournament_utility_family');
    if (
      !t ||
      t.schemaVersion !== 1 ||
      t.contextStatus !== 'complete' ||
      t.contextIssues?.length !== 0 ||
      t.tournamentStatus !== 'RUNNING' ||
      t.gameVariant !== 'nlh' ||
      t.tournamentType !== (g.format === 'spin' ? 'SPIN' : g.format === 'mtt' ? 'MTT' : 'SNG') ||
      t.playersLeft !== 2 ||
      t.playersAtTable !== 2 ||
      !whole(t.entrants) ||
      t.entrants < 2 ||
      !whole(t.spotsPaid) ||
      t.spotsPaid < 1 ||
      t.spotsPaid > t.entrants ||
      !Array.isArray(t.payoutPct) ||
      t.payoutPct.length < 1 ||
      !(t.payoutPct[0] > 0) ||
      t.payoutPct.length > t.entrants ||
      Array.from({ length: t.payoutPct.length }, (_, i) => i).some(
        (i) => !Object.hasOwn(t.payoutPct as object, i)
      ) ||
      t.payoutPct.some((p) => !Number.isFinite(p) || p < 0 || p > 100) ||
      t.payoutPct.filter((p) => p > 0).length !== t.spotsPaid ||
      (g.format === 'spin' &&
        (t.spotsPaid !== 1 ||
          t.payoutPct[0] !== 100 ||
          t.payoutPct.slice(1).some((p) => p !== 0))) ||
      [
        t.registrationOpen,
        t.lateRegistrationOpen,
        t.reentryOpen,
        t.rebuyOpen,
        t.addOnPeriodOpen,
        t.reentryAllowed,
        t.rebuyAllowed,
        t.addOnAvailable,
        t.isPko,
        t.isBounty,
        t.isMysteryBounty,
        t.satellite,
        t.onBreak,
      ].some((v) => v !== false) ||
      t.bountyPoolCents !== 0
    )
      return no('unknown_or_open_tournament_utility_context');
    const p = t.contextProvenance,
      l = t.finalizedPrizeLadder;
    if (
      !p ||
      p.status !== 'complete' ||
      !p.source ||
      !whole(s.decisionTimeMs) ||
      !horseTournamentProvenanceMatchesSnapshot(s) ||
      p.readAtMs > s.decisionTimeMs ||
      p.source.readStartedAtMs > p.source.readCompletedAtMs ||
      p.source.readCompletedAtMs > s.decisionTimeMs ||
      s.decisionTimeMs - p.source.readCompletedAtMs > HORSE_TOURNAMENT_CONTEXT_STALE_MS
    )
      return no('original_tournament_utility_provenance');
    if (
      !validHorseTournamentPayoutTerms(t) ||
      t.payoutTermsVersion !== 1 ||
      t.prizePoolFinalized !== true ||
      t.bubbleProtection !== false ||
      t.prizeUnitCents !== 1 ||
      !l ||
      l.version !== 'horse-finalized-prize-ladder-v1' ||
      l.finalized !== true ||
      l.tournamentId !== t.tournamentId ||
      l.unitCents !== 1 ||
      !whole(l.poolCents) ||
      l.poolCents <= 0 ||
      l.poolCents !== t.prizePoolCents ||
      l.source !== 'tournaments+clubs/canonical-payout-v1' ||
      l.bubbleProtection !== false ||
      l.bubbleReserveCents !== 0 ||
      l.prizesCents.length < 1 ||
      !(l.prizesCents[0] > 0) ||
      l.prizesCents.length > t.entrants ||
      Array.from({ length: l.prizesCents.length }, (_, i) => i).some(
        (i) => !Object.hasOwn(l.prizesCents, i)
      ) ||
      l.prizesCents.filter((p) => p > 0).length !== t.spotsPaid ||
      (g.format === 'spin' &&
        (l.prizesCents[0] !== l.poolCents || l.prizesCents.slice(1).some((p) => p !== 0)))
    )
      return no('original_finalized_wta_utility_terms_missing');
    if (
      !Array.isArray(g.players) ||
      g.players.length !== 2 ||
      new Set(g.players.map((player) => player.user_id)).size !== 2 ||
      new Set(g.players.map((player) => player.seat)).size !== 2 ||
      !Array.isArray(g.dealtSeatIds) ||
      g.dealtSeatIds.length !== 2 ||
      new Set(g.dealtSeatIds).size !== 2 ||
      g.players.some(
        (player) =>
          !g.dealtSeatIds!.includes(player.seat) ||
          player.cards.length !== 0 ||
          player.is_folded ||
          player.is_sitting_out ||
          !whole(player.stack) ||
          !whole(player.bet) ||
          !whole(player.totalInvested) ||
          player.bet > player.totalInvested ||
          (player.deadInvested ?? 0) !== 0 ||
          (player.individualAnteInvested ?? 0) !== 0
      )
    )
      return no('ambiguous_tournament_utility_seats');
    const publicHero = g.players.find((player) => player.user_id === h.user_id),
      opponent = g.players.find((player) => player.user_id !== h.user_id)!;
    if (
      !publicHero ||
      !['seat', 'stack', 'bet', 'totalInvested', 'is_folded', 'is_all_in', 'is_sitting_out'].every(
        (k) => publicHero[k as keyof typeof h] === h[k as keyof typeof h]
      ) ||
      h.is_folded ||
      h.is_all_in ||
      h.is_sitting_out ||
      (h.deadInvested ?? 0) !== 0 ||
      (h.individualAnteInvested ?? 0) !== 0 ||
      !opponent.is_all_in ||
      opponent.stack !== 0 ||
      !whole(g.toCall) ||
      g.toCall <= 0 ||
      g.toCall >= h.stack ||
      !whole(g.currentBet) ||
      g.currentBet !== opponent.bet ||
      g.currentBet - h.bet !== g.toCall ||
      h.totalInvested + g.toCall !== opponent.totalInvested ||
      g.pot !== h.totalInvested + opponent.totalInvested ||
      !g.legalActions?.includes('fold') ||
      !g.legalActions.includes('call')
    )
      return no('unsupported_tournament_utility_call_or_pot');
    const total = h.stack + h.totalInvested + opponent.totalInvested;
    if (
      !whole(total) ||
      total <= 0 ||
      !t.stackByUser ||
      Object.keys(t.stackByUser).length !== 2 ||
      t.stackByUser[h.user_id] !== h.stack + h.totalInvested ||
      t.stackByUser[opponent.user_id] !== opponent.totalInvested ||
      t.stacks?.length !== 2 ||
      [...t.stacks].sort((a, b) => a - b).join(',') !==
        Object.values(t.stackByUser)
          .sort((a, b) => a - b)
          .join(',')
    )
      return no('original_funded_field_stack_mismatch');
    if (
      h.cards.length !== 2 ||
      g.communityCards.length !== 5 ||
      !Array.isArray(input.opponentCards) ||
      input.opponentCards.length !== 2
    )
      return no('tournament_utility_holdings_missing');
    const outcome = (call: boolean) => {
      const settled = settleJointBoardReference({
        variant: 'nlh',
        players: g.players.map((player) => ({
          id: player.user_id,
          seat: player.seat,
          cards: player.user_id === h.user_id ? h.cards : [...input.opponentCards],
          contributed:
            player.totalInvested + (call && player.user_id === h.user_id ? g.toCall! : 0),
          folded: !call && player.user_id === h.user_id,
        })),
        boards: [g.communityCards],
        chipUnit: 1,
        dealerSeat: g.dealerSeat!,
      });
      const stacks: [number, number] = [
        h.stack -
          (call ? g.toCall! : 0) +
          (settled.totals[h.user_id] ?? 0) +
          (settled.refunds[h.user_id] ?? 0),
        opponent.stack +
          (settled.totals[opponent.user_id] ?? 0) +
          (settled.refunds[opponent.user_id] ?? 0),
      ];
      if (
        !stacks.every(whole) ||
        stacks[0] + stacks[1] !== total ||
        settled.distributed !== settled.contributed
      )
        throw Error('independent_utility_conservation');
      return {
        stacks,
        expectedPrizeShare:
          ((l.prizesCents[1] ?? 0) +
            ((l.prizesCents[0] - (l.prizesCents[1] ?? 0)) * stacks[0]) / total) /
          l.poolCents,
      };
    };
    const fold = outcome(false),
      call = outcome(true);
    return {
      ...flags,
      status: 'priced',
      objective:
        g.format === 'spin' ? TOURNAMENT_KERNEL_OBJECTIVE : CLOSED_HU_TOURNAMENT_KERNEL_OBJECTIVE,
      utilityUnit: 'prize_share',
      inputDigest: evidenceDigest(s),
      readFrameDigest: evidenceDigest(input.original.readFrame),
      tournamentContextDigest: evidenceDigest(t),
      prizePoolCents: l.poolCents,
      fold,
      call,
    };
  } catch {
    return no('independent_tournament_utility_unavailable');
  }
}
