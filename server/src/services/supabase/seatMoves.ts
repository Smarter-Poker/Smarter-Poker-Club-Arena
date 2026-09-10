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
 *
 * THREE REASONS, TWO ENTRIES (Dan 2026-09-05). `must_move` and `break` are
 * the game moving the player: they arrive dealt in, owing nothing, and take
 * the big blind when it comes round (`entry_hold = 'moved'`). `seat_change`
 * is the player's own once-per-stay table change from the Must Move Lobby:
 * they arrive as a new entrant who has agreed to post (`waiting` + agreed).
 *
 * A SWAP is two `seat_change` moves linked by `swap_move_id`: both chairs are
 * occupied, so neither can land alone. Each side is executed at its own
 * table's hand boundary through the same executor; the first to arrive is
 * told `waiting_partner` and holds its player out of the deal (`ready_at`),
 * the second lands both chairs in one transaction and reports the partner so
 * the other table can be told.
 */

import { supabase } from './client.js';
import { reportError } from '../errorReporter.js';

/**
 * A FOURTH REASON (Dan 2026-09-05): `balance`. The room evened the must-move
 * tables - "feeder games must be balanced, there shouldn't be 3 tables of 9
 * and one table of [3]". It is planned by fn_cash_cluster_balance and enters
 * the destination exactly as `must_move` and `break` do (entry_hold =
 * 'moved'), because it is the game moving the player, not the player asking.
 */
export type SeatMoveReason = 'must_move' | 'break' | 'seat_change' | 'balance';

export interface PendingSeatMove {
  move_id: string;
  player_id: string;
  to_table_id: string;
  to_table_name: string | null;
  to_role: string | null;
  to_main_index: number | null;
  reason: SeatMoveReason;
  /** Set by fn_cash_seat_move_announce when the from-table engine told the player. */
  announced_at: string | null;
  /** The linked move of a swap (the partner's, from the other table), else null. */
  swap_move_id: string | null;
  /** A swap side that has reached its hand boundary and is holding for its partner. */
  ready_at: string | null;
}

export interface ExecutedSeatMove {
  move_id: string;
  player_id: string;
  to_table_id: string;
  to_seat_number: number;
  stack: number;
  reason: SeatMoveReason;
  /** For a swap landed from this side: the partner who arrived here from the other table. */
  partner: {
    player_id: string;
    from_table_id: string;
    to_table_id: string;
    to_seat_number: number;
    stack: number;
  } | null;
}

export interface SeatMoveOutcome {
  done: ExecutedSeatMove[];
  /** Swap sides that reached their boundary first: hold these players out of the deal. */
  held: Array<{ move_id: string; player_id: string; to_table_id: string; partner_id: string }>;
  /**
   * Moves the executor ENDED without landing (2026-09-09, must-move audit):
   * the destination filled or closed, the swap partner vanished, the chair is
   * gone. The player was told "Moving After This Hand" at the deal and keeps
   * their chair; the engine tells them so. A transient (`transient`), the
   * freeze, a partner still to arrive and a move that had already landed are
   * NOT refusals and are never in this list.
   */
  refused: Array<{ move_id: string; player_id: string; reason: string }>;
}

/**
 * Executor answers that leave the move alive or already landed. Everything
 * else is terminal: the row is cancelled or expired and the player stays.
 *   - `transient`: 40P01 / 55P03 / 40001, the next boundary retries it;
 *   - `frozen` / `platform_frozen`: the :55 break, the thaw gives the window back;
 *   - `waiting_partner`: a swap side holding (handled as `held` above);
 *   - `done`: the receipt of a move that already landed (idempotent re-run).
 */
export const SEAT_MOVE_NON_TERMINAL_REASONS: ReadonlySet<string> = new Set([
  'transient',
  'frozen',
  'platform_frozen',
  'waiting_partner',
  'done',
]);

/**
 * The moves waiting on this table's next hand boundary.
 *
 * NULL MEANS "COULD NOT READ", AND IT IS NOT AN EMPTY LIST (2026-09-09,
 * must-move audit; CLAUDE.md 10.86 rule 2). This used to return `[]` on any
 * error, which every caller then read as "no moves pending" - and one of those
 * callers PRUNES state from the answer. `announcePendingSeatMoves` releases
 * every held swap side that is not in the list, and a held swap side is the
 * only thing keeping the first half of a swap OUT of the deal while the other
 * table's transaction stands ready to land both chairs. Release it on a failed
 * read, deal that player into a hand, and the partner's boundary moves them
 * mid-hand - the one thing the whole must-move design exists to prevent.
 *
 * So: an array is an answer, `null` is "I could not tell", and no caller may
 * change anything on a null.
 */
