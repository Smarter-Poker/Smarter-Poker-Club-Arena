/** Necessary original-state geometry only. Eligible is not a model result,
 * complete population proof, source authentication or execution authority. */
import { isKnownVariant } from '../../engine/VariantRules.js';
import { CORRECTIVE_FORMATS, correctiveDecisionDomain } from './domain.js';
import { validHorseTournamentPayoutTerms } from '../../engine/HorseTournamentPayoutTerms.js';
import {
  horseTournamentProvenanceIsValid,
  horseTournamentProvenanceMatchesSnapshot,
  HORSE_TOURNAMENT_CONTEXT_STALE_MS,
} from '../../engine/HorseTournamentContextProvenance.js';

export type KernelTournamentEligibility =
  | { readonly status: 'eligible' }
  | { readonly status: 'excluded'; readonly reason: string }
  | { readonly status: 'gap'; readonly reason: string };
const object = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x);
const whole = (x: unknown): x is number =>
  typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
const finitePositive = (x: unknown): x is number =>
  typeof x === 'number' && Number.isFinite(x) && x > 0;
const text = (x: unknown): x is string => typeof x === 'string' && x.length > 0;
const CLOSED_FLAGS = [
  'registrationOpen',
  'lateRegistrationOpen',
  'reentryOpen',
  'rebuyOpen',
  'addOnPeriodOpen',
  'reentryAllowed',
  'rebuyAllowed',
  'addOnAvailable',
  'isPko',
  'isBounty',
  'isMysteryBounty',
  'satellite',
  'onBreak',
] as const;

