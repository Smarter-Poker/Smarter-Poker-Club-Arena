import { supabase } from '../lib/supabase';

export type CustomizationOperationEvent =
  | 'appearance_saved'
  | 'appearance_failed'
  | 'purchase_succeeded'
  | 'purchase_failed'
  | 'realtime_failed'
  | 'realtime_recovered'
  | 'conflict_suppressed';

export type CustomizationOperation = {
  userId: string | null | undefined;
  event: CustomizationOperationEvent;
  surface: 'table-studio' | 'table-runtime' | 'avatar-gallery';
  category?: string;
  durationMs?: number;
  reasonCode?: string;
};

const SUCCESS_SAMPLE_RATE = 0.2;
const SUCCESS_SAMPLE_WEIGHT = Math.round(1 / SUCCESS_SAMPLE_RATE);

/** Failures and recovery signals are always retained; routine success is sampled. */
export function shouldSampleCustomizationSuccess(
  event: CustomizationOperationEvent,
  random = Math.random()
): boolean {
  if (event !== 'appearance_saved' && event !== 'purchase_succeeded') return true;
  return random < SUCCESS_SAMPLE_RATE;
}

function safeToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, '_')
    .slice(0, 64);
}

/**
 * Append one privacy-safe operational signal. This is deliberately
 * fire-and-forget: observability may explain a broken customization path, but
 * it can never become the reason that path is broken.
 */
export function recordCustomizationOperation(operation: CustomizationOperation): void {
  try {
    if (!operation.userId || !shouldSampleCustomizationSuccess(operation.event)) return;
    const duration = Number(operation.durationMs);
    const row = {
      user_id: operation.userId,
      event: operation.event,
      surface: operation.surface,
      category: safeToken(operation.category),
      duration_ms: Number.isFinite(duration)
        ? Math.max(0, Math.min(300_000, Math.round(duration)))
        : null,
      reason_code: safeToken(operation.reasonCode),
      sample_weight:
        operation.event === 'appearance_saved' || operation.event === 'purchase_succeeded'
          ? SUCCESS_SAMPLE_WEIGHT
          : 1,
    };
    void Promise.resolve(supabase.from('customization_operations').insert(row))
      .then(({ error }) => {
        if (error) console.debug('[customization-telemetry] insert refused', error.message);
      })
      .catch(() => undefined);
  } catch {
    /* Operational telemetry must never surface to the player. */
  }
}
