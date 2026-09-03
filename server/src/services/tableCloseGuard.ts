/**
 * ═════════════════════════════════════════════════════════════════════════
 *  A SWEEP MAY NOT CLOSE A TABLE THAT A LIVE TOURNAMENT IS STANDING ON
 * ═════════════════════════════════════════════════════════════════════════
 *
 * Two different outages in two days came from the same shape: something that
 * was not the tournament's own engine closed the tournament's table.
 *
 *   - 2026-08-30, 71 tables of 19 RUNNING tournaments closed with 411 seats
 *     still open, which took the engine's table discovery to zero;
 *   - 2026-08-30/31, 32 REGISTERING heads-up SNGs left owning one closed
 *     table each, which killed the whole Sit-and-Go board for ten hours.
 *
 * Closing a tournament table is legitimate in exactly three places, and all
 * three are the tournament's OWN lifecycle: a table break once every player
 * has been moved, the finish (or the final-table deal) once the money is paid,
 * and the cancel-and-refund path. Every other caller is a SWEEP, and a sweep
 * may only close a table whose tournament has already reached a terminal
 * status.
 *
 * This is deliberately a guard function rather than a database constraint: a
 * hard refusal at the trigger would have to reject the legitimate closes too,
 * or guess which is which, and a guard that can refuse a seat exit is how a
 * player gets stranded mid-hand. The database already spares the FIELD when a
 * close lands on a live tournament and raises the
 * `table_closed_under_live_tournament` alarm; this stops the engine's own
 * sweeps ever being the caller that raises it.
 */

/** Why a table is being closed. */
export type TableCloseReason =
  /** The tournament's own engine: table break, finish, final-table deal. */
  | 'tournament_lifecycle'
  /** The cancel-and-refund path, which has already refunded the field. */
  | 'tournament_cancelled'
  /** A janitor/orphan/idle sweep. Not the tournament's engine. */
  | 'sweep';

/** COMPLETED and CANCELLED are the only statuses that end a tournament. */
export function isTerminalTournamentStatus(status: string | null | undefined): boolean {
  const s = String(status ?? '').toUpperCase();
  return s === 'COMPLETED' || s === 'CANCELLED';
}

/**
 * May this caller close a table owned by a tournament in this status?
 *
 * An UNKNOWN status (the tournament row could not be read) is NOT terminal, so
 * a sweep is refused. That is the safe direction: leaving a table open costs a
 * row, closing one under a live field costs the game.
 */
export function canCloseTournamentTable(
  tournamentStatus: string | null | undefined,
  reason: TableCloseReason
): boolean {
  if (reason === 'tournament_lifecycle' || reason === 'tournament_cancelled') return true;
  return isTerminalTournamentStatus(tournamentStatus);
}

/**
 * Filter a batch of tables down to the ones a sweep is allowed to close.
 *
 * `statusByTournament` must be read in the SAME pass as the write, not carried
 * over from an earlier one: the whole point is to close the window between
 * "this tournament looked finished" and "this table is now closed".
 */
export function tablesASweepMayClose(
  batch: Array<{ tableId: string; tournamentId: string | null | undefined }>,
  statusByTournament: Map<string, string>
): string[] {
  return batch
    .filter((row) =>
      canCloseTournamentTable(statusByTournament.get(String(row.tournamentId ?? '')), 'sweep')
    )
    .map((row) => row.tableId);
}
