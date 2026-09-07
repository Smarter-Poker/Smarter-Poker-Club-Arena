/**
 * GTO AGGREGATION DRIVER — V31 (2026-08-30)
 *
 * Paces the one-time aggregation of `strategy_matrix_v2` into
 * gto_postflop_v31, the same way GtoAggregationDriver paces V30: every tick
 * it asks fn_aggregate_gto_v31_next to fold the next small batch, the cursor
 * lives in the database (gto_agg_progress_v31) so a redeploy resumes exactly
 * where it stopped, and the driver goes permanently silent when done.
 *
 * ── WHY A SECOND DRIVER AND NOT A SECOND STREET ────────────────────────
 *
 * v1 and v2 are DISJOINT exports. Of 9,584 sampled turn rows, 3,936 carry
 * v1 `tree_lines`, 5,648 carry v2 `actions`, and ZERO carry both. V30 walks
 * past every v2 row because it requires tree_lines. So this is not a
 * re-aggregation of the same data at higher fidelity — it is the other 59%
 * of the turn, which nothing has ever read.
 *
 * Coverage is turn (1,849,393 rows) plus a flop slice (42,424). River has
 * EIGHT v2 rows against 5,636,032 without, so there is no river to build
 * here and V30 remains the only river source, permanently.
 *
 * ── IT WAITS FOR V30. THIS IS THE POINT OF THE GATE ────────────────────
 *
 * Both aggregations walk the same 79 GB table. Running them together
 * doubles the buffer pressure on the one relation the 2026-08-15 liveness
 * incident was caused by, and V30 is the one with a consult already reading
 * its output. So every tick first asks whether gto_agg_progress reports
 * BOTH streets done, and does nothing until it does. Nothing to configure
 * and nothing to remember to turn on: V31 starts itself the tick after V30
 * finishes.
 *
 * ── THE BATCH IS MEASURED THROUGH THE ENGINE'S OWN PATH ────────────────
 *
 * The first version of the aggregator was timed only from a privileged SQL
 * session (~657ms for 25 rows) and looked comfortable. Through POST
 * /rest/v1/rpc as service_role — this path — the same batch took 20.5
 * seconds. `authenticator` carries statement_timeout=8s, so that batch can
 * never complete here. Re-measured after the aggregator was optimised
 * (20260830e), on this path:
 *
 *     batch   time     verdict
 *     -----   ------   ---------------------------------------------
 *       5     1.18s    comfortable
 *      10     6.67s    fits, and is the largest that reliably does
 *      15     4.90s    fits, but the spread with 10 says it is luck
 *      25     9.06s    57014 — cancelled, over the 8s ceiling
 *
 * So BATCH is 10. Note 15 measured FASTER than 10 on a single sample: the
 * variance between runs is larger than the difference between these two
 * batch sizes, which is exactly why the number is chosen with headroom
 * rather than by picking the fastest sample.
 *
 * A 57014 is not a failure to report: the database was busy, the
 * transaction rolled back, and the cursor did not move. The tick ends and
 * the next one tries again.
 */

import { supabase } from './supabase/client.js';
import { reportError } from './errorReporter.js';

const TICK_MS = 20_000;
/** After V30's driver (45s) and the loaders; never in the boot rush. */
const BOOT_DELAY_MS = 90_000;
/** Measured on the RPC path against an 8s statement_timeout. See header. */
const BATCH = 10;
/** Wall-clock work budget per tick — the rest of the tick is the rest. */
const TICK_BUDGET_MS = 12_000;
/**
 * A CAP, NOT A RATE — and the difference matters, because the first version
 * of this comment got it wrong.
 *
 * The loop also stops at TICK_BUDGET_MS, so the calls that actually fit are
 * `min(4, 12s / cost-per-call)`. A V31 call is expensive: batch 10 measured
 * 1.72s, 2.54s and 6.67s on the RPC path, so between 2 and 4 calls land in a
 * tick, not always 4. Real throughput is therefore 20-40 rows per 20s tick,
 * i.e. **1-2 rows/s**, and the ~1.89M v2 rows take **11-22 days** of wall
 * clock rather than the "five days" this comment originally claimed.
 *
 * The cost is intrinsic, not a tuning miss: V31 unnests 1,326 combos x ~2
 * actions per solved row, so a row costs ~0.4-0.7s against V30's ~0.009s —
 * roughly 74x — because V30 reads a payload already reduced to 169 classes.
 * Raising this cap does not help while TICK_BUDGET_MS is the binding
 * constraint; raising the BUDGET buys throughput by raising the duty cycle,
 * which is a decision to make against the fleet, with a fresh measurement,
 * not a constant to nudge.
 *
 * Deliberately gentler than V30's eight calls regardless: nothing reads
 * gto_postflop_v31 yet, so this build yields to everything that does. The
 * cursor makes every restart free, so a long build costs patience only.
 */
