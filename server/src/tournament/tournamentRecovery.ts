/**
 * Tournament cancellation + stuck-COMPLETING recovery helpers.
 *
 * Cancellation refunds remain evidence-based and idempotent. Cash recovery
 * does not recalculate, rank, or repair payouts: it resumes only from one
 * durable winner and a complete receipt returned by the authoritative
 * database settlement door.
 */

import { supabase } from '../services/supabase.js';
import { reportError } from '../services/errorReporter.js';
import { raiseFinancialAlert } from '../services/financialAlerts.js';
import { requestSatelliteSettlementReceipt } from './satelliteSettlementRpc.js';
import { requestTournamentTerminalReceipt } from './terminalSettlementRpc.js';

const TOURNAMENT_CANCELLATION_SYSTEM_ACTOR_ID = '2d1cd6c3-5700-4af9-a271-d4863fdab20d';

interface TournamentCancellationRefund {
  user_id?: unknown;
  gross_paid?: unknown;
  amount_refunded?: unknown;
  amount_paid_before?: unknown;
  amount_paid_now?: unknown;
  obligation_id?: unknown;
  idempotency_key?: unknown;
}

interface TournamentCancellationReceipt {
  ok?: unknown;
  success?: unknown;
  fully_settled?: unknown;
  receipt_version?: unknown;
  tournament_id?: unknown;
  actor_id?: unknown;
  status?: unknown;
  refunded_count?: unknown;
  total_refunded?: unknown;
  fees_reversed?: unknown;
  player_count?: unknown;
  table_count?: unknown;
  refunds?: unknown;
  settled_at?: unknown;
}

export interface VerifiedTournamentCancellationReceipt {
  tournamentId: string;
  actorId: string;
  refundedCount: number;
  totalRefunded: number;
  feesReversed: number;
  playerCount: number;
  tableCount: number;
  refunds: Array<{
    userId: string;
    grossPaid: number;
    amountRefunded: number;
    amountPaidBefore: number;
    amountPaidNow: number;
    obligationId: string;
    idempotencyKey: string | null;
  }>;
  settledAt: string;
}

function parseTournamentCancellationReceipt(value: unknown): TournamentCancellationReceipt {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? (parsed as TournamentCancellationReceipt) : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' ? (value as TournamentCancellationReceipt) : {};
}

function exactNonNegativeCents(value: unknown): number | null {
  if (typeof value !== 'number') return null;
  const amount = value;
  if (!Number.isFinite(amount) || amount < 0) return null;
  const cents = Math.round(amount * 100);
  return Number.isSafeInteger(cents) && Math.abs(amount * 100 - cents) < 1e-7 ? cents : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function uuid(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  ) {
    return null;
  }
  return value;
}

/**
 * A successful transport response is not permission to declare a cancellation
 * complete. Prove that the database returned the expected stored receipt, that
 * every evidence-derived refund is whole cents and fully paid, and that the
 * receipt's totals agree with its unique per-player lines.
 */
