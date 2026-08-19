/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * HORSE SESSION ROTATOR — Humanlike Session Rhythms (V7 — 2026-07-24)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Before V7, horses sat down and never stood up: the fleet seeded seats and
 * only the 4-hour stale-seat cleanup ever emptied one. Real players play
 * SESSIONS — they rack up after a big win, quit after a rough stretch, or
 * simply leave when it is late. This service gives the fleet those rhythms.
 *
 * Every cycle it examines seated horses (cash tables only) and, with a small
 * probability shaped by session length and stack swing, has one stand up:
 *  - the longer the session, the likelier the departure (mean session ~75min)
 *  - doubling the buy-in makes "racking up" likelier; losing most of it
 *    makes "calling it a night" likelier
 *  - at most ONE departure per table per cycle and a global cap per cycle,
 *    so tables never drain — the HorseFleetManager reseeds a DIFFERENT horse
 *    within its 30s cycle, which is exactly the player-turnover a real room
 *    shows.
 *
 * V8 (2026-07-24) SESSION BEHAVIOR upgrades:
 *  - TOP-UPS: short-stacked horses reload toward a fresh buy-in through the
 *    engine's hand-boundary-safe addChips() (wallet-debited, queued if
 *    mid-hand). Wallet-empty horses silently keep playing the short stack —
 *    itself a human pattern.
 *  - SHORT BREAKS: occasionally one horse steps away for 2-5 minutes via the
 *    engine's deferred sit-out, then sits back in. Only at well-populated
 *    tables.
 *  - HUMAN-TABLE PROTECTION: tables with a human present are never thinned
 *    below 5 and absorb half the usual rotation pressure — horse-only tables
 *    do most of the rotating.
 *  - ACTIVITY WINDOWS: outside a horse's daily window (HorseBehavior) its
 *    session-end hazard rises, so the floor population follows daily rhythms.
 *
 * SAFETY: departures go through the SAME path a human uses —
 * ServerTableEngine.leaveTable() — which auto-folds if mid-hand and cashes
 * out at the end of the hand (leave_pending). No direct DB seat surgery, no
 * mid-pot corruption, ever. If a table has no live engine, it is skipped.
 *
 * NEVER refer to the horses as "bots" — they are HORSES only.
 */

import { supabase } from './supabase.js';
import { reportError } from './errorReporter.js';
import { isActiveNow } from './HorseBehavior.js';

const CYCLE_MS = 90_000; // examine the floor every 90s
const GLOBAL_DEPARTURES_PER_CYCLE = 4;
const MIN_SESSION_MINUTES = 20; // nobody hit-and-runs a 5-minute session
const MEAN_SESSION_MINUTES = 75;
// V8: session-behavior knobs
const TOPUP_MIN_MINUTES = 8; // no instant top-ups after sitting down
const TOPUP_STACK_FRAC = 0.45; // top up when below 45% of a standard buy-in
const TOPUP_PROB = 0.25; // per eligible horse per cycle
const BREAK_PROB = 0.35; // chance ONE horse somewhere takes a short break per cycle
const BREAK_MIN_MS = 2 * 60_000;
const BREAK_MAX_MS = 5 * 60_000;

/** Minimal engine surface the rotator needs (matches ServerTableEngine). */
export interface RotatorEngine {
  leaveTable(userId: string): { success: boolean; error?: string; immediate?: boolean };
  /** V8: hand-boundary-safe top-up (queued mid-hand; wallet-debited). */
  addChips?(
    userId: string,
    amount: number
  ): Promise<{ success: boolean; error?: string; queued?: boolean; applied?: number }>;
  /** V8: hand-boundary-safe sit-out/sit-back (folds deferred to hand end). */
  sitOut?(userId: string, sitOut: boolean): { success: boolean; error?: string };
}

