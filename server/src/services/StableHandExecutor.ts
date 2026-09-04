/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  OPERATION STABLE HAND - the executor, and it only does ONE thing
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `planFloor` decides everything: seat, stand, open, close. This executes
 * exactly one of those decisions - `stand` orders whose reason is
 * `human_yield` - and deliberately ignores the rest.
 *
 * WHY ONLY ONE. The seating loop in HorseFleetManager is exercised every 30
 * seconds against real money and survived three separate incidents to reach
 * its current shape. The blast radius of a bug in a new controller driving it
 * is the whole cash floor; the 2026-08-31 outage emptied that floor for forty
 * minutes from a change smaller than this one. A yield is the safe first
 * order to hand over because it is the only one that can only ever REMOVE a
 * horse from a seat a human is queuing for. It cannot overshoot occupancy, it
 * cannot open a table, it cannot spend a chip, and its worst failure is that
 * a seat opens that did not have to.
 *
 * The rest of the plan stays reported-only in GET /stable-hand until a human
 * has watched this one run on the live floor.
 *
 * HOW A HORSE IS STOOD UP. Through `engine.leaveTable(userId)` - the SAME
 * door a human's Leave Table button opens. It auto-folds if the horse is mid
 * hand, flags the seat `leave_pending`, and cashes out at settlement through
 * `atomic_seat_cashout_locked`. This module NEVER touches `table_seats`, never
 * calls `atomicCashout` directly, and never deletes a seat row: deleting one
 * skips the refund and destroys the chips (CLAUDE.md 11.5 rule 3). If a table
 * has no live engine it is skipped, exactly as HorseSessionRotator does.
 *
 * HORSES ARE PLAYERS (CLAUDE.md 10.5). A yield is not a punishment and not a
 * horse-only mechanism - it is the room making space, and the horse leaves
 * through the same door, at the same hand boundary, with the same cash-out as
 * anybody else. The stagger below exists for the same reason: a table that
 * empties the instant a human joins the list tells every watching player which
 * seats were horses.
 */

import { isMaintenanceFrozen } from '../maintenance/freezeState.js';
import { reportError } from './errorReporter.js';
import { controllerEnabled } from './StableHand.js';
import { planFloor, type FloorSnapshot, type StandOrder } from './StableHandController.js';
import { buildFloorSnapshot } from './StableHandSnapshot.js';

/** The engine surface a yield needs. Matches ServerTableEngine. */
export interface YieldEngine {
  leaveTable(userId: string): { success: boolean; error?: string; immediate?: boolean };
}

export const STABLE_HAND_CYCLE_MS = 30_000;

/**
 * How long a yield order for the same (table, horse) is not re-issued.
 *
 * `leaveTable` on a horse that is mid-hand does not free the seat: it flags
 * the row `leave_pending` and settlement finishes the job. The horse is still
 * seated in the next snapshot, so the plan asks for the same yield again.
 * Re-issuing would queue another auto_fold every cycle for as long as the hand
 * runs. Two minutes is comfortably longer than any cash hand.
 */
export const YIELD_COOLDOWN_MS = 120_000;

/**
 * Yields executed in one cycle, across the whole estate.
 *
 * NOT a rationing of humans - `yieldCount` already caps a single table at
 * humans_waiting + 1, and anything held back here is re-planned 30 seconds
 * later, so nobody is stranded. It is a circuit breaker: if a bug ever makes
 * the planner ask for two hundred stands at once, this is what stops it from
 * happening all at once, and the log line says it happened.
 */
export const MAX_YIELDS_PER_CYCLE = 12;

export interface YieldRequest {
  order: StandOrder;
  /** When the longest-waiting human at that table joined the list, in ms. */
  waitingSinceMs: number;
}

export function yieldKey(o: StandOrder): string {
  return `${o.tableId}:${o.horseId}`;
}

/**
 * PURE. Which yield requests are ripe right now.
 *
 * A request is ripe when the human has been waiting at least the horse's own
 * staggered delay (2-5 minutes, a sha256 of horse, table and list, so the same
 * horse always waits the same amount and a re-planned tick cannot change its
 * mind) and no order for the same seat was issued inside the cooldown.
 *
 * A request whose table reported no join time is treated as ripe IMMEDIATELY
 * rather than skipped. A missing timestamp is a read that failed, not a human
 * who is not waiting, and the failure a waiting human must never hit is the
 * one where nobody stands up at all.
 */
export function ripeYields(
  requests: YieldRequest[],
  nowMs: number,
  lastOrderedAt: ReadonlyMap<string, number>,
  opts: { cooldownMs?: number; max?: number } = {}
): { execute: YieldRequest[]; heldByCooldown: number; heldByCap: number } {
  const cooldownMs = opts.cooldownMs ?? YIELD_COOLDOWN_MS;
  const max = opts.max ?? MAX_YIELDS_PER_CYCLE;
  let heldByCooldown = 0;
  const ready: YieldRequest[] = [];

  for (const r of requests) {
    if (r.order.reason !== 'human_yield') continue;
    const last = lastOrderedAt.get(yieldKey(r.order));
    if (last !== undefined && nowMs - last < cooldownMs) {
      heldByCooldown++;
      continue;
    }
    const waited = Number.isFinite(r.waitingSinceMs) ? nowMs - r.waitingSinceMs : Infinity;
    if (waited < r.order.delayMs) continue;
    ready.push(r);
  }

  // Longest-waiting human first, so a cap can never starve the person who has
  // been queuing the longest.
  ready.sort((a, b) => a.waitingSinceMs - b.waitingSinceMs);
  return {
    execute: ready.slice(0, max),
    heldByCooldown,
    heldByCap: Math.max(0, ready.length - max),
  };
}

