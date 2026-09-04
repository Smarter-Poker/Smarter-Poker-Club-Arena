/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  OPERATION STABLE HAND - the executor, and it only does ONE thing
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `planFloor` decides everything: seat, stand, open, close. This executes the
 * two kinds of `stand` order - `human_yield` and `occupancy_wind_down` - and
 * deliberately ignores seat, open and close.
 *
 * WHY ONLY STANDS. The seating loop in HorseFleetManager is exercised every 30
 * seconds against real money and survived three separate incidents to reach
 * its current shape. The blast radius of a bug in a new controller DRIVING it
 * is the whole cash floor; the 2026-08-31 outage emptied that floor for forty
 * minutes from a change smaller than this one. A stand order cannot overshoot
 * occupancy, cannot open a table and cannot spend a chip. Seat, open and close
 * stay reported-only in GET /stable-hand.
 *
 * THE TWO ORDERS ARE NOT THE SAME URGENCY, and are handled separately:
 *
 *   human_yield         somebody is waiting. It runs even when the kill
 *                       switch is on, and its clock starts when the human
 *                       joined the list.
 *   occupancy_wind_down nobody is waiting; the floor is simply above its
 *                       curve. Rate-limited per host so the room walks onto
 *                       the curve over minutes instead of dropping onto it,
 *                       and absent entirely when killed - planFloor does not
 *                       emit it on a killed snapshot.
 *
 * WHY A WIND-DOWN NEEDS THE SEEDER'S AGREEMENT. Standing a horse up here and
 * letting HorseFleetManager reseat that seat thirty seconds later is not a
 * wind-down, it is a cash-out and a buy-in per horse per cycle - expensive,
 * and the loudest tell a floor can have. The seeding cycle carries the same
 * curve now (`stableHandHostCaps`), so a seat freed here is not refilled past
 * the cap. The two halves only work together; shipping this one alone would
 * have produced exactly that churn.
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

/**
 * Wind-down stands per host per cycle.
 *
 * The room already sees up to four departures every 90 seconds from ordinary
 * session ends (HorseSessionRotator), so four per 30-second cycle per host is
 * a few times the natural rhythm - brisk, not a stampede. The planner already
 * picks at most ONE victim per table, so no single table ever loses more than
 * one seat per cycle whatever this number is; it only bounds how much of the
 * floor moves at once. At four, a host 129 bodies above its curve reaches it
 * in about sixteen minutes.
 */
export const MAX_WIND_DOWN_PER_HOST_PER_CYCLE = 4;

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
  return standOrdersFor(snap).yields;
}

export interface WindDownRequest {
  order: StandOrder;
  hostId: string;
}

export interface FloorStandOrders {
  yields: YieldRequest[];
  windDowns: WindDownRequest[];
  alerts: string[];
}

/** PURE. Both kinds of stand order, from ONE pass of the planner. */
export function standOrdersFor(snap: FloorSnapshot): FloorStandOrders {
  const waitSince = new Map<string, number>();
  const hostOfTable = new Map<string, string>();
  for (const host of snap.hosts) {
    for (const t of host.tables) {
      hostOfTable.set(t.tableId, host.hostId);
      if (t.waitlistOldestJoinedAtMs !== undefined) {
        waitSince.set(t.tableId, t.waitlistOldestJoinedAtMs);
      }
    }
  }
  const plan = planFloor(snap);
  return {
    yields: plan.stand
      .filter((o) => o.reason === 'human_yield')
      .map((order) => ({ order, waitingSinceMs: waitSince.get(order.tableId) ?? NaN })),
    windDowns: plan.stand
      .filter((o) => o.reason === 'occupancy_wind_down')
      .map((order) => ({ order, hostId: hostOfTable.get(order.tableId) ?? '' })),
    alerts: plan.alerts,
  };
}

/**
 * PURE. Which wind-down stands run this cycle.
 *
 * There is no delay to serve - nobody is waiting - so the only gates are the
 * cooldown (a seat ordered to stand while a hand finishes must not be ordered
 * again) and the per-host ceiling. Anything held back is re-planned in thirty
 * seconds, so the floor walks down rather than dropping.
 */
export function ripeWindDowns(
  requests: WindDownRequest[],
  nowMs: number,
  lastOrderedAt: ReadonlyMap<string, number>,
  opts: { cooldownMs?: number; maxPerHost?: number } = {}
): { execute: WindDownRequest[]; heldByCooldown: number; heldByCap: number } {
  const cooldownMs = opts.cooldownMs ?? YIELD_COOLDOWN_MS;
  const maxPerHost = opts.maxPerHost ?? MAX_WIND_DOWN_PER_HOST_PER_CYCLE;
  let heldByCooldown = 0;
  let heldByCap = 0;
  const perHost = new Map<string, number>();
  const execute: WindDownRequest[] = [];

  for (const r of requests) {
    if (r.order.reason !== 'occupancy_wind_down') continue;
    const last = lastOrderedAt.get(yieldKey(r.order));
    if (last !== undefined && nowMs - last < cooldownMs) {
      heldByCooldown++;
      continue;
    }
    const taken = perHost.get(r.hostId) ?? 0;
    if (taken >= maxPerHost) {
      heldByCap++;
      continue;
    }
    perHost.set(r.hostId, taken + 1);
    execute.push(r);
  }
  return { execute, heldByCooldown, heldByCap };
}

