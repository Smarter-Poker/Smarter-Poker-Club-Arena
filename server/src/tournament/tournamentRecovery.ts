/**
 * Tournament cancellation and terminal recovery.
 *
 * This process owns no tournament money or terminal state. It may gather
 * read-only evidence, then asks exactly one database transaction for an
 * immutable receipt. A refusal or unknown transport outcome never opens a
 * fallback payer, standings writer, rake writer, or seat-cleanup path.
 */

import { supabase } from '../services/supabase.js';
import { reportError } from '../services/errorReporter.js';
import { raiseFinancialAlert } from '../services/financialAlerts.js';
import { isMaintenanceFrozen } from '../maintenance/freezeState.js';
import { resolvePayoutStructure } from './payoutStructure.js';
import { fieldIsStillLive } from './recoveryFieldGuard.js';
import { noHandWasEverDealt } from './recoveryRankEvidence.js';
import {
  requestSatelliteSettlementReceipt,
  SatelliteSettlementRefusedError,
} from './satelliteSettlementRpc.js';
import {
  requestTournamentTerminalReceipt,
  TerminalSettlementRefusedError,
} from './terminalSettlementRpc.js';

const SYSTEM_ACTOR_ID = '2d1cd6c3-5700-4af9-a271-d4863fdab20d';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function object(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function uuid(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const number = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function money(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  const cents = Math.round(number * 100);
  return Number.isSafeInteger(cents) && Math.abs(number * 100 - cents) < 1e-7 ? cents / 100 : null;
}

function timestamptz(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function sameMoney(left: number, right: number): boolean {
  return Math.round(left * 100) === Math.round(right * 100);
}

export interface VerifiedTournamentCancellationReceipt {
  tournamentId: string;
  actorId: string;
  sourcePlayerCount: number;
  refundedCount: number;
  refundLineCount: number;
  ticketReturnCount: number;
  totalRefunded: number;
  totalTicketReturned: number;
  feesReversed: number;
  closedTableCount: number;
  sourceSeatCount: number;
  releasedSeatCount: number;
  settledAt: string;
}

/** Validate the internally complete JSON stored by atomic_cancel_tournament. */
export function verifyTournamentCancellationReceipt(
  raw: unknown,
  expectedTournamentId: string,
  expectedActorId: string
): VerifiedTournamentCancellationReceipt | null {
  const receipt = object(raw);
  const tournamentId = uuid(receipt.tournament_id);
  const actorId = uuid(receipt.actor_id);
  const sourcePlayerCount = nonNegativeInteger(receipt.source_player_count);
  const refundedCount = nonNegativeInteger(receipt.refunded_count);
  const refundLineCount = nonNegativeInteger(receipt.refund_line_count);
  const ticketReturnCount = nonNegativeInteger(receipt.ticket_return_count);
  const closedTableCount = nonNegativeInteger(receipt.closed_table_count);
  const sourceSeatCount = nonNegativeInteger(receipt.source_seat_count);
  const releasedSeatCount = nonNegativeInteger(receipt.released_seat_count);
  const totalRefunded = money(receipt.total_refunded);
  const totalTicketReturned = money(receipt.total_ticket_returned);
  const feesReversed = money(receipt.fees_reversed);
  const settledAt = timestamptz(receipt.settled_at);
  const refunds = Array.isArray(receipt.refunds) ? receipt.refunds : null;
  const ticketReturns = Array.isArray(receipt.ticket_returns) ? receipt.ticket_returns : null;

  if (
    receipt.ok !== true ||
    receipt.success !== true ||
    receipt.fully_settled !== true ||
    Number(receipt.receipt_version) !== 2 ||
    receipt.status !== 'CANCELLED' ||
    tournamentId !== expectedTournamentId ||
    actorId !== expectedActorId ||
    sourcePlayerCount === null ||
    refundedCount === null ||
    refundLineCount === null ||
    ticketReturnCount === null ||
    closedTableCount === null ||
    sourceSeatCount === null ||
    releasedSeatCount === null ||
    releasedSeatCount > sourceSeatCount ||
    totalRefunded === null ||
    totalTicketReturned === null ||
    feesReversed === null ||
    feesReversed > totalRefunded + totalTicketReturned ||
    settledAt === null ||
    refunds === null ||
    ticketReturns === null ||
    refunds.length !== refundLineCount ||
    ticketReturns.length !== ticketReturnCount
  ) {
    return null;
  }

  let refundCents = 0;
  let ticketCents = 0;
  const registrationIds = new Set<string>();
  const entitlementIds = new Set<string>();
  const ticketIds = new Set<string>();

  for (const candidate of refunds) {
    const line = object(candidate);
    const registrationId = uuid(line.registration_id);
    const userId = uuid(line.user_id);
    const entitlementId = uuid(line.entitlement_id);
    const sourceWalletClubId = uuid(line.source_wallet_club_id);
    const obligationId = uuid(line.obligation_id);
    const creditLedgerId = uuid(line.credit_ledger_id);
    const walletTransactionId = uuid(line.wallet_transaction_id);
    const grossPaid = money(line.gross_paid);
    const paidBefore = money(line.amount_paid_before);
    const paidNow = money(line.amount_paid_now);
    const refundPrize = money(line.refund_prize);
    const refundBounty = money(line.refund_bounty);
    const refundFee = money(line.refund_fee);
    const expectedKey =
      obligationId && paidBefore !== null
        ? `tourney:${expectedTournamentId}:obl:${obligationId}:${Math.round(paidBefore * 100)}`
        : null;
    if (
      registrationId === null ||
      userId === null ||
      entitlementId === null ||
      sourceWalletClubId === null ||
      obligationId === null ||
      creditLedgerId === null ||
      walletTransactionId === null ||
      line.entitlement_kind !== 'wallet_charge' ||
      grossPaid === null ||
      paidBefore === null ||
      paidNow === null ||
      paidNow <= 0 ||
      refundPrize === null ||
      refundBounty === null ||
      refundFee === null ||
      !sameMoney(grossPaid, paidNow) ||
      !sameMoney(paidNow, refundPrize + refundBounty + refundFee) ||
      line.idempotency_key !== expectedKey ||
      entitlementIds.has(entitlementId)
    ) {
      return null;
    }
    registrationIds.add(registrationId);
    entitlementIds.add(entitlementId);
    refundCents += Math.round(paidNow * 100);
    if (!Number.isSafeInteger(refundCents)) return null;
  }

  for (const candidate of ticketReturns) {
    const line = object(candidate);
    const registrationId = uuid(line.registration_id);
    const userId = uuid(line.user_id);
    const entitlementId = uuid(line.entitlement_id);
    const ticketId = uuid(line.ticket_id);
    const sourceWalletClubId = uuid(line.source_wallet_club_id);
    const sourceSatelliteId = uuid(line.source_satellite_id);
    const ledgerId = uuid(line.ledger_id);
    const transactionId = uuid(line.transaction_id);
    const value = money(line.value);
    const refundPrize = money(line.refund_prize);
    const refundBounty = money(line.refund_bounty);
    const refundFee = money(line.refund_fee);
    if (
      registrationId === null ||
      userId === null ||
      entitlementId === null ||
      ticketId === null ||
      sourceWalletClubId === null ||
      sourceSatelliteId === null ||
      ledgerId === null ||
      transactionId === null ||
      (line.entitlement_kind !== 'satellite_seat' &&
        line.entitlement_kind !== 'tournament_ticket') ||
      value === null ||
      value <= 0 ||
      refundPrize === null ||
      refundBounty === null ||
      refundFee === null ||
      !sameMoney(value, refundPrize + refundBounty + refundFee) ||
      entitlementIds.has(entitlementId) ||
      ticketIds.has(ticketId)
    ) {
      return null;
    }
    registrationIds.add(registrationId);
    entitlementIds.add(entitlementId);
    ticketIds.add(ticketId);
    ticketCents += Math.round(value * 100);
    if (!Number.isSafeInteger(ticketCents)) return null;
  }

  if (
    registrationIds.size !== refundedCount ||
    refundedCount > sourcePlayerCount ||
    refundCents !== Math.round(totalRefunded * 100) ||
    ticketCents !== Math.round(totalTicketReturned * 100)
  ) {
    return null;
  }

  return {
    tournamentId,
    actorId,
    sourcePlayerCount,
    refundedCount,
    refundLineCount,
    ticketReturnCount,
    totalRefunded,
    totalTicketReturned,
    feesReversed,
    closedTableCount,
    sourceSeatCount,
    releasedSeatCount,
    settledAt,
  };
}

/**
 * Cancellation is one database transaction: source-wallet refunds, satellite
 * ticket returns, fee reversals, escrow closure, roster/seat/table closure,
 * terminal status, and immutable receipt all commit or all roll back.
 */
export async function refundAndCloseCancelledTournament(
  tournamentId: string,
  tournamentName: string | null,
  refundReason: string,
  actorId = SYSTEM_ACTOR_ID
): Promise<void> {
  try {
    const { data: openRows, error: openRowsError } = await supabase
      .from('tournament_players')
      .select('id')
      .eq('tournament_id', tournamentId)
      .in('status', ['playing', 'registered']);
    if (openRowsError || !Array.isArray(openRows)) {
      reportError(
        new Error(
          `[GameServer] Cancel refund ABORTED for ${tournamentId.slice(0, 8)}: open-registration list unreadable (${openRowsError?.message ?? 'invalid result'}) - refunding nobody and closing nothing this pass`
        ),
        'GameServer.cancel_refund_open_rows_unreadable'
      );
      return;
    }

    const { data, error } = await supabase.rpc('atomic_cancel_tournament', {
      p_tournament_id: tournamentId,
      p_admin_id: actorId,
    });
    if (error) {
      reportError(
        new Error(
          `[GameServer] Atomic cancellation failed for ${tournamentId.slice(0, 8)} (${tournamentName ?? 'tournament'}; ${refundReason}): ${error.message}`
        ),
        'GameServer.cancel_refund_atomic_failed'
      );
      return;
    }

    const receipt = verifyTournamentCancellationReceipt(data, tournamentId, actorId);
    if (!receipt || receipt.sourcePlayerCount < openRows.length) {
      reportError(
        new Error(
          `[GameServer] Atomic cancellation returned an incomplete receipt for ${tournamentId.slice(0, 8)}`
        ),
        'GameServer.cancel_refund_receipt_invalid'
      );
      return;
    }

    console.log(
      `[GameServer] Cancelled ${tournamentId.slice(0, 8)} atomically: ${receipt.totalRefunded} chips, ${receipt.ticketReturnCount} ticket return(s), ${receipt.closedTableCount} table(s)`
    );
  } catch (error) {
    reportError(error, 'GameServer.refundAndCloseCancelledTournament');
  }
}

interface RecoveryTournament {
  id: string;
  name: string | null;
  status: string;
  variant: string | null;
  tournament_type: string | null;
  satellite_target_id: string | null;
  started_at: string | null;
  payout_structure: unknown;
}

interface RecoveryPlayer {
  id: string;
  user_id: string;
  status: string;
  position: number | null;
  chips: number | null;
  eliminated_at: string | null;
  elimination_sequence: number | string | null;
}

function satellite(tournament: RecoveryTournament): boolean {
  return (
    String(tournament.variant ?? '').toLowerCase() === 'satellite' ||
    String(tournament.tournament_type ?? '').toUpperCase() === 'SATELLITE' ||
    Boolean(tournament.satellite_target_id)
  );
}

function canonicalWinner(rows: RecoveryPlayer[]): string | null {
  const winners = rows.filter(
    (row) => row.status === 'winner' && Number(row.position) === 1 && uuid(row.user_id) !== null
  );
  if (winners.length === 1) return winners[0].user_id;
  if (winners.length > 1) return null;

  const eliminated = rows.filter((row) => row.status === 'eliminated');
  if (eliminated.length !== rows.length || eliminated.length < 1) return null;
  const sequenced = eliminated.map((row) => ({
    userId: row.user_id,
    sequence: Number(row.elimination_sequence),
  }));
  if (
    sequenced.some(
      ({ userId, sequence }) =>
        uuid(userId) === null || !Number.isSafeInteger(sequence) || sequence < 1
    ) ||
    new Set(sequenced.map(({ sequence }) => sequence)).size !== sequenced.length
  ) {
    return null;
  }
  sequenced.sort(
    (left, right) => right.sequence - left.sequence || left.userId.localeCompare(right.userId)
  );
  return sequenced[0].userId;
}

async function readRecoveryField(
  tournamentId: string
): Promise<{ rows: RecoveryPlayer[] | null; error: unknown }> {
  try {
    const { data, error } = await supabase
      .from('tournament_players')
      .select('id, user_id, status, position, chips, eliminated_at, elimination_sequence')
      .eq('tournament_id', tournamentId);
    return { rows: !error && Array.isArray(data) ? (data as RecoveryPlayer[]) : null, error };
  } catch (error) {
    return { rows: null, error };
  }
}

async function hasHandEvidence(
  tournament: RecoveryTournament
): Promise<{ proven: boolean; error: unknown }> {
  try {
    const { data, error } = await supabase
      .from('hand_history')
      .select('id')
      .eq('tournament_id', tournament.id)
      .limit(1)
      .maybeSingle();
    if (error) return { proven: false, error };
    return {
      proven: !noHandWasEverDealt({
        startedAt: tournament.started_at,
        anyHandDealt: Boolean(data),
      }),
      error: null,
    };
  } catch (error) {
    return { proven: false, error };
  }
}

async function reportUnknownRecoveryOutcome(
  tournament: RecoveryTournament,
  winnerId: string | null,
  reason: string,
  kind: 'satellite' | 'tournament',
  error: unknown
): Promise<void> {
  reportError(error, `GameServer.recoverStuckCompleting_${kind}_outcome_unknown`);
  try {
    await raiseFinancialAlert(
      'critical',
      `${kind === 'satellite' ? 'Satellite' : 'Tournament'}.recovery_settlement_outcome_unknown`,
      'A recovered tournament settlement has no verified immutable receipt after its serialized outcome check. Recovery stopped without any fallback money, standings, lifecycle, or seat write.',
      {
        tournament_id: tournament.id,
        tournament_name: tournament.name,
        winner_id: winnerId,
        recovery_reason: reason,
      }
    );
  } catch (alertError) {
    reportError(alertError, 'GameServer.recoverStuckCompleting_alert_failed');
  }
}

/**
 * Recovery is now an evidence gate in front of the same terminal authorities
 * used by live play. It never writes a result, funds a guarantee, settles one
 * child obligation, closes a seat, or changes tournament status itself.
 */
export async function recoverStuckCompletingTournaments(
  reason: string,
  onlyTournamentId?: string
): Promise<void> {
  try {
    let query = supabase
      .from('tournaments')
      .select(
        'id, name, status, payout_structure, variant, tournament_type, satellite_target_id, started_at'
      )
      .eq('status', 'COMPLETING');
    if (onlyTournamentId) query = query.eq('id', onlyTournamentId);
    const { data: stuck, error: stuckError } = await query;
    if (stuckError || !Array.isArray(stuck)) {
      reportError(
        new Error(
          `[GameServer] recoverStuckCompleting (${reason}): scan failed: ${stuckError?.message ?? 'invalid result'}`
        ),
        'GameServer.recoverStuckCompleting_scan_failed'
      );
      return;
    }

    for (const candidate of stuck as RecoveryTournament[]) {
      if (isMaintenanceFrozen()) continue;
      try {
        const tournament = candidate;
        const isSatellite = satellite(tournament);
        const field = await readRecoveryField(tournament.id);
        if (!field.rows || field.rows.length < 1) {
          reportError(
            field.error ?? new Error('recovery field is empty or unreadable'),
            `GameServer.recoverStuckCompleting_${isSatellite ? 'satellite_' : ''}field_unreadable`
          );
          continue;
        }
        const rows = field.rows;

        if (isSatellite) {
          const live = rows.filter(
            (row) => row.status === 'playing' || row.status === 'registered'
          );
          if (live.length > 1) {
            reportError(
              new Error('satellite remains undecided with more than one live entrant'),
              'GameServer.recoverStuckCompleting_satellite_live_field_conflict'
            );
            continue;
          }
          if (live.length === 1 && live[0].status !== 'playing') {
            reportError(
              new Error('sole satellite entrant was never dealt in'),
              'GameServer.recoverStuckCompleting_satellite_survivor_never_played'
            );
            continue;
          }
          const hand = await hasHandEvidence(tournament);
          if (hand.error || !hand.proven) {
            reportError(
              hand.error ?? new Error('satellite has no durable hand evidence'),
              hand.error
                ? 'GameServer.recoverStuckCompleting_satellite_hand_evidence_unreadable'
                : 'GameServer.recoverStuckCompleting_satellite_no_hand_ever_dealt'
            );
            continue;
          }
          const winnerId = live.length === 1 ? live[0].user_id : canonicalWinner(rows);
          if (!winnerId) {
            reportError(
              new Error('satellite has no single durable winner witness'),
              'GameServer.recoverStuckCompleting_satellite_winner_unproved'
            );
            continue;
          }

          try {
            const receipt = await requestSatelliteSettlementReceipt(tournament.id, winnerId);
            console.log(
              `[GameServer] Recovered satellite ${tournament.id.slice(0, 8)} through immutable receipt: ${receipt.ticketAwardCount} full ticket(s), ${receipt.remainder?.amount ?? 0} bubble remainder`
            );
          } catch (error) {
            if (error instanceof SatelliteSettlementRefusedError) {
              reportError(error, 'GameServer.recoverStuckCompleting_satellite_completion_refused');
            } else {
              await reportUnknownRecoveryOutcome(tournament, winnerId, reason, 'satellite', error);
            }
          }
          continue;
        }

        const [dealPayouts, dealObligations] = await Promise.all([
          supabase
            .from('tournament_payouts')
            .select('id')
            .eq('tournament_id', tournament.id)
            .eq('source', 'final_table_deal')
            .limit(1),
          supabase
            .from('tournament_obligations')
            .select('id')
            .eq('tournament_id', tournament.id)
            .eq('kind', 'final_table_deal')
            .limit(1),
        ]);
        if (
          dealPayouts.error ||
          dealObligations.error ||
          !Array.isArray(dealPayouts.data) ||
          !Array.isArray(dealObligations.data)
        ) {
          reportError(
            dealPayouts.error ?? dealObligations.error ?? new Error('deal evidence unreadable'),
            'GameServer.recoverStuckCompleting_deal_check_failed'
          );
          continue;
        }
        const hasDeal = dealPayouts.data.length > 0 || dealObligations.data.length > 0;

        let winnerId: string | null = null;
        if (!hasDeal) {
          const structure = resolvePayoutStructure(tournament as never, rows.length);
          const livePlayers = rows.filter((row) => row.status === 'playing').length;
          if (fieldIsStillLive({ livePlayers, paidPlaces: structure?.length ?? 0 })) {
            reportError(
              new Error('tournament still has more live players than paid places'),
              'GameServer.recoverStuckCompleting_field_still_live'
            );
            continue;
          }
          const live = rows.filter(
            (row) => row.status === 'playing' || row.status === 'registered'
          );
          if (live.length > 1) {
            reportError(
              new Error('recovery will not invent a multi-player finish from stacks'),
              'GameServer.recoverStuckCompleting_multiple_survivors_unresolved'
            );
            continue;
          }
          if (live.length === 1 && live[0].status !== 'playing') {
            reportError(
              new Error('sole surviving entrant was never dealt in'),
              'GameServer.recoverStuckCompleting_no_dealt_in_survivor'
            );
            continue;
          }
          const hand = await hasHandEvidence(tournament);
          if (hand.error || !hand.proven) {
            reportError(
              hand.error ?? new Error('tournament has no durable hand evidence'),
              hand.error
                ? 'GameServer.recoverStuckCompleting_hand_evidence_unreadable'
                : 'GameServer.recoverStuckCompleting_no_hand_ever_dealt'
            );
            continue;
          }
          winnerId = live.length === 1 ? live[0].user_id : canonicalWinner(rows);
          if (!winnerId) {
            reportError(
              new Error('ordinary tournament has no single durable winner witness'),
              'GameServer.recoverStuckCompleting_winner_missing'
            );
            continue;
          }
        }

        try {
          const receipt = await requestTournamentTerminalReceipt(
            tournament.id,
            hasDeal ? 'final_table_deal' : 'places',
            winnerId
          );
          console.log(
            `[GameServer] Recovered tournament ${tournament.id.slice(0, 8)} through immutable ${receipt.settlementMode} receipt: ${receipt.cashPayoutTotal} cash, ${receipt.bountyPayoutTotal} bounty, ${receipt.tableClosure.closedTableCount} table(s) closed`
          );
        } catch (error) {
          if (error instanceof TerminalSettlementRefusedError) {
            reportError(error, 'GameServer.recoverStuckCompleting_terminal_refused');
          } else {
            await reportUnknownRecoveryOutcome(tournament, winnerId, reason, 'tournament', error);
          }
        }
      } catch (error) {
        reportError(error, 'GameServer.recoverStuckCompleting_tournament_failed');
      }
    }
  } catch (error) {
    reportError(error, 'GameServer.recoverStuckCompleting');
  }
}
