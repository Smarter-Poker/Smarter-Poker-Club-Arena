/**
 * Tournament terminal recovery.
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function uuid(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value : null;
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
