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
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FREEROLLS - Dan 2026-08-27, correcting an earlier decision of mine
 * ═══════════════════════════════════════════════════════════════════════════
 * "All horses, IF THEY ARE PLAYING, should play the freeroll. All real
 *  players would. So if a horse is online and playing they should always
 *  register for the freeroll."
 *
 * The first cut of this file EXCLUDED freerolls, reasoning that their prize
 * is club-funded so entrants cannot remove the shortfall, and that adding
 * horses would dilute a human's equity. Both statements are true and the
 * conclusion was still wrong, because it answered an accounting question
 * when the real one is behavioural: nobody skips free money. A freeroll
 * sitting at 4 of 50 does not read as a quiet game, it reads as a dead room
 * - and that is what a human sees before deciding whether this site has
 * players on it. Measured when Dan raised it: "$100 Freeroll" 24 of 500,
 * "Coffee Break Freeroll" 4 of 50.
 *
 * So freerolls fill toward capacity from EVERY lane - the lane split is a
 * cash-versus-events personality and free money is neither. Eligibility is
 * "is this horse inside its activity window right now", the literal reading
 * of "if they are playing", plus the same four-table cap every path honours.
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
let lifecycleGeneration = 0;
let lifecycleActive = false;
let stopOperation: Promise<void> | null = null;
const inFlightCycles = new Set<Promise<void>>();
const seeder = new TournamentRecurringService();

export interface HorseOverlayGuardHandle {
  stop(): Promise<void>;
}

const guardHandle: HorseOverlayGuardHandle = Object.freeze({
  stop: () => stopHorseOverlayGuard(),
});

export interface OverlayRisk {
  tournament_id: string;
  name: string;
  status: string;
  buy_in: number;
  guaranteed_prize: number;
  entries_needed: number;
  current_players: number;
  shortfall: number;
  max_players: number | null;
  minutes_to_start: number;
}

const enabled = (): boolean => process.env.HORSE_OVERLAY_GUARD_ENABLED !== 'false';

/** Pure: what to do about one at-risk event. Exported for tests. */
export function topUpTargetFor(risk: OverlayRisk): number {
  const needed = Math.max(0, Math.floor(risk.entries_needed));
  const cap = risk.max_players === null ? needed : Math.max(0, risk.max_players);
  const target = Math.min(needed, cap);
  // Never ask for more than the per-cycle ceiling above the current field:
  // a huge guarantee on an empty board should fill over several cycles so a
  // single call cannot monopolise the free-horse pool.
  return Math.min(target, risk.current_players + MAX_TOPUP_PER_CYCLE);
}

export interface FreerollTarget {
  tournament_id: string;
  name: string;
  status: string;
  current_players: number;
  max_players: number | null;
  minutes_to_start: number;
}

/** Pure: how full should this freeroll be right now? Exported for tests. */
export function freerollTargetFor(t: FreerollTarget): number {
  const cap = t.max_players === null
    ? t.current_players + MAX_TOPUP_PER_CYCLE
    : Math.max(0, Math.floor(t.max_players));
  if (cap === 0) return 0;
  // Fill toward capacity, but never add more than the per-cycle ceiling at
  // once: a 500-seat freeroll fills over several cycles rather than draining
  // every free horse on the estate in one call and emptying the cash room.
  return Math.min(cap, t.current_players + MAX_TOPUP_PER_CYCLE);
}

/**
 * Register currently-playing horses into open freerolls, up to capacity.
 * Uses the allLanes override: free money is not a lane decision.
 */
export async function fillFreerollsOnce(
  unionId: string = MIDWAY_UNION_ID,
  shouldContinue: () => boolean = () => true
): Promise<number> {
  let added = 0;
  try {
    if (!shouldContinue()) return added;
    const { data, error } = await supabase.rpc('fn_freeroll_fill_targets', { p_union: unionId });
    if (!shouldContinue()) return added;
    if (error) throw new Error(error.message);
    const targets = (data ?? []) as FreerollTarget[];
    for (const t of targets) {
      if (!shouldContinue()) return added;
      const target = freerollTargetFor(t);
      if (target <= t.current_players) continue;
      const n = await seeder.topUpWithHorses(t.tournament_id, target, { allLanes: true });
      added += n;
      if (!shouldContinue()) return added;
      if (n > 0) {
        console.log(
          `[HorseOverlayGuard] freeroll ${t.name}: ${t.current_players}/${t.max_players} ` +
            `(starts in ${t.minutes_to_start}m) - registered ${n} horse(s) toward ${target}`
        );
      } else {
        console.warn(
          `[HorseOverlayGuard] freeroll ${t.name} wanted ${target - t.current_players} more and ` +
            `added NONE - every candidate is outside its activity window or at the four-table cap`
        );
      }
    }
    return added;
  } catch (err) {
    reportError(err, 'HorseOverlayGuard.freerolls');
    return added;
  }
}