export class StableHandExecutor {
  private handle: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private inFlight = false;
  private readonly lastOrderedAt = new Map<string, number>();
  /** Stands skipped this cycle because the table had no live engine. */
  private noEngine = 0;

  /**
   * Stand ONE horse up, through the same door a human's Leave Table button
   * opens. Mid-hand it auto-folds and defers the cash-out to settlement;
   * between hands it cashes out immediately. Either way the chips go back to
   * the wallet through atomic_seat_cashout_locked, and this module never
   * touches a seat row itself.
   */
  private stand(order: StandOrder, nowMs: number, why: string): boolean {
    /* Re-checked per seat: a break can begin between the snapshot and the last
       order in it. */
    if (isMaintenanceFrozen()) return false;
    const engine = this.getEngine(order.tableId);
    if (!engine) {
      this.noEngine++;
      return false;
    }
    const result = engine.leaveTable(order.horseId);
    /* Recorded whatever the answer: a refusal re-issued every 30 seconds is
       the loop the cooldown exists to prevent. */
    this.lastOrderedAt.set(yieldKey(order), nowMs);
    if (result?.success) {
      console.log(
        `[StableHand] ${order.reason}: horse ${order.horseId.slice(0, 8)} stood from table ` +
          `${order.tableId.slice(0, 8)} - ${why} ` +
          `(${result.immediate ? 'immediate' : 'at the end of the hand'})`
      );
      return true;
    }
    console.warn(
      `[StableHand] ${order.reason} refused for ${order.horseId.slice(0, 8)} at ` +
        `${order.tableId.slice(0, 8)}: ${result?.error ?? 'unknown'}`
    );
    return false;
  }

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
    // The kill switch stops NEW sits and the wind-down, never a yield: a kill
    // switch that strands a waiting human is not a safety feature, it is a
    // second outage. planFloor runs its yield pass on a killed snapshot and
    // emits no occupancy order at all, so both rules are already served by the
    // snapshot and neither is re-decided here.
    if (!controllerEnabled()) return 0;
    if (this.inFlight) return 0;
    this.inFlight = true;
    try {
      const snap = await buildFloorSnapshot();
      const orders = standOrdersFor(snap);
      const now = Date.now();

      /* YIELDS FIRST, ALWAYS. Somebody is waiting for one of these seats and
         nobody is waiting for a wind-down, so a yield never queues behind the
         shape of the floor. */
      const yields = ripeYields(orders.yields, now, this.lastOrderedAt);
      if (yields.heldByCap > 0) {
        console.warn(
          `[StableHand] yield cap hit: ${yields.heldByCap} ripe yield(s) deferred to the next ` +
            `cycle (ceiling ${MAX_YIELDS_PER_CYCLE})`
        );
      }
      const winds = ripeWindDowns(orders.windDowns, now, this.lastOrderedAt);

      let stood = 0;
      for (const r of yields.execute) {
        const waited = Math.round((now - r.waitingSinceMs) / 1000);
        if (
          this.stand(r.order, now, `after ${Number.isFinite(waited) ? waited : 0}s of human wait`)
        ) {
          stood++;
        }
      }
      for (const r of winds.execute) {
        if (this.stand(r.order, now, `host ${r.hostId.slice(0, 8)} is above its occupancy curve`)) {
          stood++;
        }
      }

      if (this.noEngine > 0) {
        console.warn(
          `[StableHand] ${this.noEngine} stand(s) skipped - no live engine for the table, ` +
            `retried next cycle`
        );
        this.noEngine = 0;
      }
      if (winds.execute.length > 0 || winds.heldByCap > 0) {
        console.log(
          `[StableHand] wind-down: ${winds.execute.length} stood, ${winds.heldByCap} deferred to ` +
            `the next cycle, ${orders.windDowns.length} wanted by the plan`
        );
      }
      if (
        yields.heldByCooldown > 0 &&
        stood === 0 &&
        yields.execute.length === 0 &&
        winds.execute.length === 0
      ) {
        // Nothing acted on and everything held: worth one line, not a storm.
        console.log(
          `[StableHand] ${yields.heldByCooldown} yield(s) still settling from a previous cycle`
        );
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
