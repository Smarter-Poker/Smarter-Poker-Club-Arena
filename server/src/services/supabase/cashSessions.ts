/**
 * Supabase helpers - CHIP CONTINUITY (Operation Table Stakes, Slice 0).
 *
 * The stay clock and the rejoin floor live in Postgres (migration
 * 20260904120000_chip_continuity_slice_0). The engine is not the source of
 * truth for either; it is the thing that tells the database when a player's
 * state changed (a hand settled, a sit-out, a disconnect) and it renders what
 * the database answers. That is deliberate: the engine restarts at :55 of
 * every hour, and a clock kept in engine memory would reset with it.
 *
 * Two calls:
 *   evaluateCashSessions  - "here is each seated player's stack and whether
 *                            they are active; settle their clocks". One round
 *                            trip for a whole table.
 *   atomicCashoutVoluntary - the ONE cash-out RPC with p_leave_mode set to
 *                            'voluntary', which is the only engine call the
 *                            database enforces the stay clock on. A refusal
 *                            comes back typed, not swallowed, so the caller
 *                            can leave the seat exactly as it was.
 */

import { supabase } from './client.js';
import { atomicCashout } from './seats.js';

export interface CashSessionRow {
  user_id: string;
  baseline: number;
  stack: number;
  stay_remaining_ms: number;
  stay_running: boolean;
  /** ISO timestamp the database stamped when it settled the clock. */
  stay_last_tick_at: string;
  stay_clock_ms: number;
  leave_locked: boolean;
}

export interface CashSessionEntry {
  user_id: string;
  /** Omit to let the database read table_seats.stack. */
  stack?: number;
  /** seated AND not sitting out AND connected AND not pending a move. */
  active: boolean;
}

function toRow(raw: unknown): CashSessionRow | null {
  const o = (raw ?? {}) as Record<string, unknown>;
  const userId = typeof o.user_id === 'string' ? o.user_id : '';
  if (!userId) return null;
  return {
    user_id: userId,
    baseline: Number(o.baseline ?? 0),
    stack: Number(o.stack ?? 0),
    stay_remaining_ms: Number(o.stay_remaining_ms ?? 0),
    stay_running: o.stay_running === true,
    stay_last_tick_at: typeof o.stay_last_tick_at === 'string' ? o.stay_last_tick_at : '',
    stay_clock_ms: Number(o.stay_clock_ms ?? 600000),
    leave_locked: o.leave_locked === true,
  };
}

/**
 * Settle and re-evaluate the stay clock for these players. Cash tables only
 * (the RPC returns [] for a tournament table). A transport failure returns
 * null so the caller keeps whatever it last knew rather than clearing it.
 */
export async function evaluateCashSessions(
  tableId: string,
  entries: CashSessionEntry[]
): Promise<CashSessionRow[] | null> {
  if (entries.length === 0) return [];
  try {
    const { data, error } = await supabase.rpc('fn_cash_session_evaluate', {
      p_table_id: tableId,
      p_entries: entries.map((e) => ({
        user_id: e.user_id,
        stack: typeof e.stack === 'number' && Number.isFinite(e.stack) ? e.stack : null,
        active: e.active === true,
      })),
    });
    if (error) {
      console.warn(`[cashSessions] evaluate failed for ${tableId.slice(0, 8)}: ${error.message}`);
      return null;
    }
    const arr = Array.isArray(data) ? data : [];
    return arr.map(toRow).filter((r): r is CashSessionRow => r !== null);
  } catch (err: any) {
    console.warn(
      `[cashSessions] evaluate transport failure for ${tableId.slice(0, 8)}:`,
      err?.message
    );
    return null;
  }
}

export type VoluntaryCashoutResult =
  | { ok: true; stack: number }
  | { ok: false; code: 'LEAVE_LOCKED'; stayRemainingMs: number }
  | { ok: false; code: 'FAILED'; message: string };

/**
 * The player's OWN choice to leave: POST /leave, the horse rotator, a
 * leave_pending seat at settlement. The database refuses it while the stay
 * clock runs, and that refusal is returned as a value. The seat is untouched
 * on every non-ok path (one transaction: the credit and the vacate roll back
 * together), so the caller must NOT fall back to markSeatAsLeft - that is the
 * same RPC and would be refused for the same reason.
 *
 * One implementation of "cash a seat out" (seats.guard.test.ts): this is a
 * typed view over `atomicCashout`, not a second caller of the RPC.
 */
export async function atomicCashoutVoluntary(
  userId: string,
  tableId: string,
  seatNumber: number,
  occupancyId: string | undefined
): Promise<VoluntaryCashoutResult> {
  const out: { locked: number | null; failed: string | null } = { locked: null, failed: null };
  const stack = await atomicCashout(userId, tableId, seatNumber, {
    occupancyId,
    leaveMode: 'voluntary',
    onLocked: (ms) => {
      out.locked = ms;
    },
    onFailed: (m) => {
      out.failed = m;
    },
  });
  if (out.locked !== null) return { ok: false, code: 'LEAVE_LOCKED', stayRemainingMs: out.locked };
  if (out.failed !== null) return { ok: false, code: 'FAILED', message: out.failed };
  return { ok: true, stack };
}
