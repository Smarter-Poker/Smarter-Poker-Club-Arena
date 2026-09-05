/**
 * SEAT MOVES - the engine's half of must-move (Operation Table Stakes,
 * Slice 2; OPORD 1.3 section 9.5, OPORD 1.4 section 18.3). 2026-09-05.
 *
 * The ClusterController PLANS a move (a cash_seat_moves row: this player,
 * from this table, to that one). The engine at the FROM table EXECUTES it at
 * the player's next hand boundary through fn_cash_seat_move_execute, which
 * moves the chair, the chips and the chip-continuity session in one
 * transaction and touches no wallet. A move the engine does not reach within
 * three minutes expires and is planned again; nothing is lost either way.
 *
 * A player is never asked anything. They are told once, at the start of the
 * hand they will move after ("Seat Open On Main 2. Moving After This Hand."),
 * and then they are at the new table. THE PROMISE IS KEPT (2026-09-05): the
 * announcement stamps the row (`announced_at`) and extends its life to cover
 * the hand, and settlement executes ANNOUNCED moves only - a move planned
 * mid-hand waits for the next deal to be announced, never lands unannounced
 * at the end of a hand the player was not told about. A table with no hand
 * running (below the minimum to deal) executes any pending move at once:
 * there is no hand to finish, and a lone player on a feeder has nothing to
 * wait for.
 */

import { supabase } from './client.js';
import { reportError } from '../errorReporter.js';

export interface PendingSeatMove {
  move_id: string;
  player_id: string;
  to_table_id: string;
  to_table_name: string | null;
  to_role: string | null;
  to_main_index: number | null;
  reason: 'must_move' | 'break';
  /** Set by fn_cash_seat_move_announce when the from-table engine told the player. */
  announced_at: string | null;
}

export interface ExecutedSeatMove {
  move_id: string;
  player_id: string;
  to_table_id: string;
  to_seat_number: number;
  stack: number;
}

/** The moves waiting on this table's next hand boundary. Empty on any error. */
export async function pendingSeatMoves(tableId: string): Promise<PendingSeatMove[]> {
  const { data, error } = await supabase.rpc('fn_cash_seat_moves_pending', {
    p_table_id: tableId,
  });
  if (error) {
    reportError(error, 'seatMoves.pending_failed', { tableId });
    return [];
  }
  return (data ?? []) as PendingSeatMove[];
}

/**
 * Record that these moves were announced to their players at the start of a
 * hand: stamps announced_at and extends expiry to cover the hand. Returns the
 * number of rows stamped; 0 on error (the move then simply waits for the next
 * announcement, it is never lost).
 */
export async function announceSeatMoves(moveIds: string[]): Promise<number> {
  if (moveIds.length === 0) return 0;
  const { data, error } = await supabase.rpc('fn_cash_seat_move_announce', {
    p_move_ids: moveIds,
  });
  if (error) {
    reportError(error, 'seatMoves.announce_failed', { moveIds });
    return 0;
  }
  return Number(data ?? 0);
}

export interface ExecuteSeatMovesOptions {
  /**
   * Execute only moves that were announced (settlement: the hand the player
   * was told about has ended). An idle table passes false: nothing is
   * running, every pending move lands now.
   */
  announcedOnly: boolean;
}

/**
 * Execute the pending moves for this table. Returns the ones that landed;
 * a refused move (destination filled, player already gone, busted, frozen)
 * is left for the controller to re-plan and is not an error here.
 */
export async function executePendingSeatMoves(
  tableId: string,
  opts: ExecuteSeatMovesOptions = { announcedOnly: false }
): Promise<ExecutedSeatMove[]> {
  const pending = await pendingSeatMoves(tableId);
  const due = opts.announcedOnly ? pending.filter((m) => m.announced_at != null) : pending;
  const done: ExecutedSeatMove[] = [];
  for (const m of due) {
    const { data, error } = await supabase.rpc('fn_cash_seat_move_execute', {
      p_move_id: m.move_id,
    });
    if (error) {
      reportError(error, 'seatMoves.execute_failed', { tableId, move_id: m.move_id });
      continue;
    }
    const res = (data ?? {}) as {
      ok?: boolean;
      reason?: string;
      to_table_id?: string;
      to_seat_number?: number;
      stack?: number;
    };
    if (res.ok && res.to_table_id && typeof res.to_seat_number === 'number') {
      done.push({
        move_id: m.move_id,
        player_id: m.player_id,
        to_table_id: res.to_table_id,
        to_seat_number: res.to_seat_number,
        stack: Number(res.stack ?? 0),
      });
    } else {
      console.log(
        `[seatMoves:${tableId}] move ${m.move_id} for ${m.player_id} not executed: ${res.reason ?? 'unknown'}`
      );
    }
  }
  return done;
}

/** The interstitial copy (OPORD 1.3 section 9.5). Title case, no em dash. */
export function seatMoveNotice(
  m: Pick<PendingSeatMove, 'to_role' | 'to_main_index' | 'to_table_name' | 'reason'>
): string {
  const where =
    m.to_role === 'main' && m.to_main_index
      ? `Main ${m.to_main_index}`
      : m.to_role === 'feeder'
        ? 'The Feeder Table'
        : (m.to_table_name ?? 'Your New Table');
  return m.reason === 'break'
    ? `This Table Is Closing. Moving To ${where} After This Hand.`
    : `Seat Open On ${where}. Moving After This Hand.`;
}