export function verifyTournamentCancellationReceipt(
  raw: unknown,
  expectedTournamentId: string,
  expectedActorId: string
): VerifiedTournamentCancellationReceipt | null {
  const receipt = parseTournamentCancellationReceipt(raw);
  const tournamentId = uuid(receipt.tournament_id);
  const actorId = uuid(receipt.actor_id);
  const refundedCount = nonNegativeInteger(receipt.refunded_count);
  const playerCount = nonNegativeInteger(receipt.player_count);
  const tableCount = nonNegativeInteger(receipt.table_count);
  const totalRefundedCents = exactNonNegativeCents(receipt.total_refunded);
  const feesReversedCents = exactNonNegativeCents(receipt.fees_reversed);
  const settledAt = typeof receipt.settled_at === 'string' ? receipt.settled_at : '';

  if (
    receipt.ok !== true ||
    receipt.success !== true ||
    receipt.fully_settled !== true ||
    receipt.receipt_version !== 1 ||
    receipt.status !== 'CANCELLED' ||
    tournamentId !== expectedTournamentId ||
    actorId !== expectedActorId ||
    refundedCount === null ||
    playerCount === null ||
    tableCount === null ||
    refundedCount > playerCount ||
    totalRefundedCents === null ||
    feesReversedCents === null ||
    feesReversedCents > totalRefundedCents ||
    !Array.isArray(receipt.refunds) ||
    receipt.refunds.length !== refundedCount ||
    !settledAt ||
    !Number.isFinite(Date.parse(settledAt))
  ) {
    return null;
  }

  const refunds: VerifiedTournamentCancellationReceipt['refunds'] = [];
  const users = new Set<string>();
  const obligations = new Set<string>();
  let observedRefundCents = 0;
  for (const candidate of receipt.refunds as TournamentCancellationRefund[]) {
    const userId = uuid(candidate?.user_id);
    const obligationId = uuid(candidate?.obligation_id);
    const grossCents = exactNonNegativeCents(candidate?.gross_paid);
    const refundedCents = exactNonNegativeCents(candidate?.amount_refunded);
    const paidBeforeCents = exactNonNegativeCents(candidate?.amount_paid_before);
    const paidNowCents = exactNonNegativeCents(candidate?.amount_paid_now);
    const idempotencyKey = candidate?.idempotency_key;
    const expectedKey =
      obligationId && paidBeforeCents !== null
        ? `tourney:${expectedTournamentId}:obl:${obligationId}:${paidBeforeCents}`
        : null;
    if (
      !userId ||
      !obligationId ||
      grossCents === null ||
      grossCents <= 0 ||
      refundedCents !== grossCents ||
      paidBeforeCents === null ||
      paidNowCents === null ||
      !Number.isSafeInteger(paidBeforeCents + paidNowCents) ||
      paidBeforeCents + paidNowCents !== refundedCents ||
      (paidNowCents > 0 ? idempotencyKey !== expectedKey : idempotencyKey !== null) ||
      users.has(userId) ||
      obligations.has(obligationId)
    ) {
      return null;
    }
    users.add(userId);
    obligations.add(obligationId);
    observedRefundCents += refundedCents;
    if (!Number.isSafeInteger(observedRefundCents)) return null;
    refunds.push({
      userId,
      grossPaid: grossCents / 100,
      amountRefunded: refundedCents / 100,
      amountPaidBefore: paidBeforeCents / 100,
      amountPaidNow: paidNowCents / 100,
      obligationId,
      idempotencyKey: idempotencyKey as string | null,
    });
  }
  if (observedRefundCents !== totalRefundedCents) return null;

  return {
    tournamentId,
    actorId,
    refundedCount,
    totalRefunded: totalRefundedCents / 100,
    feesReversed: feesReversedCents / 100,
    playerCount,
    tableCount,
    refunds,
    settledAt,
  };
}

/**
 * TOURNEY-AUDIT 2026-07-24 (sweep 4): shared cleanup for every server-side
 * tournament CANCELLATION path (restart-orphaned SNG/Spins, >12h stale MTTs).
 * Verified live after sweep 3: cancels left tournament_players rows stranded
 * in 'playing'/'registered' forever (64 new stranded rows within an hour) and
 * left tournament tables open. This helper now retains only the fail-closed
 * survivor preflight. One database transaction derives every refund from
 * entry-payment evidence, reverses fees, closes tournament/player/table rows,
 * and stores the receipt. Horses and humans follow the same evidence rule.
 * Replays return the stored receipt and move no money.
 */
export async function refundAndCloseCancelledTournament(
  tournamentId: string,
  _tournamentName: string | null,
  _refundReason: string,
  actorId: string = TOURNAMENT_CANCELLATION_SYSTEM_ACTOR_ID
): Promise<void> {
  try {
    // Keep the old fail-closed survivor preflight. It no longer derives money
    // or drives closeout; it exists solely to ensure an unreadable roster can
    // never be mistaken for an empty one before the atomic authority is called.
    const { data: openRows, error: openRowsErr } = await supabase
      .from('tournament_players')
      .select('id')
      .eq('tournament_id', tournamentId)
      .in('status', ['playing', 'registered']);
    if (openRowsErr) {
      reportError(
        new Error(
          `[GameServer] Cancel refund ABORTED for ${tournamentId.slice(0, 8)}: open-registration list unreadable (${openRowsErr.message}) - refunding nobody and closing nothing this pass`
        ),
        'GameServer.cancel_refund_open_rows_unreadable'
      );
      return;
    }
    if (!Array.isArray(openRows)) {
      reportError(
        new Error(
          `[GameServer] Cancel refund ABORTED for ${tournamentId.slice(0, 8)}: open-registration list returned no rows value - refunding nobody and closing nothing this pass`
        ),
        'GameServer.cancel_refund_open_rows_unreadable'
      );
      return;
    }

    const cancellation = await supabase.rpc('atomic_cancel_tournament', {
      p_tournament_id: tournamentId,
      p_admin_id: actorId,
    });
    if (cancellation.error) {
      reportError(
        new Error(
          `[GameServer] Atomic cancellation outcome unconfirmed for ${tournamentId.slice(0, 8)}: ${cancellation.error.message} - replay is safe and must return the stored receipt if the first call committed`
        ),
        'GameServer.cancel_refund_atomic_failed'
      );
      return;
    }

    const receipt = verifyTournamentCancellationReceipt(cancellation.data, tournamentId, actorId);
    if (!receipt || receipt.playerCount < openRows.length) {
      reportError(
        new Error(
          `[GameServer] Atomic cancellation returned an incomplete receipt for ${tournamentId.slice(0, 8)} - closeout is not acknowledged`
        ),
        'GameServer.cancel_refund_receipt_invalid'
      );
      return;
    }

    console.log(
      `[GameServer] Cancelled ${tournamentId.slice(0, 8)} through one stored receipt: ${receipt.refundedCount} refund(s), ${receipt.totalRefunded.toFixed(2)} returned, ${receipt.feesReversed.toFixed(2)} fees reversed`
    );
  } catch (err) {
    reportError(err, 'GameServer.refundAndCloseCancelledTournament');
  }
}

