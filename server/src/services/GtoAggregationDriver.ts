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
 * (57014).
 *
 * The first version of this driver started at 600 and halved on timeout,
 * then doubled again after ten clean ticks. Live, that settled at 200 and
 * then oscillated 200 -> 400 -> timeout -> 200 forever, wasting roughly one
 * tick in four and delivering ~500 rows/min. So: FIXED batch, and several
 * calls per tick under a wall-clock budget instead.
 *
 * ── RE-MEASURED 2026-08-30 04:00 UTC: THE COST IS SUPER-LINEAR ──────────
 *
 * 200 was chosen when it cost 3.5s. It does not any more. Re-measured on
 * the same path, once gto_postflop_compact had accumulated enough cells
 * that nearly every batch takes the expensive ON CONFLICT merge path:
 *
 *     batch  time        rows/s   verdict
 *     ----   ----------  ------   -------------------------------------
 *      100   0.89-0.95s     111   9x headroom under the 8s cap
 *      125   1.15-1.42s      98
 *      150   1.56-1.71s      92
 *      200   7.54-8.27s      25   ON the cliff; 1 call in 3 was cancelled
 *
 * Cost is super-linear in batch size — the aggregation CTEs join through
 * CTE scans the planner estimates at rows=1, so it picks nested loops and
 * the work grows faster than the row count. Doubling 100 to 200 does not
 * double the cost, it octuples it and lands on top of the 8s ceiling.
 *
 * Live consequence, observed before this change: 200 rows per 20s tick,
 * ~10 rows/s — a QUARTER of what this header claimed — because only one
 * call per tick survived, and the other burned eight seconds of database
 * CPU before rolling back with the cursor unmoved.
 *
 * So the batch went DOWN and the call count went UP. 8 x 100 rows per 20s
 * tick is ~40 rows/s at a ~36% duty cycle — four times the throughput at a
 * LOWER database load than the 200-row version, because none of the work
 * is thrown away. Turn in ~22h, river in ~39h.
 *
 * The SQL's clamp floor was 200, which pinned this knob against a wall;
 * migration 20260830040000 lowers it to 25 so a caller may ask for less.
 *
 * A timeout is not a failure to report: it means the database was busy, the
 * transaction rolled back, and the cursor did not move. The tick simply
 * ends and the next one tries again.
 */

import { supabase } from './supabase/client.js';
import { reportError } from './errorReporter.js';

const TICK_MS = 20_000;
const BOOT_DELAY_MS = 45_000; // after the loaders; never in the boot rush
/**
 * Measured 2026-08-30: the batch with the best rows/second AND ~9x headroom
 * under the API's 8s statement budget. NOT the largest that fits — cost is
 * super-linear, so the largest that fits is also the slowest per row and
 * the one that gets cancelled. See the header table.
 */
const BATCH = 100;
/** Wall-clock work budget per tick — the rest of the tick is the rest. */
const TICK_BUDGET_MS = 12_000;
/**
 * Hard cap on calls per tick. The wall budget alone is not a bound: if the
 * database is fast (or, in a test, mocked), the loop spins as many times as
 * it can fit, which is neither the pacing this service exists to provide
 * nor something a test can wait out. Eight x 100 rows per 20s tick is ~40
 * rows/s — turn in ~22h, river in ~39h — and at a measured ~0.9s per call
 * that is ~7.2s of work in a 20s tick, a ~36% duty cycle. This cap is the
 * pacing knob: raising it buys throughput at the fleet's expense, so it
 * moves only with a fresh measurement beside it.
 */
const MAX_CALLS_PER_TICK = 8;
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
let lifecycleGeneration = 0;
let lifecycleActive = false;
let stopOperation: Promise<void> | null = null;
const inFlightTicks = new Set<Promise<void>>();

const lifecycleIsCurrent = (generation?: number): boolean =>
  generation === undefined || (lifecycleActive && lifecycleGeneration === generation);

/**
 * Test seam — no production caller by design. `startGtoAggregationDriver`
 * and the tick read the module-level `finished` directly; this accessor
 * exists so the suite can assert the driver goes PERMANENTLY silent once
 * both streets are done, which is the property that keeps a finished
 * one-time build from calling the RPC forever.
 */
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
export async function gtoAggregationTick(generation?: number): Promise<number> {
  if (!lifecycleIsCurrent(generation)) return 0;
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
      if (!lifecycleIsCurrent(generation)) return rows;
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
              console.warn('[GtoAggregationDriver] repeated timeouts - backing off for ~100s');
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
      console.log('[GtoAggregationDriver] all streets aggregated - going silent');
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

function launchTick(): void {
  const generation = lifecycleGeneration;
  if (!lifecycleIsCurrent(generation) || inFlightTicks.size > 0) return;
  let tracked!: Promise<void>;
  tracked = gtoAggregationTick(generation)
    .then(() => undefined)
    .finally(() => inFlightTicks.delete(tracked));
  inFlightTicks.add(tracked);
}

async function drainTicks(): Promise<void> {
  while (inFlightTicks.size > 0) await Promise.allSettled([...inFlightTicks]);
}

export function startGtoAggregationDriver(): void {
  if (timer || bootTimer || lifecycleActive || finished) return;
  lifecycleActive = true;
  lifecycleGeneration += 1;
  stopOperation = null;
  bootTimer = setTimeout(() => {
    bootTimer = null;
    if (!lifecycleActive) return;
    timer = setInterval(launchTick, TICK_MS);
    timer.unref?.();
    launchTick();
  }, BOOT_DELAY_MS);
  bootTimer.unref?.();
}

export function stopGtoAggregationDriver(): Promise<void> {
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
  stopOperation = drainTicks();
  return stopOperation;
}

/** Test seam. */
export function _resetGtoAggregationDriver(): void {
  void stopGtoAggregationDriver();
  running = false;
  streetIdx = 0;
  finished = false;
  stalledTicks = 0;
  skipTicks = 0;
}
