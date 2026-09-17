/**
 * BRAIN TELEMETRY FLUSH — every minute, the day's layer-fire counters land
 * atomically with private batch/source receipts. Retries retain the same
 * immutable ID and bytes, so an uncertain acknowledgement cannot double-add. See
 * engine/BrainTelemetry.ts for what is being counted and why.
 */

import { supabase } from './supabase/client.js';
import { reportError } from './errorReporter.js';
import { HorseBrainTelemetryPublisher } from './HorseBrainTelemetryPublisher.js';
import { resolveReleaseIdentity } from '../releaseIdentity.js';
import {
  enableBrainTelemetry,
  drainFires,
  drainDecisionLatency,
  noteFire,
} from '../engine/BrainTelemetry.js';

const FLUSH_MS = 60_000;
let timer: NodeJS.Timeout | null = null;
let lifecycleGeneration = 0;
let lifecycleActive = false;
let stopOperation: Promise<void> | null = null;
const inFlightFlushes = new Set<Promise<void>>();
const publisher = new HorseBrainTelemetryPublisher({
  capture: () => ({ fires: drainFires(), latency: drainDecisionLatency() }),
  sourceRelease: () => resolveReleaseIdentity().releaseSha,
  send: async (payload) =>
    supabase
      .rpc('fn_horse_brain_flush_receipt', { p_payload: payload })
      .abortSignal(AbortSignal.timeout(5000)),
});

async function publishBatch(): Promise<'idle' | 'recorded' | 'replayed' | 'expired'> {
  const result = await publisher.flush();
  if (result === 'expired') {
    noteFire('phase15_telemetry_batch_expired');
    reportError(
      new Error('Horse telemetry batch exceeded the retained receipt window'),
      'BrainTelemetryFlush.expired'
    );
  }
  return result;
}

async function flush(generation: number): Promise<void> {
  if (!lifecycleActive || lifecycleGeneration !== generation) return;
  await publishBatch();
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

/** The worker calls stop only after its accepted decision FIFO has drained.
 * Finish an uncertain retained batch first, then capture the partial interval
 * behind it. At most two existing five-second writes; no retry loop or disk
 * durability claim. A restart takes ownership before either new capture. */
async function finishFlushes(generation: number, wasActive: boolean): Promise<void> {
  await drainFlushes();
  if (!wasActive) return;
  for (let batch = 0; batch < 2; batch++) {
    if (lifecycleActive || lifecycleGeneration !== generation) return;
    if ((await publishBatch()) === 'idle') return;
  }
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
  const wasActive = lifecycleActive;
  lifecycleActive = false;
  lifecycleGeneration += 1;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  stopOperation = finishFlushes(lifecycleGeneration, wasActive).catch((error) => {
    reportError(error, 'BrainTelemetryFlush.stop');
    throw error;
  });
  return stopOperation;
}