export class HorseSessionRotator {
  private isRunning = false;
  private handle: ReturnType<typeof setInterval> | null = null;
  /**
   * V8: horses currently on a short break -> when to sit back in.
   *
   * 2026-08-19 MULTI-TABLE FIX: keyed by `${tableId}:${userId}`, NOT userId.
   * Horses multi-table (up to 4 tables). Keyed by user alone, a break started
   * at table B OVERWROTE a live break record at table A — table A's deferred
   * sit-out was then never sat back in, so the horse sat out at A forever
   * (until it happened to leave, or the process restarted). A session-end
   * departure at one table likewise deleted the break record belonging to a
   * DIFFERENT table, orphaning that sit-out the same way. The value carries
   * userId so the sit-back pass knows who to seat.
   */
  private breaks = new Map<string, { tableId: string; userId: string; sitBackAt: number }>();

  private static breakKey(tableId: string, userId: string): string {
    return `${tableId}:${userId}`;
  }

  constructor(private getEngine: (tableId: string) => RotatorEngine | undefined) {}

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.handle = setInterval(() => {
      this.rotate().catch((err) => reportError(err, 'HorseSessionRotator.cycle'));
    }, CYCLE_MS);
    console.log(`[SessionRotator] Running — humanlike departures every ${CYCLE_MS / 1000}s cycle`);
  }

  stop(): void {
    this.isRunning = false;
    if (this.handle) {
      clearInterval(this.handle);
      this.handle = null;
    }
  }

  private async rotate(): Promise<void> {
    // Seated horses at CASH tables with enough table population to spare one.
    const { data: seats, error } = await supabase
      .from('table_seats')
      .select(
        'table_id, user_id, seat_number, stack, joined_at, tables!inner(id, big_blind, tournament_id, status)'
      )
      .is('left_at', null)
      .limit(400);
    if (error || !seats) return;

    // Group by table; only consider cash tables with 4+ occupied seats so a
    // departure never threatens the game.
    const byTable = new Map<string, typeof seats>();
    for (const s of seats) {
      const t = (s as any).tables;
      if (!t || t.tournament_id || t.status === 'closed') continue;
      const arr = byTable.get(s.table_id) || [];
      arr.push(s);
      byTable.set(s.table_id, arr);
    }

    // Verify horse identity in one query.
    const userIds = [...new Set(seats.map((s) => s.user_id))];
    const { data: horses } = await supabase
      .from('profiles')
      .select('id')
      .in('id', userIds)
      .eq('is_horse', true);
    const horseIds = new Set((horses || []).map((h) => h.id));
    const hourUTC = new Date().getUTCHours();

    // V8: end any due short breaks FIRST — sitting a horse back in is never
    // rate-limited.
    for (const [key, info] of [...this.breaks]) {
      if (Date.now() < info.sitBackAt) continue;
      this.breaks.delete(key);
      try {
        this.getEngine(info.tableId)?.sitOut?.(info.userId, false);
      } catch (err) {
        reportError(err, 'HorseSessionRotator.sitBack');
      }
    }

    let departures = 0;
    let breakTaken = false;
    for (const [tableId, tableSeats] of byTable) {
      if (departures >= GLOBAL_DEPARTURES_PER_CYCLE) break;
      // V8: tables with a HUMAN present are protected harder — never thin a
      // human's game below 5, and horse-only tables absorb most rotation.
      const humanPresent = tableSeats.some((x) => !horseIds.has(x.user_id));
      if (tableSeats.length < (humanPresent ? 5 : 4)) continue;

      const engine = this.getEngine(tableId);
      if (!engine) continue; // no live engine — not our business

      // One candidate per table per cycle, chosen by highest leave pressure.
      let best: { seat: (typeof tableSeats)[number]; p: number } | null = null;
      for (const seat of tableSeats) {
        if (!horseIds.has(seat.user_id)) continue;
        const t = (seat as any).tables;
        const bb = Number(t?.big_blind) || 2;
        const buyIn = bb * 100;
        const minutes = (Date.now() - new Date(seat.joined_at).getTime()) / 60000;

        // V8 TOP-UPS: humans reload when short — so do (some) horses. Only
        // between-hands-safe engine path; wallet-empty horses silently skip,
        // which is itself a human pattern (the broke guy plays the short
        // stack). Never while on a break.
        const stackNow = Number(seat.stack) || 0;
        if (
          engine.addChips &&
          !this.breaks.has(HorseSessionRotator.breakKey(tableId, seat.user_id)) &&
          minutes >= TOPUP_MIN_MINUTES &&
          stackNow > 0 &&
          stackNow < buyIn * TOPUP_STACK_FRAC &&
          Math.random() < TOPUP_PROB
        ) {
          // V9: humans reload to ROUND figures (a fresh $200, "make it 150"),
          // so the top-up TARGET snaps to a 10bb step before the delta is
          // computed. The engine caps at the table max buy-in on its side.
          const step = bb * 10;
          const target = Math.round((buyIn * (0.85 + Math.random() * 0.3)) / step) * step;
          const amount = Math.round((target - stackNow) * 100) / 100;
          if (amount >= bb) {
            engine
              .addChips(seat.user_id, amount)
              .catch((err) => reportError(err, 'HorseSessionRotator.topUp'));
          }
        }

        if (minutes < MIN_SESSION_MINUTES) continue;

        // Base hazard: exponential session with ~MEAN_SESSION_MINUTES mean,
        // expressed per 90s cycle.
        let p = CYCLE_MS / 60000 / MEAN_SESSION_MINUTES;
        const stack = stackNow;
        const swing = stack / buyIn;
        if (swing >= 2)
          p *= 2.2; // doubled up — racking up is human
        else if (swing <= 0.35) p *= 1.8; // felted-ish — calling it a night
        if (minutes > 150) p *= 1.6; // long sessions wind down
        // V8: outside the horse's daily activity window, sessions end sooner.
        if (!isActiveNow(seat.user_id, hourUTC)) p *= 1.6;
        // V8: rotation prefers horse-only tables — humans keep a stable game.
        if (humanPresent) p *= 0.5;

        if (!best || p > best.p) best = { seat, p };
      }

      if (best && Math.random() < best.p) {
        try {
          const result = engine.leaveTable(best.seat.user_id);
          if (result.success) {
            departures++;
            // Only THIS table's break record — a break at another table is
            // still live and must still sit back in over there.
            this.breaks.delete(HorseSessionRotator.breakKey(tableId, best.seat.user_id));
            console.log(
              `[SessionRotator] horse=${best.seat.user_id.slice(0, 8)} leaving table=${tableId.slice(0, 8)} ` +
                `after session (stack=${best.seat.stack})`
            );
          }
        } catch (err) {
          reportError(err, 'HorseSessionRotator.leave');
        }
      } else if (
        // V8 SHORT BREAKS: at most ONE horse anywhere per cycle steps away
        // for 2-5 minutes (dealt out via the engine's deferred sit-out, then
        // sits back in). Only at well-populated tables so the game never
        // suffers, and never the table's only action.
        !breakTaken &&
        engine.sitOut &&
        best &&
        // Not already on break at THIS table (re-setting would silently
        // extend the sit-out and reset the sit-back clock).
        !this.breaks.has(HorseSessionRotator.breakKey(tableId, best.seat.user_id)) &&
        tableSeats.length >= (humanPresent ? 6 : 5) &&
        this.breaks.size < 2 &&
        Math.random() < BREAK_PROB / Math.max(1, byTable.size)
      ) {
        try {
          const res = engine.sitOut(best.seat.user_id, true);
          if (res.success) {
            breakTaken = true;
            this.breaks.set(HorseSessionRotator.breakKey(tableId, best.seat.user_id), {
              tableId,
              userId: best.seat.user_id,
              sitBackAt: Date.now() + BREAK_MIN_MS + Math.random() * (BREAK_MAX_MS - BREAK_MIN_MS),
            });
            console.log(
              `[SessionRotator] horse=${best.seat.user_id.slice(0, 8)} short break at table=${tableId.slice(0, 8)}`
            );
          }
        } catch (err) {
          reportError(err, 'HorseSessionRotator.break');
        }
      }
    }
  }
}
