/**
 * THE SEAT CHANGE, ASKED FOR BY THE ENGINE (CLAUDE.md 10.5, 2026-09-05).
 *
 * `seatMoves.ts` next door is the engine EXECUTING a move somebody else
 * planned. This is the other direction: a player ASKING to be moved, which
 * until today only a browser could do.
 *
 * IT IS THE SAME DOOR THE CLIENT USES. `src/services/cashGameLobby.ts` calls
 * `supabase.rpc('fn_cash_seat_change_request', { p_game_id, p_to_table_id })`
 * and so does this, with one extra argument. There is deliberately no
 * horse-specific RPC, no "seed a request" helper and no direct write to
 * `cash_seat_change_requests`: every rule the door enforces - once per roster
 * row, never from Main 1, never to Main 1, not while a move is pending, not
 * on a breaking table, not during the maintenance freeze - is enforced for a
 * horse because it is the same function. A parallel path is how a horse ends
 * up with a different deal, which is the thing 10.5 forbids.
 *
 * `p_user_id` is honoured only when `fn_caller_is_engine()` (migration
 * 20260905064237). A browser passing somebody else's id is ignored.
 *
 * A REFUSAL IS AN ANSWER, NOT AN ERROR. The door RAISEs for every refusal, so
 * a refusal arrives here as `error`. It is returned as a named reason for the
 * caller to record and act on ONCE - never as something to retry in a loop,
 * which is the whole reason this returns a reason instead of a boolean.
 */

import { supabase } from './client.js';
import { reportError } from '../errorReporter.js';

export interface SeatChangeRequestResult {
  ok: boolean;
  /**
   * What the game did with it: 'moving' (a chair was free, the move is
   * planned), 'swapping' (paired with somebody wanting this table),
   * 'listed' (first on that table's list), or 'none'.
   */
  action: string | null;
  /** The refusal, e.g. SEAT_CHANGE_USED, MOVE_PENDING, PLATFORM_FROZEN. */
  reason: string | null;
  /** Position on the list when action is 'listed'. */
  position: number | null;
}

/**
 * The refusal codes the door raises. Extracted from the message rather than
 * guessed: every one is `CODE: human sentence`, so the code is everything
 * before the first colon.
 */
export function seatChangeRefusalCode(message: string | null | undefined): string {
  const m = /^([A-Z][A-Z0-9_]{3,})\s*:/.exec(String(message ?? '').trim());
  return m ? m[1] : 'unknown';
}

/**
 * Ask for this player's once-per-stay seat change.
 *
 * `toTableId` null means "any table but Main 1", which is what the client's
 * own Request Any Table button sends. An ordinary refusal is NOT reported to
 * error reporting - a horse being told SEAT_CHANGE_NO_OTHER_TABLE is the system
 * working - but an unexpected failure is, because a door that has started
 * refusing everybody is worth knowing about.
 */
export async function requestSeatChangeFor(
  gameId: string,
  userId: string,
  toTableId: string | null = null
): Promise<SeatChangeRequestResult> {
  const { data, error } = await supabase.rpc('fn_cash_seat_change_request', {
    p_game_id: gameId,
    p_to_table_id: toTableId,
    p_user_id: userId,
  });
  if (error) {
    const reason = seatChangeRefusalCode(error.message);
    if (reason === 'unknown') {
      reportError(error, 'seatChange.request_failed', { gameId, userId, toTableId });
    }
    return { ok: false, action: null, reason, position: null };
  }
  const res = (data ?? {}) as { ok?: boolean; action?: string; position?: number | null };
  return {
    ok: res.ok === true,
    action: res.action ?? null,
    reason: null,
    position: typeof res.position === 'number' ? res.position : null,
  };
}
