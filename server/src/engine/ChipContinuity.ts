/**
 * CHIP CONTINUITY - the engine's side of the stay clock (Operation Table
 * Stakes, Slice 0; OPORD 1.3 section 6).
 *
 * THE RULE, in the words a player is allowed to read (section 6.1):
 *   Chips on the table stay on the table until you leave. If you are ahead of
 *   the money you put in, you remain seated for 10 minutes before you can
 *   leave. If you return to the same game in this club within 2 hours, you
 *   buy in for at least the stack you left with.
 *
 * WHERE THE TRUTH IS. The database (cash_player_session) owns the baseline,
 * the remaining time and whether the clock is running; the engine restarts at
 * :55 of every hour and must not own a clock. This module is a MIRROR: it
 * keeps the last row the database returned per player and derives the live
 * countdown from that row's `stay_last_tick_at`, exactly as the database
 * does. Every transition the engine can see - a hand settled, a sit-out, a
 * disconnect, an add-on - is reported through `evaluate`, and the row the
 * database answers with replaces the mirror.
 *
 * WHAT IT NEVER DOES. It never decides a leave on its own authority. A leave
 * the mirror thinks is allowed still goes through atomic_seat_cashout_locked
 * with p_leave_mode = 'voluntary', where the database checks again under the
 * seat lock. The mirror exists so the engine can answer POST /leave
 * synchronously with the right label and so the broadcast can carry the
 * countdown; the RPC is what makes a forged or stale leave impossible.
 *
 * NO FORBIDDEN WORDS. Nothing in this file may reach a client string except
 * the label produced by leaveLabel(). Internal names only.
 */

import type { CashSessionEntry, CashSessionRow } from '../services/supabase/cashSessions.js';

export const STAY_CLOCK_DEFAULT_MS = 600_000;

/** The remaining stay clock as of `nowMs`, derived the way the database derives it. */
export function stayRemainingMs(
  row: Pick<CashSessionRow, 'stay_remaining_ms' | 'stay_running' | 'stay_last_tick_at'>,
  nowMs: number
): number {
  const base = Math.max(0, Math.floor(row.stay_remaining_ms || 0));
  if (!row.stay_running) return base;
  const tick = Date.parse(row.stay_last_tick_at);
  if (!Number.isFinite(tick)) return base;
  return Math.max(0, base - Math.max(0, nowMs - tick));
}

/** I5: in profit AND time remaining, whether or not the clock is currently ticking. */
export function isLeaveLocked(
  row: Pick<
    CashSessionRow,
    'baseline' | 'stack' | 'stay_remaining_ms' | 'stay_running' | 'stay_last_tick_at'
  >,
  stackNow: number,
  nowMs: number
): boolean {
  return stackNow > row.baseline && stayRemainingMs(row, nowMs) > 0;
}

