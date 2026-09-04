/**
 * SEAT MOVES - the engine's half of must-move (Operation Table Stakes,
 * Slice 2; OPORD 1.3 section 9.5, OPORD 1.4 section 18.3). 2026-09-05.
 *
 * The ClusterController PLANS a move (a cash_seat_moves row: this player,
 * from this table, to that one). The engine at the FROM table EXECUTES it at
 * the player's next hand boundary through fn_cash_seat_move_execute, which
 * moves the chair, the chips and the chip-continuity session in one
 * transaction and touches no wallet. A move the engine does not reach within
 * 60 s expires and is planned again; nothing is lost either way.
 *
 * A player is never asked anything. They are told once, at the start of the
 * hand they will move after ("Seat Open On Main 2. Moving After This Hand."),
 * and then they are at the new table.
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
 * Execute every pending move for this table. Returns the ones that landed;
 * a refused move (destination filled, player already gone, frozen) is left
 * for the controller to re-plan and is not an error here.
 */
export async function executePendingSeatMoves(tableId: string): Promise<ExecutedSeatMove[]> {
  const pending = await pendingSeatMoves(tableId);
  const done: ExecutedSeatMove[] = [];
  for (const m of pending) {
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
