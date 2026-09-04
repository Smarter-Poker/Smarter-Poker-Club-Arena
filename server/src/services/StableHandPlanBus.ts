/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  OPERATION STABLE HAND - how a plan reaches the seeder
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The planner emits four kinds of order. Three of them the executor carries
 * out itself, because standing a horse up and marking a table are things it
 * can do alone. The fourth - SEAT - it must not.
 *
 * Seating a horse means choosing which horse, from which wallet, for how much,
 * against a bankroll, a tag, a mutex, a club membership and a stake ladder.
 * All of that already exists, in one place, exercised every thirty seconds
 * against real money: `HorseFleetManager.seedAllTables`. A second
 * implementation in the executor would be a second answer to "may this horse
 * sit here", and this estate has already paid for one number living in two
 * places (`src/lib/cashBuyIn.ts` exists because four layers disagreed about
 * one buy-in).
 *
 * So the executor does not seat. It PUBLISHES what the shape needs, and the
 * seeder - which is the only thing that knows how to seat anybody - reads it.
 * There is still exactly one seating implementation.
 *
 * ── A STALE PLAN IS NOT A PLAN ─────────────────────────────────────────────
 *
 * Everything here expires. A plan describes a floor as it was at one instant;
 * two cycles later it is a description of a floor that has moved, and acting
 * on it is worse than acting on nothing. An expired bus reads as empty, which
 * puts the seeder back on its own per-table targets - today's behaviour,
 * unchanged - and that is also what a switched-off controller looks like.
 */

import type { FloorPlan, OpenOrder } from './StableHandController.js';

/**
 * How long a published plan is honoured.
 *
 * Two executor cycles. One cycle would make the seeder's behaviour depend on
 * which of two intervals happened to fire first; much more than two and it is
 * steering by a floor that has moved.
 */
export const PLAN_TTL_MS = 65_000;

interface PublishedPlan {
  at: number;
  /** tableId -> the seat count the shape wants at that table. */
  seatTargets: Map<string, number>;
  open: OpenOrder[];
}

let current: PublishedPlan | null = null;

/** Publish the plan the executor just acted on. */
export function publishPlan(plan: FloorPlan, nowMs: number = Date.now()): void {
  const seatTargets = new Map<string, number>();
  for (const o of plan.seat) {
    // `seats` is how many MORE the order wants; the seeder is told the total.
    seatTargets.set(o.tableId, (seatTargets.get(o.tableId) ?? 0) + Math.max(0, o.seats));
  }
  current = { at: nowMs, seatTargets, open: [...plan.open] };
}

/** Drop everything. For tests, and for a controller shutting down. */
export function clearPlan(): void {
  current = null;
}

/** True while a published plan is still describing a floor that exists. */
export function planIsFresh(nowMs: number = Date.now()): boolean {
  return current !== null && nowMs - current.at < PLAN_TTL_MS;
}

/**
 * How many EXTRA seats the shape wants at each table.
 *
 * Empty when there is no fresh plan, which is what a switched-off or stalled
 * controller looks like, and puts the seeder back on its own per-table target.
 */
export function seatBoosts(nowMs: number = Date.now()): ReadonlyMap<string, number> {
  return planIsFresh(nowMs) ? current!.seatTargets : new Map();
}

/**
 * The open orders, TAKEN rather than read: an order acted on must not be acted
 * on again by the next seeding cycle before the executor has re-planned. A
 * table opened twice is the duplicate-board bug the recurring service already
 * carries a unique index to prevent.
 */
export function takeOpenOrders(nowMs: number = Date.now()): OpenOrder[] {
  if (!planIsFresh(nowMs)) return [];
  const orders = current!.open;
  current!.open = [];
  return orders;
}
