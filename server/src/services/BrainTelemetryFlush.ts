/**
 * BRAIN TELEMETRY FLUSH — every minute, the day's layer-fire counters land
 * additively in horse_brain_telemetry (fn_brain_telemetry_add). A failed
 * flush restores the batch; the additive upsert makes retries safe. See
 * engine/BrainTelemetry.ts for what is being counted and why.
 */

import { supabase } from './supabase/client.js';
import { reportError } from './errorReporter.js';
import {
  enableBrainTelemetry,
  drainFires,
  restoreFires,
  drainDecisionLatency,
  restoreDecisionLatency,
} from '../engine/BrainTelemetry.js';

const FLUSH_MS = 60_000;
let timer: NodeJS.Timeout | null = null;
let lifecycleGeneration = 0;
let lifecycleActive = false;
let stopOperation: Promise<void> | null = null;
const inFlightFlushes = new Set<Promise<void>>();

async function flush(generation: number): Promise<void> {
  if (!lifecycleActive || lifecycleGeneration !== generation) return;
  const rows = drainFires();
  const day = new Date().toISOString().slice(0, 10);

  if (rows.length > 0) {
    const { error } = await supabase.rpc('fn_brain_telemetry_add', {
      p_day: day,
      p_rows: rows,
    });
    if (error) {
      reportError(new Error(error.message), 'BrainTelemetryFlush');
      restoreFires(rows);
    }
  }

  if (!lifecycleActive || lifecycleGeneration !== generation) return;

  // Decision latency rides the same minute. Drained SEPARATELY and restored
  // separately, so a failure on one does not silently discard the other —
  // these are two different questions ("did the layer fire" and "how long did
  // thinking take") and losing either to the other's outage would be a lie by
  // omission in whichever survived.
  const latency = drainDecisionLatency();
  if (latency.length > 0) {
    const { error: latErr } = await supabase.rpc('fn_horse_decision_latency_add', {
      p_day: day,
      p_rows: latency,
    });
    if (latErr) {
      reportError(new Error(latErr.message), 'BrainTelemetryFlush.latency');
      restoreDecisionLatency(latency);
    }
  }
}

function launchFlush(context: string): void {
  const generation = lifecycleGeneration;
  if (!lifecycleActive || inFlightFlushes.size > 0) return;
  let tracked!: Promise<void>;
  tracked = flush(generation)
    .catch((err: unknown) => reportError(err, context))
    .finally(() => inFlightFlushes.delete(tracked));
  inFlightFlushes.add(tracked);
}

async function drainFlushes(): Promise<void> {
  while (inFlightFlushes.size > 0) await Promise.allSettled([...inFlightFlushes]);
}

export function startBrainTelemetryFlush(): void {
  if (timer) return;
  if (process.env.BRAIN_TELEMETRY_ENABLED === 'false') return;
  lifecycleActive = true;
  lifecycleGeneration += 1;
  stopOperation = null;
  enableBrainTelemetry();
  timer = setInterval(() => {
    launchFlush('BrainTelemetryFlush.tick');
  }, FLUSH_MS);
  timer.unref?.();
}

export function stopBrainTelemetryFlush(): Promise<void> {
  if (stopOperation) return stopOperation;
  lifecycleActive = false;
  lifecycleGeneration += 1;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  stopOperation = drainFlushes();
  return stopOperation;
}
