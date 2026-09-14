/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ONE LIVE SEAT PER TOURNAMENT (2026-08-25)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `idx_unique_active_user_per_table` is UNIQUE (table_id, user_id) WHERE
 * left_at IS NULL. It is scoped to ONE TABLE, so it has never had anything to
 * say about a player holding live seats at two DIFFERENT tables of the same
 * tournament — which is the state that double-counts chips.
 *
 * Every seat writer in this tournament decides "is this player seated?" from a
 * snapshot taken once, at the top of a pass that then writes hundreds of seats
 * one statement at a time over several MINUTES. Anything that seats the player
 * inside that window is invisible to the snapshot, and the write lands anyway.
 *
 * Measured live on `bae46dbf` ("$100 Freeroll 12:00 PM"), 2026-08-25:
 * 72 players holding 144 live seats across two tables each, every pair written
 * between 17:13:39 and 17:16:28 while the start-seating pass was still running,
 * 46 of the 72 pairs sitting exactly 14 tables apart — two independent
 * round-robin cursors walking the same table list. Both seats are dealt, both
 * stacks diverge, and the former delayed chip snapshot then had to pick one.
 * The accepted-hand transaction now mirrors one exact roster and the delayed
 * writer has been removed, but duplicate seating must still be refused here.
 *
 * So the snapshot is not the check. THIS is the check, and it is taken
 * immediately before the write, by every writer.
 *
 * An unreadable answer is UNKNOWN, never "no seat". A writer that cannot see
 * the player's seats does not get to add one - the process-wide detector
 * rechecks within its bounded recovery cadence, so refusing costs a player
 * one cycle, while guessing costs the tournament its chip count.
 */

export interface SeatClaimClient {
  from(table: string): any;
}

export interface LiveSeat {
  id: string;
  table_id: string;
  seat_number: number;
}

export type LiveSeatLookup =
  | { ok: true; seats: LiveSeat[] }
  /** The read failed. UNKNOWN — the caller must not seat. */
  | { ok: false; reason: string };

/**
 * Every seat this user currently holds (left_at IS NULL) at any table of this
 * tournament, optionally ignoring one table (the source of a move, or the
 * destination the caller is about to write).
 */
export async function findLiveSeatsInTournament(
  client: SeatClaimClient,
  tournamentId: string,
  userId: string,
  exceptTableId?: string
): Promise<LiveSeatLookup> {
  try {
    const { data, error } = await client
      .from('table_seats')
      .select('id, table_id, seat_number, tables!table_seats_table_id_fkey!inner(tournament_id)')
      .is('left_at', null)
      .eq('tables.tournament_id', tournamentId)
      .eq('user_id', userId);

    if (error) return { ok: false, reason: error.message || 'unknown read error' };
    if (data == null) return { ok: false, reason: 'no rows returned and no error' };

    const seats = (data as any[])
      .filter((r) => !exceptTableId || r.table_id !== exceptTableId)
      .map((r) => ({
        id: String(r.id),
        table_id: String(r.table_id),
        seat_number: Number(r.seat_number),
      }));
    return { ok: true, seats };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * True when it is safe to write a live seat for this player.
 *
 * Refuses on any live seat elsewhere in the tournament, and refuses on an
 * unreadable answer. `exceptTableId` is the ONE table whose live seat does not
 * count — the source table of a move, which the mover is about to vacate.
 * Omit it for a fresh seating, where nothing is exempt.
 */
export async function mayTakeSeat(
  client: SeatClaimClient,
  tournamentId: string,
  userId: string,
  exceptTableId?: string
): Promise<{ allowed: true } | { allowed: false; reason: string; unknown: boolean }> {
  const found = await findLiveSeatsInTournament(client, tournamentId, userId, exceptTableId);
  if (!found.ok) {
    return {
      allowed: false,
      unknown: true,
      reason: `could not read the player's live seats (${found.reason})`,
    };
  }
  if (found.seats.length > 0) {
    const held = found.seats
      .map((s) => `table ${s.table_id.slice(0, 8)} seat ${s.seat_number}`)
      .join(', ');
    return {
      allowed: false,
      unknown: false,
      reason: `player already holds a live seat in this tournament (${held})`,
    };
  }
  return { allowed: true };
}
