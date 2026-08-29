/**
 * GTO AGGREGATION DRIVER (V30, Dan 2026-08-29)
 *
 * Paces the one-time turn/river aggregation of the solver warehouse: every
 * tick it asks fn_aggregate_gto_street_next to fold the next small batch of
 * solved_spots_gold rows into gto_postflop_compact — turn first (3.18M
 * rows), then river (5.59M). The cursor lives in gto_agg_progress, so the
 * build is restart-safe: a redeploy resumes exactly where it stopped, and
 * once both streets report done the driver goes permanently silent (it
 * checks once at boot and stops itself).
 *
 * WHY THE ENGINE PACES IT: the 2026-08-15 incident (one COUNT starved the
 * DB) rules out any big offline pass over the 79 GB table. Small bounded
 * batches with rests between them keep the duty cycle low, and the engine
 * is the one place that is always running. The work happens in Postgres;
 * this service holds no data and touches nothing on the deal path.
 *
 * TIMEOUT DISCIPLINE: statement_timeout is armed when the statement starts,
 * so the only real control is batch size. On a timeout (57014) the batch
 * halves (floor 200) and the driver keeps going; after a clean streak it
 * climbs back up (cap 1200 — measured: 500 rows in a few seconds, 2000
 * over 8s). Any other error is reported and retried next tick unchanged.
 */

import { supabase } from './supabase/client.js';
import { reportError } from './errorReporter.js';

const TICK_MS = 20_000;
const BOOT_DELAY_MS = 45_000; // after the loaders; never in the boot rush
const BATCH_START = 600;
const BATCH_MIN = 200;
const BATCH_MAX = 1200;
const GROW_AFTER_CLEAN = 10; // ticks without a timeout before growing

const STREETS = ['turn', 'river'] as const;

let timer: NodeJS.Timeout | null = null;
let bootTimer: NodeJS.Timeout | null = null;
let running = false;
let batch = BATCH_START;
let cleanStreak = 0;
let streetIdx = 0;
let finished = false;

export function gtoAggregationFinished(): boolean {
  return finished;
}

/** One tick: advance the current street's cursor by one batch. */
export async function gtoAggregationTick(): Promise<void> {
  if (finished || running) return;
  running = true;
  try {
    while (streetIdx < STREETS.length) {
      const street = STREETS[streetIdx];
      const { data, error } = await supabase.rpc('fn_aggregate_gto_street_next', {
        p_street: street,
        p_batch: batch,
      });
      if (error) {
        // 57014 = statement timeout: the batch was too big for the
        // connection's budget. Halve and try again next tick.
        if (error.code === '57014' || /statement timeout/i.test(error.message ?? '')) {
          batch = Math.max(BATCH_MIN, Math.floor(batch / 2));
          cleanStreak = 0;
          console.warn(`[GtoAggregationDriver] ${street} batch timed out; batch now ${batch}`);
        } else {
          reportError(new Error(error.message), 'GtoAggregationDriver.tick');
        }
        return;
      }
      const row = Array.isArray(data) ? data[0] : data;
      const done = !!row?.street_done;
      cleanStreak++;
      if (cleanStreak >= GROW_AFTER_CLEAN && batch < BATCH_MAX) {
        batch = Math.min(BATCH_MAX, batch * 2);
        cleanStreak = 0;
      }
      if (!done) return; // one batch per tick — pacing is the point
      console.log(`[GtoAggregationDriver] ${street} aggregation complete`);
      streetIdx++;
    }
    finished = true;
    console.log('[GtoAggregationDriver] all streets aggregated — going silent');
    stopGtoAggregationDriver();
  } catch (err) {
    reportError(err, 'GtoAggregationDriver.tick');
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
  batch = BATCH_START;
  cleanStreak = 0;
  streetIdx = 0;
  finished = false;
}
