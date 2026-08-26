/**
 * BRAIN TELEMETRY FLUSH — every minute, the day's layer-fire counters land
 * additively in horse_brain_telemetry (fn_brain_telemetry_add). A failed
 * flush restores the batch; the additive upsert makes retries safe. See
 * engine/BrainTelemetry.ts for what is being counted and why.
 */

import { supabase } from './supabase/client.js';
import { reportError } from './errorReporter.js';
import { enableBrainTelemetry, drainFires, restoreFires } from '../engine/BrainTelemetry.js';

const FLUSH_MS = 60_000;
let timer: NodeJS.Timeout | null = null;

async function flush(): Promise<void> {
  const rows = drainFires();
  if (rows.length === 0) return;
  const day = new Date().toISOString().slice(0, 10);
  const { error } = await supabase.rpc('fn_brain_telemetry_add', {
    p_day: day,
    p_rows: rows,
  });
  if (error) {
    reportError(new Error(error.message), 'BrainTelemetryFlush');
    restoreFires(rows);
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
