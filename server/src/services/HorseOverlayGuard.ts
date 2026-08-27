/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MTT OVERLAY GUARD — Dan 2026-08-27, binding
 * ═══════════════════════════════════════════════════════════════════════════
 * "If any Midway Union MTT (that both Club JAQK and Shark Club are part of)
 *  is going to have an overlay, new horses start entering it (that aren't
 *  already in it) so no overlay occurs."
 *
 * An overlay is the club paying the difference when entries do not fund the
 * guarantee. Measured live the hour this was written: Union PKO Afternoon
 * needed 33 entries for its 600 guarantee and had 11; Afternoon Bounty needed
 * 22 and had 2. That is real money leaving the club every single cycle.
 *
 * WHAT THIS DOES
 * Every cycle it asks the database which guaranteed events are short
 * (fn_overlay_at_risk), and tops each one up to the entry count the guarantee
 * needs, through the SAME registration path the pre-start ramp uses
 * (TournamentRecurringService.topUpWithHorses). That path already:
 *   - counts who is genuinely registered, so horses ALREADY IN the event are
 *     never double-registered - "that aren't already in it", enforced by
 *     construction rather than by a second list;
 *   - draws only from the events/both game lanes, so cash-only horses are
 *     never pulled into a tournament;
 *   - respects the four-concurrent-table cap per horse;
 *   - refuses to exceed max_players.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   - Freerolls (buy-in 0) are excluded in the SQL: their prize is funded by
 *     the club by definition, so no number of entrants removes the shortfall,
 *     and stuffing horses in would only dilute a real player's equity.
 *   - It never removes or unregisters anyone.
 *   - It tops up to the guarantee, not to max_players: the goal is to erase
 *     the overlay, not to fill the room.
 *
 * HONESTY
 * Every cycle that acts LOGS what it did and every cycle that cannot act logs
 * why. fn_audit_overlays looks backward at events that already started and
 * raises a finding for any overlay that still happened, so a guard that
 * silently stops working shows up on the daily panel rather than in the
 * accounts.
 */

import { supabase } from './supabase/client.js';
import { reportError } from './errorReporter.js';
import { TournamentRecurringService } from './TournamentRecurringService.js';

/** Midway Union — the union Club JAQK and Shark Club belong to. */
export const MIDWAY_UNION_ID = 'fade0000-0000-0000-0000-000000000001';

const CYCLE_MS = 2 * 60_000;
const BOOT_DELAY_MS = 90_000;
/** Never add more than this many horses to one event in one cycle. */
const MAX_TOPUP_PER_CYCLE = 40;

let timer: NodeJS.Timeout | null = null;
let bootTimer: NodeJS.Timeout | null = null;
let running = false;
const seeder = new TournamentRecurringService();

export interface OverlayRisk {
  tournament_id: string;
  name: string;
  status: string;
  buy_in: number;
  guaranteed_prize: number;
  entries_needed: number;
  current_players: number;
  shortfall: number;
  max_players: number;
  minutes_to_start: number;
}

const enabled = (): boolean => process.env.HORSE_OVERLAY_GUARD_ENABLED !== 'false';

/** Pure: what to do about one at-risk event. Exported for tests. */
export function topUpTargetFor(risk: OverlayRisk): number {
  const needed = Math.max(0, Math.floor(risk.entries_needed));
  const cap = risk.max_players > 0 ? risk.max_players : needed;
  const target = Math.min(needed, cap);
  // Never ask for more than the per-cycle ceiling above the current field:
  // a huge guarantee on an empty board should fill over several cycles so a
  // single call cannot monopolise the free-horse pool.
  return Math.min(target, risk.current_players + MAX_TOPUP_PER_CYCLE);
}

export async function runOverlayGuardOnce(unionId: string = MIDWAY_UNION_ID): Promise<number> {
  if (running) return 0;
  running = true;
  let acted = 0;
  try {
    const { data, error } = await supabase.rpc('fn_overlay_at_risk', { p_union: unionId });
    if (error) throw new Error(error.message);
    const risks = (data ?? []) as OverlayRisk[];
    if (risks.length === 0) return 0;

    for (const risk of risks) {
      if (risk.shortfall <= 0) continue;
      const target = topUpTargetFor(risk);
      if (target <= risk.current_players) continue;
      const added = await seeder.topUpWithHorses(risk.tournament_id, target);
      acted += added;
      const overlay = risk.guaranteed_prize - risk.current_players * risk.buy_in;
      if (added > 0) {
        console.log(
          `[HorseOverlayGuard] ${risk.name}: ${risk.current_players}/${risk.entries_needed} entries ` +
            `(${overlay.toFixed(2)} overlay at risk, starts in ${risk.minutes_to_start}m) - ` +
            `registered ${added} horse(s) toward ${target}`
        );
      } else {
        // A top-up that adds nobody is the failure mode that matters: the
        // event still overlays and nothing else would say so.
        console.warn(
          `[HorseOverlayGuard] ${risk.name}: needed ${risk.shortfall} more entries and added NONE ` +
            `- the events/both lane pool may be exhausted or every candidate is at the ` +
            `four-table cap. Overlay still exposed: ${overlay.toFixed(2)}`
        );
      }
    }
    return acted;
  } catch (err) {
    reportError(err, 'HorseOverlayGuard.run');
    return acted;
  } finally {
    running = false;
  }
}

export function startHorseOverlayGuard(): void {
  if (timer || !enabled()) return;
  timer = setInterval(() => {
    void runOverlayGuardOnce().catch((err: unknown) => reportError(err, 'HorseOverlayGuard.tick'));
  }, CYCLE_MS);
  timer.unref?.();
  bootTimer = setTimeout(() => {
    void runOverlayGuardOnce().catch((err: unknown) => reportError(err, 'HorseOverlayGuard.boot'));
  }, BOOT_DELAY_MS);
  bootTimer.unref?.();
  console.log(
    '[HorseOverlayGuard] started - Midway Union guaranteed events checked every 2 minutes'
  );
}

export function stopHorseOverlayGuard(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (bootTimer) {
    clearTimeout(bootTimer);
    bootTimer = null;
  }
}
