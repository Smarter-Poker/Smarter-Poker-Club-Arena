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
 * SAFETY: departures go through the SAME path a human uses —
 * ServerTableEngine.leaveTable() — which auto-folds if mid-hand and cashes
 * out at the end of the hand (leave_pending). No direct DB seat surgery, no
 * mid-pot corruption, ever. If a table has no live engine, it is skipped.
 *
 * NEVER refer to the horses as "bots" — they are HORSES only.
 */

import { supabase } from './supabase.js';
import { reportError } from './errorReporter.js';

const CYCLE_MS = 90_000; // examine the floor every 90s
const GLOBAL_DEPARTURES_PER_CYCLE = 4;
const MIN_SESSION_MINUTES = 20; // nobody hit-and-runs a 5-minute session
const MEAN_SESSION_MINUTES = 75;

/** Minimal engine surface the rotator needs (matches ServerTableEngine). */
export interface RotatorEngine {
  leaveTable(userId: string): { success: boolean; error?: string; immediate?: boolean };
}

export class HorseSessionRotator {
  private isRunning = false;
  private handle: ReturnType<typeof setInterval> | null = null;

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
      .select('table_id, user_id, seat_number, stack, joined_at, tables!inner(id, big_blind, tournament_id, status)')
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

    let departures = 0;
    for (const [tableId, tableSeats] of byTable) {
      if (departures >= GLOBAL_DEPARTURES_PER_CYCLE) break;
      if (tableSeats.length < 4) continue; // never thin a short-handed game

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
        if (minutes < MIN_SESSION_MINUTES) continue;

        // Base hazard: exponential session with ~MEAN_SESSION_MINUTES mean,
        // expressed per 90s cycle.
        let p = (CYCLE_MS / 60000) / MEAN_SESSION_MINUTES;
        const stack = Number(seat.stack) || 0;
        const swing = stack / buyIn;
        if (swing >= 2) p *= 2.2; // doubled up — racking up is human
        else if (swing <= 0.35) p *= 1.8; // felted-ish — calling it a night
        if (minutes > 150) p *= 1.6; // long sessions wind down

        if (!best || p > best.p) best = { seat, p };
      }

      if (best && Math.random() < best.p) {
        try {
          const result = engine.leaveTable(best.seat.user_id);
          if (result.success) {
            departures++;
            console.log(
              `[SessionRotator] horse=${best.seat.user_id.slice(0, 8)} leaving table=${tableId.slice(0, 8)} ` +
                `after session (stack=${best.seat.stack})`
            );
          }
        } catch (err) {
          reportError(err, 'HorseSessionRotator.leave');
        }
      }
    }
  }
}
