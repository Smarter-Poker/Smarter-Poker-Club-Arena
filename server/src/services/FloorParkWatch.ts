/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  AN OWNER FLOOR PARK IS NOT AN OUTAGE (2026-10-15)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHAT HAPPENED. At 16:53 UTC on 2026-10-15 the owner parked the floor for a
 * horse wallet reset (operation 3d9c1ba1, seven clubs holding every live cash
 * table), closed 115 cash tables, renewed the lease once and resumed at 18:10.
 * While the park ran, HorseCashActionsStopped, EngineTableCountAnomaly,
 * HorseFleetCollapsed, SLOHandsAreNotBeingDealt and the engine's own
 * ClubArenaFleetFloorLost all paged, each one measuring a stop the owner had
 * scheduled. The fleet rules already stand down for the hourly break
 * (`poker_maintenance_break_active`); nothing told them about a park.
 *
 * WHAT THIS IS. One read every 30 s of `fn_ca_operator_floor_park_share()`
 * (migration 20261015181538): the share of the cash floor the current floor
 * hold refuses, 0 with no hold and 1 for an unscoped hold. It is published as
 * `poker_operator_floor_park_share`, and the fleet rules carry
 * `unless on() max_over_time(poker_operator_floor_park_share[6m]) >= 0.5`
 * beside their break guard. 0.5 is derived, not guessed: those rules page at
 * half the healthy floor or below (HorseCashActionsStopped 150 of 313 actions
 * a minute, HorseFleetThroughputRelativeDrop half of the same hour), so a park
 * of less than half the floor cannot explain their breach and silences
 * nothing. The same threshold stands ClubArenaFleetFloorLost down in
 * DealRateVerifier.
 *
 * A PARK CANNOT HIDE AN OUTAGE FOR LONG. The hold is a 60-minute lease that
 * only its own operation can renew (20261014231111), and the floor-hold
 * watchdog pages a lease nobody renewed or a hold renewed past 180 minutes.
 *
 * "COULD NOT TELL" IS ITS OWN OUTCOME (CLAUDE.md 10.86). A failed or
 * malformed read keeps the last good value for at most two minutes, then the
 * share falls to 0, which silences nothing, and `poker_operator_floor_park_known`
 * says 0. Before the migration is installed the RPC does not exist, so the
 * share stays 0 and every rule pages exactly as it did before this file.
 */

import { supabase } from './supabase.js';
import { reportError } from './errorReporter.js';
import { alwaysOnRegistry } from '../observability/engineInstruments.js';

/** How often the share is read. */
export const FLOOR_PARK_REFRESH_MS = 30_000;
/** How old the last good read may be before it no longer counts. */
export const FLOOR_PARK_MAX_AGE_MS = 120_000;
/** The share at and above which a fleet-level stop is the park's, not an outage. */
export const FLEET_STANDS_DOWN_AT_PARK_SHARE = 0.5;

const shareGauge = alwaysOnRegistry.gauge(
  'poker_operator_floor_park_share',
  'Share of the cash floor an owner floor hold refuses (0 none, 1 unscoped). 0 when it could not be read. Fleet rules stand down at >= 0.5.'
);
const knownGauge = alwaysOnRegistry.gauge(
  'poker_operator_floor_park_known',
  '1 when poker_operator_floor_park_share comes from a read in the last two minutes, 0 when it could not be read'
);
shareGauge.set(0);
knownGauge.set(0);

let lastShare = 0;
let lastReadAtMs = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let refreshing = false;
let consecutiveFailures = 0;

/**
 * The share in an answer of fn_ca_operator_floor_park_share(), or null when the
 * answer is not one. `held: false` is a share of 0; a held answer must carry a
 * number in [0, 1].
 */
export function parseFloorParkShare(data: unknown): number | null {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== 'object') return null;
  const held = (row as { held?: unknown }).held;
  const share = Number((row as { share?: unknown }).share);
  if (held === false) return 0;
  if (held !== true || !Number.isFinite(share) || share < 0 || share > 1) return null;
  return share;
}

/** Record a good read. Exported so tests can stand in for the database. */
export function noteFloorParkShare(share: number, atMs = Date.now()): void {
  lastShare = share;
  lastReadAtMs = atMs;
  consecutiveFailures = 0;
  shareGauge.set(share);
  knownGauge.set(1);
}

/** The share of the floor the owner has parked, from a fresh read; 0 otherwise. */
export function ownerFloorParkShare(nowMs = Date.now()): number {
  if (lastReadAtMs === 0 || nowMs - lastReadAtMs > FLOOR_PARK_MAX_AGE_MS) return 0;
  return lastShare;
}

/** True while a fresh read says an owner park holds at least half the floor. */
export function fleetIsParkedByOwner(nowMs = Date.now()): boolean {
  return ownerFloorParkShare(nowMs) >= FLEET_STANDS_DOWN_AT_PARK_SHARE;
}

function noteFailure(reason: string, nowMs = Date.now()): void {
  consecutiveFailures++;
  if (lastReadAtMs === 0 || nowMs - lastReadAtMs > FLOOR_PARK_MAX_AGE_MS) {
    shareGauge.set(0);
    knownGauge.set(0);
  }
  // Once per outage, not once per tick.
  if (consecutiveFailures === 4) {
    reportError(
      new Error(
        `[FloorParkWatch] ${consecutiveFailures} consecutive reads failed (${reason}); poker_operator_floor_park_share is 0 and no fleet rule stands down for a park`
      ),
      'FloorParkWatch.refresh_failed'
    );
  }
}

/** One read. Never throws. */
export async function refreshFloorPark(
  rpc: (fn: string) => PromiseLike<{ data: unknown; error: { message?: string } | null }> = async (
    fn
  ) => {
    const { data, error } = await supabase.rpc(fn);
    return { data, error };
  }
): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    const { data, error } = await rpc('fn_ca_operator_floor_park_share');
    if (error) return noteFailure(error.message ?? 'rpc error');
    const share = parseFloorParkShare(data);
    if (share === null) return noteFailure('malformed answer');
    noteFloorParkShare(share);
  } catch (err) {
    noteFailure(err instanceof Error ? err.message : String(err));
  } finally {
    refreshing = false;
  }
}

export function startFloorParkWatch(): void {
  if (timer) return;
  void refreshFloorPark();
  timer = setInterval(() => void refreshFloorPark(), FLOOR_PARK_REFRESH_MS);
  (timer as { unref?: () => void }).unref?.();
}

export function stopFloorParkWatch(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Test seam: forget every read. */
export function resetFloorParkWatchForTests(): void {
  stopFloorParkWatch();
  lastShare = 0;
  lastReadAtMs = 0;
  consecutiveFailures = 0;
  refreshing = false;
  shareGauge.set(0);
  knownGauge.set(0);
}