export async function runOverlayGuardOnce(
  unionId: string = MIDWAY_UNION_ID,
  shouldContinue: () => boolean = () => true
): Promise<number> {
  if (running) return 0;
  running = true;
  let acted = 0;
  try {
    if (!shouldContinue()) return acted;
    const { data, error } = await supabase.rpc('fn_overlay_at_risk', { p_union: unionId });
    if (!shouldContinue()) return acted;
    if (error) throw new Error(error.message);
    const risks = (data ?? []) as OverlayRisk[];
    if (risks.length === 0) return 0;

    for (const risk of risks) {
      if (!shouldContinue()) return acted;
      if (risk.shortfall <= 0) continue;
      const target = topUpTargetFor(risk);
      if (target <= risk.current_players) continue;
      const added = await seeder.topUpWithHorses(risk.tournament_id, target);
      acted += added;
      if (!shouldContinue()) return acted;
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

/** One full cycle: guaranteed events first, then freerolls. */
export async function runEventFillCycle(
  unionId: string = MIDWAY_UNION_ID,
  shouldContinue: () => boolean = () => true
): Promise<number> {
  const guaranteed = await runOverlayGuardOnce(unionId, shouldContinue);
  if (!shouldContinue()) return guaranteed;
  const freerolls = await fillFreerollsOnce(unionId, shouldContinue);
  return guaranteed + freerolls;
}

function lifecycleIsCurrent(generation: number): boolean {
  return lifecycleActive && lifecycleGeneration === generation;
}

function launchOwnedCycle(context: string): void {
  const generation = lifecycleGeneration;
  if (!lifecycleIsCurrent(generation) || inFlightCycles.size > 0) return;

  let tracked!: Promise<void>;
  tracked = (async () => {
    if (!lifecycleIsCurrent(generation)) return;
    await runOverlayGuardOnce(MIDWAY_UNION_ID, () => lifecycleIsCurrent(generation));
    // Shutdown revokes this scheduler between its two independent mutation
    // passes. The already-started pass is joined by stop(); the second one is
    // never launched by a stale generation.
    if (!lifecycleIsCurrent(generation)) return;
    await fillFreerollsOnce(MIDWAY_UNION_ID, () => lifecycleIsCurrent(generation));
  })()
    .catch((err: unknown) => reportError(err, context))
    .finally(() => inFlightCycles.delete(tracked));
  inFlightCycles.add(tracked);
}

async function drainOwnedCycles(): Promise<void> {
  // Fixed point rather than one snapshot: a promise can settle and enqueue a
  // final continuation in the same turn. stop() does not resolve until the
  // owned set is observably empty.
  while (inFlightCycles.size > 0) {
    await Promise.allSettled([...inFlightCycles]);
  }
}

export function startHorseOverlayGuard(): HorseOverlayGuardHandle | null {
  if (timer || bootTimer || lifecycleActive || !enabled()) return null;
  lifecycleActive = true;
  lifecycleGeneration += 1;
  stopOperation = null;
  timer = setInterval(() => {
    launchOwnedCycle('HorseOverlayGuard.tick');
  }, CYCLE_MS);
  timer.unref?.();
  bootTimer = setTimeout(() => {
    bootTimer = null;
    launchOwnedCycle('HorseOverlayGuard.boot');
  }, BOOT_DELAY_MS);
  bootTimer.unref?.();
  console.log(
    '[HorseOverlayGuard] started - guaranteed events topped to their guarantee and freerolls filled from every lane, every 2 minutes'
  );
  return guardHandle;
}

export function stopHorseOverlayGuard(): Promise<void> {
  if (stopOperation) return stopOperation;
  lifecycleActive = false;
  lifecycleGeneration += 1;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (bootTimer) {
    clearTimeout(bootTimer);
    bootTimer = null;
  }
  stopOperation = drainOwnedCycles();
  return stopOperation;
}