/** PURE. Every human_yield order in a plan, paired with its table's wait clock. */
export function yieldRequestsFor(snap: FloorSnapshot): YieldRequest[] {
  const waitSince = new Map<string, number>();
  for (const host of snap.hosts) {
    for (const t of host.tables) {
      if (t.waitlistOldestJoinedAtMs !== undefined)
        waitSince.set(t.tableId, t.waitlistOldestJoinedAtMs);
    }
  }
  return planFloor(snap)
    .stand.filter((o) => o.reason === 'human_yield')
    .map((order) => ({ order, waitingSinceMs: waitSince.get(order.tableId) ?? NaN }));
}

export class StableHandExecutor {
  private handle: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private inFlight = false;
  private readonly lastOrderedAt = new Map<string, number>();

  constructor(private readonly getEngine: (tableId: string) => YieldEngine | undefined) {}

  start(): void {
    if (this.running) return;
    if (!controllerEnabled()) {
      console.log('[StableHand] Executor disabled by STABLE_HAND_CONTROLLER - planning only');
      return;
    }
    this.running = true;
    this.handle = setInterval(() => {
      void this.cycle();
    }, STABLE_HAND_CYCLE_MS);
    console.log(
      `[StableHand] Executor running - human yield only, every ${STABLE_HAND_CYCLE_MS / 1000}s`
    );
  }

  stop(): void {
    this.running = false;
    if (this.handle) clearInterval(this.handle);
    this.handle = null;
  }

  async cycle(): Promise<number> {
    /* THE FREEZE IS TOTAL (Dan 2026-09-01): "HORSES SHOULD NOT STAND UP OR
       ROTATE, EVERYTHING JUST FREEZES." A seat changing hands under a break
       screen is also the loudest possible horse tell. The human keeps their
       place on the list and the yield fires on the first cycle after the thaw
       - the wait clock is the list's own created_at, which the break cannot
       move, so nothing is lost by waiting. */
    if (isMaintenanceFrozen()) return 0;
    // The kill switch stops NEW sits, never a yield: a kill switch that
    // strands a waiting human is not a safety feature, it is a second outage.
    // planFloor already runs the yield pass when snap.killed is true.
    if (!controllerEnabled()) return 0;
    if (this.inFlight) return 0;
    this.inFlight = true;
    try {
      const snap = await buildFloorSnapshot();
      const requests = yieldRequestsFor(snap);
      if (requests.length === 0) return 0;

      const now = Date.now();
      const { execute, heldByCooldown, heldByCap } = ripeYields(requests, now, this.lastOrderedAt);
      if (heldByCap > 0) {
        console.warn(
          `[StableHand] yield cap hit: ${heldByCap} ripe yield(s) deferred to the next cycle ` +
            `(ceiling ${MAX_YIELDS_PER_CYCLE})`
        );
      }

      let stood = 0;
      let noEngine = 0;
      for (const r of execute) {
        // Re-checked inside the loop: a break can begin between the snapshot
        // and the last seat in it.
        if (isMaintenanceFrozen()) break;
        const engine = this.getEngine(r.order.tableId);
        if (!engine) {
          noEngine++;
          continue;
        }
        // The same door a human's Leave Table button opens. Mid-hand it
        // auto-folds and defers the cash-out to settlement; between hands it
        // cashes out immediately. Either way the chips go back to the wallet
        // through atomic_seat_cashout_locked.
        const result = engine.leaveTable(r.order.horseId);
        // Recorded whatever the answer: a refusal that is re-issued every 30
        // seconds is the loop the cooldown exists to prevent.
        this.lastOrderedAt.set(yieldKey(r.order), now);
        if (result?.success) {
          stood++;
          console.log(
            `[StableHand] yield: horse ${r.order.horseId.slice(0, 8)} stood from table ` +
              `${r.order.tableId.slice(0, 8)} after ${Math.round((now - r.waitingSinceMs) / 1000)}s ` +
              `of human wait (${result.immediate ? 'immediate' : 'at the end of the hand'})`
          );
        } else {
          console.warn(
            `[StableHand] yield refused for ${r.order.horseId.slice(0, 8)} at ` +
              `${r.order.tableId.slice(0, 8)}: ${result?.error ?? 'unknown'}`
          );
        }
      }

      if (noEngine > 0) {
        console.warn(
          `[StableHand] ${noEngine} yield(s) skipped - no live engine for the table, retried next cycle`
        );
      }
      if (heldByCooldown > 0 && stood === 0 && execute.length === 0) {
        // Nothing acted on and everything held: worth one line, not a storm.
        console.log(`[StableHand] ${heldByCooldown} yield(s) still settling from a previous cycle`);
      }
      return stood;
    } catch (err) {
      reportError(err, 'StableHandExecutor.cycle');
      return 0;
    } finally {
      this.inFlight = false;
    }
  }
}