export function classifyTournamentRiverSnapshot(snapshot: unknown): KernelTournamentEligibility {
  const gap = (reason: string): KernelTournamentEligibility => ({
    status: 'gap',
    reason,
  });
  const excluded = (reason: string): KernelTournamentEligibility => ({
    status: 'excluded',
    reason,
  });
  try {
    if (!object(snapshot) || !object(snapshot.gameState) || !object(snapshot.player))
      return gap('original_snapshot_missing');
    const gs = snapshot.gameState,
      hero = snapshot.player;
    if (
      typeof gs.gameVariant !== 'string' ||
      !isKnownVariant(gs.gameVariant) ||
      !CORRECTIVE_FORMATS.includes(gs.format as (typeof CORRECTIVE_FORMATS)[number]) ||
      !correctiveDecisionDomain(gs)
    )
      return gap('domain_metadata_invalid');
    if (
      gs.gameVariant !== 'nlh' ||
      !['spin', 'mtt', 'sng', 'hu_sng'].includes(String(gs.format)) ||
      gs.gameMode !== 'tournament'
    )
      return excluded('outside_tournament_domain');
    if (!['preflop', 'flop', 'turn', 'river', 'showdown', 'complete'].includes(String(gs.stage)))
      return gap('street_metadata_invalid');
    if (gs.stage !== 'river') return excluded('outside_river');
    if (!['no_limit', 'pot_limit', 'fixed_limit'].includes(String(gs.bettingStructure)))
      return gap('betting_metadata_invalid');
    if (gs.bettingStructure !== 'no_limit') return excluded('outside_no_limit');
    if (!['chips', 'diamonds'].includes(String(gs.asset)) || !finitePositive(gs.chipUnit))
      return gap('chip_unit_missing_or_invalid');
    if (gs.asset !== 'chips' || gs.chipUnit !== 1) return excluded('outside_whole_chip_domain');
    if (!whole(gs.ante)) return gap('ante_metadata_missing_or_invalid');
    if (gs.ante !== 0) return excluded('ante_geometry');
    if (!whole(gs.boardCount) || gs.boardCount < 1 || !Array.isArray(gs.communityCards))
      return gap('board_metadata_missing_or_invalid');
    if (
      gs.boardCount !== 1 ||
      [gs.communityCards2, gs.communityCards3].some((b) => Array.isArray(b) && b.length)
    )
      return excluded('multiple_boards');
    if (
      gs.communityCards.length !== 5 ||
      [gs.communityCards2, gs.communityCards3].some((b) => b !== undefined && !Array.isArray(b))
    )
      return gap('board_metadata_missing_or_invalid');
    const t = gs.tournament;
    if (
      !object(t) ||
      t.schemaVersion !== 1 ||
      t.contextStatus !== 'complete' ||
      !Array.isArray(t.contextIssues) ||
      t.contextIssues.length
    )
      return gap('tournament_context_incomplete');
    if (
      !text(t.tournamentId) ||
      !text(t.tournamentStatus) ||
      !text(t.tournamentType) ||
      !text(t.gameVariant)
    )
      return gap('tournament_identity_missing');
    if (
      !['RUNNING', 'REGISTERING', 'PAUSED', 'COMPLETED', 'CANCELLED', 'SCHEDULED'].includes(
        t.tournamentStatus
      )
    )
      return gap('tournament_status_invalid');
    if (t.tournamentStatus !== 'RUNNING') return excluded('tournament_not_running');
    if (t.gameVariant !== gs.gameVariant) return gap('tournament_variant_mismatch');
    if (t.tournamentType !== (gs.format === 'spin' ? 'SPIN' : gs.format === 'mtt' ? 'MTT' : 'SNG'))
      return gap('tournament_type_mismatch');
    if (CLOSED_FLAGS.some((key) => typeof t[key] !== 'boolean'))
      return gap('lifecycle_flag_missing_or_invalid');
    if (CLOSED_FLAGS.some((key) => t[key] === true)) return excluded('open_or_special_lifecycle');
    if (
      !whole(t.playersLeft) ||
      !whole(t.playersAtTable) ||
      t.playersLeft < 1 ||
      t.playersAtTable < 1 ||
      !whole(t.entrants) ||
      t.entrants < t.playersLeft ||
      !whole(t.spotsPaid) ||
      t.spotsPaid > t.entrants ||
      t.spotsPaid < 1 ||
      !whole(t.bountyPoolCents)
    )
      return gap('field_metadata_missing_or_invalid');
    if (t.playersLeft !== 2 || t.playersAtTable !== 2) return excluded('outside_heads_up_field');
    if (t.bountyPoolCents !== 0) return excluded('bounty_pool');
    if (
      !Array.isArray(t.payoutPct) ||
      t.payoutPct.length < 1 ||
      !(t.payoutPct[0] > 0) ||
      t.payoutPct.length > t.entrants ||
      Array.from({ length: t.payoutPct.length }, (_, i) => i).some(
        (i) => !Object.hasOwn(t.payoutPct as object, i)
      ) ||
      t.payoutPct.filter((p: unknown) => typeof p === 'number' && p > 0).length !== t.spotsPaid ||
      t.payoutPct.some((p) => typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 100)
    )
      return gap('payout_shape_missing_or_invalid');
    if (
      gs.format === 'spin' &&
      (t.spotsPaid !== 1 ||
        t.payoutPct[0] !== 100 ||
        t.payoutPct.slice(1).some((p: unknown) => p !== 0))
    )
      return excluded('outside_winner_take_all');
    if (
      t.payoutTermsVersion !== 1 ||
      typeof t.prizePoolFinalized !== 'boolean' ||
      typeof t.bubbleProtection !== 'boolean' ||
      ![1, 100].includes(t.prizeUnitCents as number) ||
      !validHorseTournamentPayoutTerms(t as Parameters<typeof validHorseTournamentPayoutTerms>[0])
    )
      return gap('payout_terms_missing_or_invalid');
    if (!t.prizePoolFinalized) return excluded('prize_pool_not_finalized');
    if (t.bubbleProtection) return excluded('bubble_protection');
    if (t.prizeUnitCents !== 1) return excluded('outside_cent_prize_unit');
    const ladder = t.finalizedPrizeLadder;
    if (
      !object(ladder) ||
      !whole(t.prizePoolCents) ||
      t.prizePoolCents <= 0 ||
      ladder.poolCents !== t.prizePoolCents ||
      !Array.isArray(ladder.prizesCents) ||
      ladder.prizesCents.length < 1 ||
      !(ladder.prizesCents[0] > 0) ||
      ladder.prizesCents.length > t.entrants ||
      Array.from({ length: ladder.prizesCents.length }, (_, i) => i).some(
        (i) => !Object.hasOwn(ladder.prizesCents as object, i)
      ) ||
      ladder.prizesCents.filter((p: unknown) => typeof p === 'number' && p > 0).length !==
        t.spotsPaid ||
      (gs.format === 'spin' &&
        (ladder.prizesCents[0] !== ladder.poolCents ||
          ladder.prizesCents.slice(1).some((p: unknown) => p !== 0))) ||
      ladder.bubbleReserveCents !== 0
    )
      return gap('finalized_pool_binding_missing_or_invalid');
    const provenance = t.contextProvenance;
    if (
      !horseTournamentProvenanceIsValid(provenance) ||
      provenance.status !== 'complete' ||
      !provenance.source ||
      !whole(snapshot.decisionTimeMs) ||
      !horseTournamentProvenanceMatchesSnapshot(
        snapshot as unknown as Parameters<typeof horseTournamentProvenanceMatchesSnapshot>[0]
      ) ||
      provenance.readAtMs > snapshot.decisionTimeMs ||
      provenance.source.readStartedAtMs > provenance.source.readCompletedAtMs ||
      provenance.source.readCompletedAtMs > snapshot.decisionTimeMs ||
      snapshot.decisionTimeMs - provenance.source.readCompletedAtMs >
        HORSE_TOURNAMENT_CONTEXT_STALE_MS
    )
      return gap('original_provenance_missing_or_mismatched');
    if (!Array.isArray(gs.players) || !Array.isArray(gs.dealtSeatIds))
      return gap('seat_census_missing');
    if (gs.players.length !== 2 || gs.dealtSeatIds.length !== 2)
      return excluded('outside_two_dealt_seats');
    if (
      gs.players.some((p) => !object(p)) ||
      new Set(gs.dealtSeatIds).size !== 2 ||
      gs.dealtSeatIds.some((s) => !whole(s) || s < 1 || s > 10)
    )
      return gap('seat_census_invalid');
    const players = gs.players as Record<string, unknown>[],
      dealtSeatIds = gs.dealtSeatIds;
    if (
      players.some((p) => !text(p.user_id) || !whole(p.seat) || !dealtSeatIds.includes(p.seat)) ||
      new Set(players.map((p) => p.user_id)).size !== 2 ||
      new Set(players.map((p) => p.seat)).size !== 2
    )
      return gap('seat_census_invalid');
    if (
      players.some(
        (p) =>
          !['is_folded', 'is_all_in', 'is_sitting_out'].every((k) => typeof p[k] === 'boolean') ||
          ![
            p.stack,
            p.bet,
            p.totalInvested,
            p.deadInvested ?? 0,
            p.individualAnteInvested ?? 0,
          ].every(whole) ||
          (p.bet as number) > (p.totalInvested as number)
      )
    )
      return gap('original_stack_or_contribution_missing');
    if (
      players.some(
        (p) =>
          p.is_folded ||
          p.is_sitting_out ||
          (p.deadInvested ?? 0) !== 0 ||
          (p.individualAnteInvested ?? 0) !== 0
      )
    )
      return excluded('folded_or_ante_geometry');
    if (players.some((p) => !Array.isArray(p.cards) || p.cards.length !== 0))
      return gap('public_holdings_not_causal');
    const publicHero = players.find((p) => p.user_id === hero.user_id),
      opponent = players.find((p) => p.user_id !== hero.user_id);
    if (
      !publicHero ||
      !opponent ||
      !['seat', 'stack', 'bet', 'totalInvested', 'is_folded', 'is_all_in', 'is_sitting_out'].every(
        (k) => publicHero[k] === hero[k]
      ) ||
      gs.heroSeat !== hero.seat ||
      gs.currentPlayerSeat !== hero.seat ||
      !Array.isArray(hero.cards) ||
      hero.cards.length !== 2 ||
      ![hero.deadInvested ?? 0, hero.individualAnteInvested ?? 0].every(whole)
    )
      return gap('actor_original_state_mismatch');
    if (
      (hero.deadInvested ?? 0) !== 0 ||
      (hero.individualAnteInvested ?? 0) !== 0 ||
      hero.is_all_in
    )
      return excluded('hero_all_in_or_ante');
    if (opponent.is_all_in && opponent.stack !== 0) return gap('opponent_stack_flag_mismatch');
    if (!opponent.is_all_in || opponent.stack !== 0) return excluded('opponent_not_all_in');
    if (!whole(gs.toCall) || !whole(gs.currentBet) || !whole(gs.pot))
      return gap('wager_metadata_missing_or_invalid');
    if (gs.toCall === 0 || gs.toCall >= (hero.stack as number))
      return excluded('call_requires_all_in_or_no_call');
    if (
      gs.currentBet !== opponent.bet ||
      gs.currentBet - (hero.bet as number) !== gs.toCall ||
      (hero.totalInvested as number) + gs.toCall !== opponent.totalInvested ||
      gs.pot !== (hero.totalInvested as number) + (opponent.totalInvested as number)
    )
      return gap('funded_contribution_mismatch');
    if (
      !Array.isArray(gs.legalActions) ||
      !gs.legalActions.length ||
      gs.legalActions.some((a) => !['fold', 'check', 'call', 'bet', 'raise', 'all_in'].includes(a))
    )
      return gap('legal_menu_missing_or_invalid');
    if (!gs.legalActions.includes('fold') || !gs.legalActions.includes('call'))
      return excluded('outside_fold_call_menu');
    const fundedTotal = players.reduce(
      (sum, p) => sum + (p.stack as number) + (p.totalInvested as number),
      0
    );
    if (!whole(fundedTotal) || fundedTotal === 0) return gap('original_field_stack_conservation');
    const stackByUser = t.stackByUser,
      stacks = t.stacks;
    if (
      !object(stackByUser) ||
      Object.keys(stackByUser).length !== 2 ||
      !Array.isArray(stacks) ||
      stacks.length !== 2
    )
      return gap('original_field_stack_conservation');
    const fieldStacks = Object.values(stackByUser);
    if (
      !fieldStacks.every(whole) ||
      !stacks.every(whole) ||
      players.some(
        (p) =>
          stackByUser[p.user_id as string] !== (p.stack as number) + (p.totalInvested as number)
      ) ||
      [...stacks].sort((a, b) => a - b).join(',') !== fieldStacks.sort((a, b) => a - b).join(',')
    )
      return gap('original_field_stack_conservation');
    return { status: 'eligible' };
  } catch {
    return gap('original_metadata_unreadable');
  }
}