/**
 * Resume a stuck cash finish only from durable result evidence. The database
 * settlement transaction owns payout calculation, wallet movement, payout
 * evidence, and standings; this helper validates its terminal receipt before
 * it settles rake and performs the guarded closeout.
 */
export async function recoverStuckCompletingTournaments(
  reason: string,
  onlyTournamentId?: string
): Promise<void> {
  try {
    let q = supabase
      .from('tournaments')
      .select(
        'id, name, prize_pool, variant, tournament_type, satellite_target_id, satellite_target, mystery_bounty_stage, is_bounty, is_pko, is_mystery_bounty'
      )
      .eq('status', 'COMPLETING');
    if (onlyTournamentId) q = q.eq('id', onlyTournamentId);
    const { data: stuck, error: stuckErr } = await q;
    // PAYOUT-INTEGRITY 2026-08-25: an unreadable list is not an empty one. The
    // discarded error made a failed scan indistinguishable from "nothing is
    // stuck", which is the one thing this watchdog exists to detect.
    if (stuckErr || !Array.isArray(stuck)) {
      reportError(
        new Error(
          `[GameServer] recoverStuckCompleting (${reason}): COMPLETING scan failed: ${stuckErr?.message ?? 'no rows value'} - recovered nothing this pass`
        ),
        'GameServer.recoverStuckCompleting_scan_failed'
      );
      return;
    }
    for (const t of stuck) {
      try {
        /**
         * ═══════════════════════════════════════════════════════════════════
         *  A SATELLITE PAYS SEATS, NOT CASH — AND THIS PATH DID NOT KNOW
         *  (2026-08-29)
         * ═══════════════════════════════════════════════════════════════════
         *
         * Both live payout sites refuse to pay per-place cash on a satellite:
         * `eliminatePlayer` checks `variant === 'satellite'` before pricing,
         * and `finishTournament` does the same. This rescue never did, though
         * it selects `variant` (for the Spin structure rebuild) and had it in
         * hand the whole time.
         *
         * The consequence is a race for real money. A satellite stuck in
         * COMPLETING gets paid cash from `payout_structure` under
         * `tourney:{id}:prize:place:{N}` -- the IDENTICAL key
         * `processSatelliteAwards` uses to pay the ticket value. Whichever
         * path runs first wins, the second silently credits nothing, and the
         * two amounts are different: a player receives either the seat's worth
         * or the structure prize depending on which lost the race. If this
         * path wins, the seats are never awarded at all and the target
         * tournament's field is never funded.
         *
         * Leaving it COMPLETING is the safe outcome: processSatelliteAwards is
         * the only thing that should finish it, and it is driven separately.
         */
        if (
          String((t as { variant?: string }).variant ?? '').toLowerCase() === 'satellite' ||
          String((t as { tournament_type?: string }).tournament_type ?? '').toUpperCase() ===
            'SATELLITE' ||
          Boolean(
            (t as { satellite_target_id?: string | null }).satellite_target_id ||
            (t as { satellite_target?: string | null }).satellite_target
          )
        ) {
          // Recovery may identify a historical undecided event from the
          // durable roster, but partial payout or target-seat evidence can
          // never prove a satellite completed. Only the settlement authority's
          // immutable v2 receipt may do that.
          const { data: satellitePlayers, error: rosterErr } = await supabase
            .from('tournament_players')
            .select('user_id, status, position')
            .eq('tournament_id', t.id);
          if (rosterErr || !Array.isArray(satellitePlayers)) {
            await raiseFinancialAlert(
              'critical',
              'Satellite.stuck_completing_roster_unreadable',
              'A stuck satellite roster is unreadable. Recovery left it COMPLETING and moved no money because an unknown field can never prove a winner.',
              {
                tournament_id: t.id,
                tournament_name: (t as { name?: string }).name ?? null,
                reason,
                error: rosterErr?.message ?? 'no rows value',
              }
            );
            reportError(
              new Error(
                `[GameServer] recoverStuckCompleting (${reason}): satellite ${t.id.slice(0, 8)} roster unreadable - left COMPLETING`
              ),
              'GameServer.recoverStuckCompleting_satellite_roster_unreadable'
            );
            continue;
          }

          const statusOf = (player: { status?: unknown }) =>
            String(player.status ?? '').toLowerCase();
          const registeredPlayers = satellitePlayers.filter(
            (player) => statusOf(player) === 'registered'
          );
          const playingPlayers = satellitePlayers.filter(
            (player) => statusOf(player) === 'playing'
          );
          const livePlayers = satellitePlayers.filter((player) =>
            ['playing', 'winner'].includes(statusOf(player))
          );
          const durableResultPlayers = satellitePlayers.filter(
            (player) => statusOf(player) === 'winner' || Number(player.position) === 1
          );

          // Only this historical, visibly undecided shape may be revived. The
          // presence of a durable winner or place 1 makes the event decided,
          // even if another stale registration or playing row survived. In
          // that shape the atomic settlement authority must refuse or finish;
          // recovery may never reopen play over a recorded result. The exact
          // compare-and-set keeps two recovery processes from both claiming
          // the genuinely undecided transition.
          if (
            durableResultPlayers.length === 0 &&
            (registeredPlayers.length > 0 || playingPlayers.length >= 2)
          ) {
            const revived = await supabase
              .from('tournaments')
              .update({ status: 'RUNNING' }, { count: 'exact' })
              .eq('id', t.id)
              .eq('status', 'COMPLETING');
            if (revived.error || revived.count !== 1) {
              await raiseFinancialAlert(
                'critical',
                'Satellite.stuck_completing_revive_unconfirmed',
                'An undecided historical satellite could not make the exact COMPLETING to RUNNING transition. It remains unconfirmed and recovery moved no money.',
                {
                  tournament_id: t.id,
                  tournament_name: (t as { name?: string }).name ?? null,
                  reason,
                  registered_count: registeredPlayers.length,
                  live_count: playingPlayers.length,
                  updated_count: revived.count ?? null,
                  error: revived.error?.message ?? null,
                }
              );
              reportError(
                new Error(
                  `[GameServer] recoverStuckCompleting (${reason}): satellite ${t.id.slice(0, 8)} revive was not an exact CAS: ${revived.error?.message ?? `updated ${revived.count ?? 0} rows`}`
                ),
                'GameServer.recoverStuckCompleting_satellite_revive_unconfirmed'
              );
            } else {
              console.log(
                `[GameServer] recoverStuckCompleting (${reason}): revived undecided satellite ${t.id.slice(0, 8)} for normal play`
              );
            }
            continue;
          }

          const soleLive = livePlayers.length === 1 ? livePlayers[0] : null;
          const firstPlacePlayers = satellitePlayers.filter(
            (player) =>
              Number(player.position) === 1 &&
              typeof player.user_id === 'string' &&
              player.user_id.length > 0
          );
          const winnerId =
            soleLive && typeof soleLive.user_id === 'string' && soleLive.user_id.length > 0
              ? soleLive.user_id
              : firstPlacePlayers.length === 1
                ? firstPlacePlayers[0].user_id
                : null;
          if (typeof winnerId !== 'string' || winnerId.length === 0) {
            await raiseFinancialAlert(
              'critical',
              'Satellite.stuck_completing_winner_absent',
              'A decided satellite has no single durable observed winner. Recovery left it COMPLETING and moved no money rather than infer a winner from chips, order, or timestamps.',
              {
                tournament_id: t.id,
                tournament_name: (t as { name?: string }).name ?? null,
                reason,
                live_count: livePlayers.length,
                position_one_count: firstPlacePlayers.length,
              }
            );
            reportError(
              new Error(
                `[GameServer] recoverStuckCompleting (${reason}): satellite ${t.id.slice(0, 8)} has no single durable observed winner - left COMPLETING`
              ),
              'GameServer.recoverStuckCompleting_satellite_winner_absent'
            );
            continue;
          }

          let satelliteReceipt;
          try {
            satelliteReceipt = await requestSatelliteSettlementReceipt(t.id, winnerId);
          } catch (satelliteSettlementError) {
            await raiseFinancialAlert(
              'critical',
              'Satellite.seat_outcome_unconfirmed',
              'Satellite settlement outcome unconfirmed. Inspect the immutable settlement header and award lines before any manual action; never infer rollback from a transport error.',
              {
                tournament_id: t.id,
                tournament_name: (t as { name?: string }).name ?? null,
                reason,
                observed_winner_id: winnerId,
                transport_error:
                  satelliteSettlementError instanceof Error
                    ? satelliteSettlementError.message
                    : String(satelliteSettlementError),
              }
            );
            reportError(
              new Error(
                `[GameServer] recoverStuckCompleting (${reason}): satellite ${t.id.slice(0, 8)} settlement outcome unconfirmed: ${satelliteSettlementError instanceof Error ? satelliteSettlementError.message : String(satelliteSettlementError)}`
              ),
              'GameServer.recoverStuckCompleting_satellite_outcome_unconfirmed'
            );
            continue;
          }

          console.log(
            `[GameServer] Replayed satellite ${t.id.slice(0, 8)} receipt: ${satelliteReceipt.ticketAwardCount} ticket(s), ${satelliteReceipt.seatCount} seat(s), ${satelliteReceipt.cashTicketCount} cash substitution(s), ${satelliteReceipt.remainder?.amount ?? 0} remainder; durable source tables and seats are closed by the same transaction`
          );
          continue;
        }

        // A COMPLETING cash event is resumable only from the durable result
        // written by its atomic settlement transaction. Recovery is not a
        // second prize calculator and may never infer a podium from chips,
        // timestamps, player order, or a mutable payout structure.
        const { data: players, error: playersErr } = await supabase
          .from('tournament_players')
          .select('user_id, status, position')
          .eq('tournament_id', t.id);
        if (playersErr || !Array.isArray(players)) {
          throw new Error(
            `durable field unreadable for ${t.id.slice(0, 8)} "${t.name}": ${playersErr?.message ?? 'no rows'}`
          );
        }

        const durableChampions = players.filter(
          (player) => player.status === 'winner' && Number(player.position) === 1
        );
        const otherFirstPlaces = players.filter(
          (player) => Number(player.position) === 1 && player.status !== 'winner'
        );
        if (durableChampions.length !== 1 || otherFirstPlaces.length > 0) {
          reportError(
            new Error(
              `[GameServer] recoverStuckCompleting (${reason}): ${t.id.slice(0, 8)} "${t.name}" has no single durable winner at position 1. Recovery cannot invent one, so no payout or status changed.`
            ),
            'GameServer.recoverStuckCompleting_durable_winner_absent'
          );
          continue;
        }
        const winnerId = durableChampions[0].user_id;

        // Existing payout evidence selects which branch of the one terminal
        // authority must replay. Recovery never recalculates money and never
        // performs bounty, rake, escrow, or status writes itself.
        const { data: dealEvidence, error: dealEvidenceErr } = await supabase
          .from('tournament_payouts')
          .select('id')
          .eq('tournament_id', t.id)
          .eq('source', 'final_table_deal')
          .limit(1);
        if (dealEvidenceErr || !Array.isArray(dealEvidence)) {
          throw new Error(
            `deal evidence unreadable for ${t.id.slice(0, 8)}: ${dealEvidenceErr?.message ?? 'no rows value'}`
          );
        }
        const isFinalTableDeal = (dealEvidence?.length ?? 0) > 0;
        const settlementMode = isFinalTableDeal ? 'final_table_deal' : 'places';
        await requestTournamentTerminalReceipt(t.id, settlementMode, winnerId);

        console.log(
          `[GameServer] Resumed COMPLETING tournament ${t.id.slice(0, 8)} "${t.name}" (${reason}) from its authoritative settlement receipt with durable table closeout`
        );
      } catch (err) {
        reportError(err, 'GameServer.recoverStuckCompleting_per_tournament');
      }
    }
  } catch (err) {
    reportError(err, 'GameServer.recoverStuckCompleting');
  }
}