export async function pendingSeatMoves(tableId: string): Promise<PendingSeatMove[] | null> {
  const { data, error } = await supabase.rpc('fn_cash_seat_moves_pending', {
    p_table_id: tableId,
  });
  if (error) {
    reportError(error, 'seatMoves.pending_failed', { tableId });
    return null;
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
 * Execute the pending moves for this table. Returns the ones that landed and
 * the swap sides now holding for their partner; a refused move (destination
 * filled, player already gone, busted, frozen) is left for the controller to
 * re-plan and is not an error here.
 */
export async function executePendingSeatMoves(
  tableId: string,
  opts: ExecuteSeatMovesOptions = { announcedOnly: false },
  /**
   * Fresh candidates read at this same hand boundary, never cached. `null` is
   * a read that FAILED (see pendingSeatMoves) and executes nothing; `undefined`
   * means "read them yourself".
   */
  prefetched?: readonly PendingSeatMove[] | null
): Promise<SeatMoveOutcome> {
  const pending = prefetched === undefined ? await pendingSeatMoves(tableId) : prefetched;
  if (pending === null) return { done: [], held: [], refused: [] };
  const due = opts.announcedOnly ? pending.filter((m) => m.announced_at != null) : pending;
  const done: ExecutedSeatMove[] = [];
  const held: SeatMoveOutcome['held'] = [];
  const refused: SeatMoveOutcome['refused'] = [];
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
      held?: boolean;
      partner_id?: string;
      to_table_id?: string;
      to_seat_number?: number;
      stack?: number;
      swap?: boolean;
      partner?: {
        player_id: string;
        from_table_id: string;
        to_table_id: string;
        to_seat_number: number;
        stack: number;
      };
    };
    if (res.ok && res.to_table_id && typeof res.to_seat_number === 'number') {
      done.push({
        move_id: m.move_id,
        player_id: m.player_id,
        to_table_id: res.to_table_id,
        to_seat_number: res.to_seat_number,
        stack: Number(res.stack ?? 0),
        reason: m.reason,
        partner: res.partner
          ? {
              player_id: res.partner.player_id,
              from_table_id: res.partner.from_table_id,
              to_table_id: res.partner.to_table_id,
              to_seat_number: Number(res.partner.to_seat_number),
              stack: Number(res.partner.stack ?? 0),
            }
          : null,
      });
    } else if (res.reason === 'waiting_partner' && res.held) {
      held.push({
        move_id: m.move_id,
        player_id: m.player_id,
        to_table_id: res.to_table_id ?? m.to_table_id,
        partner_id: res.partner_id ?? '',
      });
    } else {
      const reason = res.reason ?? 'unknown';
      console.log(`[seatMoves:${tableId}] move ${m.move_id} for ${m.player_id} not executed: ${reason}`);
      if (!SEAT_MOVE_NON_TERMINAL_REASONS.has(reason)) {
        refused.push({ move_id: m.move_id, player_id: m.player_id, reason });
      }
    }
  }
  return { done, held, refused };
}

/**
 * What the player is told when a move they were promised did not happen. Title
 * case, no em dash, no question. The reason vocabulary is the executor's own
 * (`fn_cash_seat_move_execute` and the swap executor); anything unnamed gets
 * the general sentence, because every refusal has the same consequence for the
 * player: they keep the chair they are in.
 */
export function seatMoveCancelledNotice(reason: string): string {
  switch (reason) {
    case 'destination_full':
      return 'The Seat Was Taken. You Keep Your Chair.';
    case 'destination_unavailable':
      return 'That Table Has Closed. You Keep Your Chair.';
    case 'swap_partner_gone':
    case 'swap_cancelled':
      return 'The Seat Change Was Cancelled. You Keep Your Chair.';
    default:
      return 'Your Move Was Cancelled. You Keep Your Chair.';
  }
}

/** Where a move goes, in the player's words. */
export function seatMoveDestination(
  m: Pick<PendingSeatMove, 'to_role' | 'to_main_index' | 'to_table_name'>
): string {
  return m.to_role === 'main' && m.to_main_index
    ? `Main ${m.to_main_index}`
    : m.to_role === 'feeder'
      ? 'The Feeder Table'
      : (m.to_table_name ?? 'Your New Table');
}

/** The interstitial copy (OPORD 1.3 section 9.5). Title case, no em dash. */
export function seatMoveNotice(
  m: Pick<PendingSeatMove, 'to_role' | 'to_main_index' | 'to_table_name' | 'reason'> & {
    swap_move_id?: string | null;
  }
): string {
  const where = seatMoveDestination(m);
  if (m.reason === 'break') return `This Table Is Closing. Moving To ${where} After This Hand.`;
  if (m.reason === 'balance') {
    return `Balancing The Tables. Moving To ${where} After This Hand.`;
  }
  if (m.reason === 'seat_change') {
    return m.swap_move_id
      ? `Seat Change Granted. Swapping To ${where} After This Hand.`
      : `Seat Change Granted. Moving To ${where} After This Hand.`;
  }
  return `Seat Open On ${where}. Moving After This Hand.`;
}
