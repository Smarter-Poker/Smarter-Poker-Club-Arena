/**
 * GTO AGGREGATION DRIVER (V30, Dan 2026-08-29)
 *
 * Paces the one-time turn/river aggregation of the solver warehouse: every
 * tick it asks fn_aggregate_gto_street_next to fold the next small batch of
 * solved_spots_gold rows into gto_postflop_compact — turn first (3.18M
 * rows), then river (5.59M). The cursor lives in gto_agg_progress, so the
 * build is restart-safe: a redeploy resumes exactly where it stopped, and
 * once both streets report done the driver goes permanently silent.
 *
 * WHY THE ENGINE PACES IT: the 2026-08-15 incident (one COUNT starved the
 * DB) rules out any big offline pass over the 79 GB table. Small bounded
 * index-driven batches with rests between them keep the duty cycle low, and
 * the engine is the one place that is always running. The work happens in
 * Postgres; this service holds no data and touches nothing on the deal path.
 *
 * ── THE BATCH SIZE IS MEASURED, NOT GUESSED (2026-08-29) ────────────────
 *
 * statement_timeout is armed when the outer statement starts, so a
 * function-level SET cannot grant the RPC more time — batch size is the
 * only control. Measured against production through the SAME path the
 * engine uses (POST /rest/v1/rpc as service_role): a 200-row batch returns
 * in ~3.5s; 300 and up exceed the API's ~8s budget and are cancelled
 * (57014). The SQL itself clamps p_batch to [200, 5000], so 200 is both the
 * floor and the ceiling that fits — there is no size to adapt to.
 *
 * The first version of this driver started at 600 and halved on timeout,
 * then doubled again after ten clean ticks. Live, that settled at 200 and
 * then oscillated 200 -> 400 -> timeout -> 200 forever, wasting roughly one
 * tick in four and delivering ~500 rows/min. So: FIXED batch, and several
 * calls per tick under a wall-clock budget instead. ~3 calls x 200 rows per
 * 20s tick is ~30 rows/s — turn in about 30h, river in about 52h, at a duty
 * cycle low enough to stay invisible beside the fleet's own traffic.
 *
 * A timeout is not a failure to report: it means the database was busy, the
 * transaction rolled back, and the cursor did not move. The tick simply
 * ends and the next one tries again.
 */

import { supabase } from './supabase/client.js';
import { reportError } from './errorReporter.js';

const TICK_MS = 20_000;
const BOOT_DELAY_MS = 45_000; // after the loaders; never in the boot rush
/** Measured: the largest batch that fits the API statement budget. */
const BATCH = 200;
/** Wall-clock work budget per tick — the rest of the tick is the rest. */
const TICK_BUDGET_MS = 12_000;
/**
 * Hard cap on calls per tick. The wall budget alone is not a bound: if the
 * database is fast (or, in a test, mocked), the loop spins as many times as
 * it can fit, which is neither the pacing this service exists to provide
 * nor something a test can wait out. Four x 200 rows per 20s tick is ~40
 * rows/s — turn in ~22h, river in ~39h.
 */
const MAX_CALLS_PER_TICK = 4;
/** Consecutive all-timeout ticks before backing off (DB under pressure). */
const BACKOFF_AFTER_STALLED_TICKS = 5;

const STREETS = ['turn', 'river'] as const;

let timer: NodeJS.Timeout | null = null;
let bootTimer: NodeJS.Timeout | null = null;
let running = false;
let streetIdx = 0;
let finished = false;
let stalledTicks = 0;
let skipTicks = 0;

export function gtoAggregationFinished(): boolean {
  return finished;
}

function isTimeout(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === '57014' || /statement timeout/i.test(error.message ?? '');
}

/**
 * One tick: fold as many batches as fit the budget, for the current street.
 * Returns the number of rows processed (test seam).
 */
export async function gtoAggregationTick(): Promise<number> {
  if (finished || running) return 0;
  if (skipTicks > 0) {
    skipTicks--;
    return 0;
  }
  running = true;
  const deadline = Date.now() + TICK_BUDGET_MS;
  let rows = 0;
  let calls = 0;
  try {
    while (streetIdx < STREETS.length && calls < MAX_CALLS_PER_TICK && Date.now() < deadline) {
      calls++;
      const street = STREETS[streetIdx];
      const { data, error } = await supabase.rpc('fn_aggregate_gto_street_next', {
        p_street: street,
        p_batch: BATCH,
      });
      if (error) {
        if (isTimeout(error)) {
          // The DB was busy; the transaction rolled back and the cursor did
          // not move. End the tick — never hammer a database that is
          // already telling you it is short of time.
          if (rows === 0) {
            stalledTicks++;
            if (stalledTicks >= BACKOFF_AFTER_STALLED_TICKS) {
              skipTicks = 5; // ~100s of quiet before trying again
              stalledTicks = 0;
              console.warn('[GtoAggregationDriver] repeated timeouts — backing off for ~100s');
            }
          }
        } else {
          reportError(new Error(error.message), 'GtoAggregationDriver.tick');
        }
        return rows;
      }
      stalledTicks = 0;
      const row = Array.isArray(data) ? data[0] : data;
      rows += Number(row?.processed ?? 0);
      if (row?.street_done) {
        console.log(`[GtoAggregationDriver] ${street} aggregation complete`);
        streetIdx++;
      }
    }
    if (streetIdx >= STREETS.length) {
      finished = true;
      console.log('[GtoAggregationDriver] all streets aggregated — going silent');
      stopGtoAggregationDriver();
    }
    return rows;
  } catch (err) {
    reportError(err, 'GtoAggregationDriver.tick');
    return rows;
  } finally {
    running = false;
  }
}

export function startGtoAggregationDriver(): void {
  if (timer || finished) return;
  bootTimer = setTimeout(() => {
    timer = setInterval(() => void gtoAggregationTick(), TICK_MS);
    timer.unref?.();
    void gtoAggregationTick();
  }, BOOT_DELAY_MS);
  bootTimer.unref?.();
}

export function stopGtoAggregationDriver(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (bootTimer) {
    clearTimeout(bootTimer);
    bootTimer = null;
  }
}

/** Test seam. */
export function _resetGtoAggregationDriver(): void {
  stopGtoAggregationDriver();
  running = false;
  streetIdx = 0;
  finished = false;
  stalledTicks = 0;
  skipTicks = 0;
}
