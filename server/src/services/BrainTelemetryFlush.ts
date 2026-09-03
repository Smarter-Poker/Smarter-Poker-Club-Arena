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

async function flush(): Promise<void> {
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

export function startBrainTelemetryFlush(): void {
  if (timer) return;
  if (process.env.BRAIN_TELEMETRY_ENABLED === 'false') return;
  enableBrainTelemetry();
  timer = setInterval(() => {
    void flush().catch((err: unknown) => reportError(err, 'BrainTelemetryFlush.tick'));
  }, FLUSH_MS);
  timer.unref?.();
}

export function stopBrainTelemetryFlush(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
