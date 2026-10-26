import { supabase } from '../lib/supabase';
import { parseTableArenaIdentity } from '../../server/src/domain/ArenaContext';
import { fetchTournamentResult } from './tournamentResult';
import { publishSessionSummary } from './pendingSessionSummary';
import { awaitTournamentResultEnrichment } from '../utils/tournamentResultEnrichment';
import { reportError } from '../utils/errorReporter';

/** The seat rebuild must deliver a finish before it unmounts its table owner.
 * A replacement live seat proves a move. A playing or unreadable entrant
 * without that witness retains its tab until the result owner can finish. */
export async function reportRemovedTournamentSeats(
  removedTableIds: string[],
  userId: string,
  isCurrent: () => boolean,
  liveTournamentIds: ReadonlySet<string> = new Set()
): Promise<Set<string>> {
  const retain = new Set(removedTableIds);
  if (removedTableIds.length === 0) return retain;
  try {
    const response = await awaitTournamentResultEnrichment(
      supabase
        .from('tables')
        .select(
          'id, name, tournament_id, club_id, union_id, arena:clubs!fk_tables_club_id(id, asset, is_platform, union_id)'
        )
        .in('id', removedTableIds)
    );
    if (!isCurrent()) return retain;
    if (!response || response.error || !Array.isArray(response.data)) {
      throw response?.error ?? new Error('Closed Seat Report Read Timed Out');
    }
    for (const row of response.data) {
      if (!row.tournament_id) {
        retain.delete(row.id); // A readable cash table has no tournament report.
        continue;
      }
      const result = await awaitTournamentResultEnrichment(
        fetchTournamentResult(row.tournament_id, userId)
      );
      if (!isCurrent()) return retain;
      if (result?.entryStatus === 'playing' || result?.entryStatus === 'registered') {
        // Seat release can commit before elimination. Only a confirmed live
        // seat in this same event proves a move/rebuy; keep the result owner
        // mounted while the entrant's terminal event is still in flight.
        if (liveTournamentIds.has(row.tournament_id)) retain.delete(row.id);
        continue;
      }
      const qualified = !!result?.satelliteQualification;
      if (
        !result ||
        !['eliminated', 'winner'].includes(result.entryStatus ?? '') ||
        (!qualified && !(Number.isInteger(result.finishPlace) && Number(result.finishPlace) > 0))
      ) {
        continue;
      }
      const arena = parseTableArenaIdentity(row);
      publishSessionSummary({
        arenaAsset: arena.asset,
        resultOnly: true,
        duration: 0,
        handsPlayed: 0,
        handsWon: 0,
        totalRebuys: result.rebuys,
        profitLoss: 0,
        biggestPot: 0,
        peakStack: 0,
        tableName: result.name || row.name,
        sessionEnd: Date.now(),
        tournament: result,
      });
      retain.delete(row.id);
    }
    return retain;
  } catch (error) {
    reportError(error, 'MultiTablePage.closed_tournament_report');
    return new Set(removedTableIds);
  }
}