const MAX_CALLS_PER_TICK = 4;
/** Consecutive all-timeout ticks before backing off (DB under pressure). */
const BACKOFF_AFTER_STALLED_TICKS = 5;

let timer: NodeJS.Timeout | null = null;
let bootTimer: NodeJS.Timeout | null = null;
let running = false;
let finished = false;
let stalledTicks = 0;
let skipTicks = 0;
let announcedWaiting = false;
let lifecycleGeneration = 0;
let lifecycleActive = false;
let stopOperation: Promise<void> | null = null;
const inFlightTicks = new Set<Promise<void>>();

const lifecycleIsCurrent = (generation?: number): boolean =>
  generation === undefined || (lifecycleActive && lifecycleGeneration === generation);

/**
 * Test seam — no production caller by design, mirroring V30's. The tick
 * reads `finished` directly; this exists so the suite can assert the driver
 * goes PERMANENTLY silent once the build is done, which is the property
 * that stops a finished one-time build calling the RPC forever.
 */
export function gtoV31AggregationFinished(): boolean {
  return finished;
}

function isTimeout(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === '57014' || /statement timeout/i.test(error.message ?? '');
}

/**
 * Has the V30 aggregation finished every street?
 *
 * Fails CLOSED: any error, or a shape we do not recognise, answers "not
 * yet". A driver that cannot tell whether it is safe to start must not
 * start — the cost of waiting is a delay to a build nothing is reading, and
 * the cost of guessing wrong is contention on the table the fleet deals
 * from.
 */
export async function v30IsComplete(): Promise<boolean> {
  try {
    const { data, error } = await supabase.from('gto_agg_progress').select('street, done');
    if (error) return false;
    if (!Array.isArray(data) || data.length === 0) return false;
    return data.every((r) => r?.done === true);
  } catch {
    return false;
  }
}

/**
 * One tick: fold as many batches as fit the budget. Returns rows processed
 * (test seam).
 */
export async function gtoV31AggregationTick(generation?: number): Promise<number> {
  if (!lifecycleIsCurrent(generation)) return 0;
  if (finished || running) return 0;
  if (skipTicks > 0) {
    skipTicks--;
    return 0;
  }
  running = true;
  try {
    const v30Complete = await v30IsComplete();
    if (!lifecycleIsCurrent(generation)) return 0;
    if (!v30Complete) {
      if (!announcedWaiting) {
        announcedWaiting = true;
        console.log('[GtoAggregationDriverV31] waiting for the V30 aggregation to finish');
      }
      return 0;
    }
    const deadline = Date.now() + TICK_BUDGET_MS;
    let rows = 0;
    let calls = 0;
    while (calls < MAX_CALLS_PER_TICK && Date.now() < deadline) {
      calls++;
      const { data, error } = await supabase.rpc('fn_aggregate_gto_v31_next', {
        p_batch: BATCH,
      });
      if (!lifecycleIsCurrent(generation)) return rows;
      if (error) {
        if (isTimeout(error)) {
          if (rows === 0) {
            stalledTicks++;
            if (stalledTicks >= BACKOFF_AFTER_STALLED_TICKS) {
              skipTicks = 5; // ~100s of quiet before trying again
              stalledTicks = 0;
              console.warn('[GtoAggregationDriverV31] repeated timeouts - backing off for ~100s');
            }
          }
        } else {
          reportError(new Error(error.message), 'GtoAggregationDriverV31.tick');
        }
        return rows;
      }
      stalledTicks = 0;
      const row = Array.isArray(data) ? data[0] : data;
      rows += Number(row?.processed ?? 0);
      if (row?.is_done) {
        finished = true;
        console.log('[GtoAggregationDriverV31] v2 aggregation complete - going silent');
        stopGtoAggregationDriverV31();
        return rows;
      }
    }
    return rows;
  } catch (err) {
    reportError(err, 'GtoAggregationDriverV31.tick');
    return 0;
  } finally {
    running = false;
  }
}

function launchTick(): void {
  const generation = lifecycleGeneration;
  if (!lifecycleIsCurrent(generation) || inFlightTicks.size > 0) return;
  let tracked!: Promise<void>;
  tracked = gtoV31AggregationTick(generation)
    .then(() => undefined)
    .finally(() => inFlightTicks.delete(tracked));
  inFlightTicks.add(tracked);
}

async function drainTicks(): Promise<void> {
  while (inFlightTicks.size > 0) await Promise.allSettled([...inFlightTicks]);
}

export function startGtoAggregationDriverV31(): void {
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

export function stopGtoAggregationDriverV31(): Promise<void> {
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
export function _resetGtoAggregationDriverV31(): void {
  void stopGtoAggregationDriverV31();
  running = false;
  finished = false;
  stalledTicks = 0;
  skipTicks = 0;
  announcedWaiting = false;
}