/** "Leave Available In M:SS" - the only copy the leave control shows while locked. */
export function leaveLabel(remainingMs: number): string {
  const totalSec = Math.max(0, Math.ceil(remainingMs / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `Leave Available In ${m}:${s < 10 ? '0' : ''}${s}`;
}

export interface ContinuitySeatFields {
  session_baseline: number;
  stay_remaining_ms: number;
  stay_running: boolean;
  leave_locked: boolean;
}

export interface ChipContinuityDeps {
  tableId: string;
  /** Tournament tables have no stay clock; the tracker is inert for them. */
  isCash: () => boolean;
  /** Never evaluate during the maintenance freeze (CLAUDE.md section 13 rule 5). */
  isFrozen: () => boolean;
  /** Exact engine/process authority for reflecting an awaited database answer. */
  canMutate?: () => boolean;
  evaluate: (tableId: string, entries: CashSessionEntry[]) => Promise<CashSessionRow[] | null>;
  report: (err: unknown, context: string) => void;
}

export class ChipContinuityTracker {
  private readonly rows = new Map<string, CashSessionRow>();
  /** Last `active` value sent per player; a change is a transition worth a round trip. */
  private readonly lastActive = new Map<string, boolean>();
  /**
   * Seats that left (cashed out, evicted, kicked). The hand roster keeps them
   * until the next reload, and the database returns nothing for a vacated
   * seat, so without this the sweep re-sent every departed seat on every
   * tick until the next hand. Cleared the moment the roster stops naming them.
   */
  private readonly departed = new Set<string>();
  /** The platform was frozen at the last sweep; the thaw shifted every clock. */
  private sawFrozen = false;
  private inflight: Promise<void> | null = null;

  constructor(private readonly deps: ChipContinuityDeps) {}

  /** The mirror row, if the database has ever answered for this player. */
  row(userId: string): CashSessionRow | undefined {
    return this.rows.get(userId);
  }

  /**
   * Synchronous answer for POST /leave. `stackNow` is the engine's live stack
   * (post-settlement between hands; the roster's stack mid-hand). Unknown
   * player -> not locked: the database still checks under the seat lock.
   */
  leaveLock(
    userId: string,
    stackNow: number,
    nowMs = Date.now()
  ): { locked: boolean; remainingMs: number } {
    const row = this.rows.get(userId);
    if (!row || !this.deps.isCash()) return { locked: false, remainingMs: 0 };
    const remaining = stayRemainingMs(row, nowMs);
    return { locked: isLeaveLocked(row, stackNow, nowMs), remainingMs: remaining };
  }

  /** Fields every state payload carries per seat. */
  seatFields(userId: string, stackNow: number, nowMs = Date.now()): ContinuitySeatFields {
    const row = this.rows.get(userId);
    if (!row || !this.deps.isCash()) {
      return {
        session_baseline: 0,
        stay_remaining_ms: 0,
        stay_running: false,
        leave_locked: false,
      };
    }
    const remaining = stayRemainingMs(row, nowMs);
    return {
      session_baseline: row.baseline,
      stay_remaining_ms: remaining,
      stay_running: row.stay_running && remaining > 0 && stackNow > row.baseline,
      leave_locked: isLeaveLocked(row, stackNow, nowMs),
    };
  }

  /** The seat is gone (cashed out, evicted): forget the mirror. */
  forget(userId: string): void {
    this.rows.delete(userId);
    this.lastActive.delete(userId);
    this.departed.add(userId);
  }

  /** A new seat for a player the mirror had written off (re-buy before the roster reload). */
  welcome(userId: string): void {
    this.departed.delete(userId);
    this.lastActive.delete(userId);
  }

  /** A refusal came back from the database with a remaining time: trust it over the mirror. */
  noteRefusal(userId: string, stayRemainingMs: number, nowMs = Date.now()): void {
    const row = this.rows.get(userId);
    if (!row) return;
    this.rows.set(userId, {
      ...row,
      stay_remaining_ms: stayRemainingMs,
      stay_last_tick_at: new Date(nowMs).toISOString(),
    });
  }

  /**
   * Report transitions. Serialised per table so two overlapping settlements
   * cannot interleave their answers; a frozen platform is skipped outright.
   */
  async evaluate(entries: CashSessionEntry[]): Promise<void> {
    if (!this.deps.isCash() || entries.length === 0) return;
    if (this.deps.isFrozen()) return;
    const run = async () => {
      try {
        const rows = await this.deps.evaluate(this.deps.tableId, entries);
        if (!rows || this.deps.canMutate?.() === false) return;
        for (const r of rows) if (!this.departed.has(r.user_id)) this.rows.set(r.user_id, r);
        for (const e of entries)
          if (!this.departed.has(e.user_id)) this.lastActive.set(e.user_id, e.active);
      } catch (err) {
        this.deps.report(err, `ChipContinuity.${this.deps.tableId}.evaluate_failed`);
      }
    };
    const prev = this.inflight ?? Promise.resolve();
    const next = prev.then(run, run);
    this.inflight = next;
    try {
      await next;
    } finally {
      if (this.inflight === next) this.inflight = null;
    }
  }

  /**
   * Presence sweep, called from the 10-second heartbeat tick. Sends only the
   * players whose `active` changed since the last report - plus anyone the
   * mirror has never seen, which after a restart is everyone at the table,
   * and is how every seat gets a session row and a countdown back.
   */
  sweepPresence(
    players: Array<{ user_id: string }>,
    isActive: (userId: string) => boolean
  ): Promise<void> {
    if (!this.deps.isCash()) return Promise.resolve();
    // The thaw (fn_thaw_platform) moved every running clock by the frozen
    // minutes. The mirror did not move with it, so the first sweep after a
    // freeze re-sends everyone and adopts the database's answer.
    if (this.deps.isFrozen()) {
      this.sawFrozen = true;
      return Promise.resolve();
    }
    if (this.sawFrozen) {
      this.sawFrozen = false;
      this.lastActive.clear();
    }
    const present = new Set(players.map((p) => p.user_id));
    for (const id of [...this.departed]) if (!present.has(id)) this.departed.delete(id);
    const entries: CashSessionEntry[] = [];
    for (const p of players) {
      if (this.departed.has(p.user_id)) continue;
      const active = isActive(p.user_id);
      const known = this.rows.has(p.user_id);
      if (!known || this.lastActive.get(p.user_id) !== active) {
        // No stack: mid-hand the engine's roster copy is the pre-hand stack
        // and so is table_seats.stack, so let the database read its own row.
        entries.push({ user_id: p.user_id, active });
      }
    }
    // Players who left the roster take their mirror with them.
    for (const id of [...this.rows.keys()]) if (!present.has(id)) this.forget(id);
    return this.evaluate(entries);
  }
}
