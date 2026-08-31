import { supabase } from '../lib/supabase';

export type DailyMissionOperationEvent =
  | 'dashboard_loaded'
  | 'dashboard_failed'
  | 'claim_succeeded'
  | 'claim_failed'
  | 'claim_all_succeeded'
  | 'claim_all_failed'
  | 'reroll_succeeded'
  | 'reroll_failed'
  | 'freeze_succeeded'
  | 'freeze_failed'
  | 'realtime_degraded'
  | 'realtime_recovered'
  | 'alerts_enabled'
  | 'alerts_disabled'
  | 'alerts_failed'
  | 'mission_cta_opened';

export type DailyMissionOperation = {
  userId: string | null | undefined;
  event: DailyMissionOperationEvent;
  tier?: 'daily' | 'weekly' | 'monthly';
  durationMs?: number;
  itemCount?: number;
  reasonCode?: string;
};

const SUCCESS_SAMPLE_RATE = 0.2;
const SUCCESS_SAMPLE_WEIGHT = Math.round(1 / SUCCESS_SAMPLE_RATE);

const FAILURE_EVENTS = new Set<DailyMissionOperationEvent>([
  'dashboard_failed',
  'claim_failed',
  'claim_all_failed',
  'reroll_failed',
  'freeze_failed',
  'realtime_degraded',
  'alerts_failed',
]);

const ROUTINE_SUCCESS_EVENTS = new Set<DailyMissionOperationEvent>([
  'dashboard_loaded',
  'mission_cta_opened',
]);

export function shouldRecordDailyMissionOperation(
  event: DailyMissionOperationEvent,
  random = Math.random()
): boolean {
  return !ROUTINE_SUCCESS_EVENTS.has(event) || random < SUCCESS_SAMPLE_RATE;
}

function boundedInt(value: number | undefined, max = 300_000): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(max, Math.round(parsed))) : null;
}

function safeToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, '_')
    .slice(0, 64);
}

/** Convert an exception into a bounded operational category without storing its message. */
export function dailyMissionReasonCode(error: unknown): string {
  if (!error || typeof error !== 'object') return 'unknown';
  const candidate = error as { code?: unknown; name?: unknown };
  if (typeof candidate.code === 'string' && candidate.code.trim()) {
    return safeToken(candidate.code) || 'unknown';
  }
  if (typeof candidate.name === 'string' && candidate.name.trim()) {
    return safeToken(candidate.name) || 'unknown';
  }
  return 'unknown';
}

/**
 * Append one privacy-safe mission health signal. Observability is always
 * fire-and-forget: it may explain a failed action but can never fail one.
 */
export function recordDailyMissionOperation(operation: DailyMissionOperation): void {
  try {
    if (!operation.userId || !shouldRecordDailyMissionOperation(operation.event)) return;
    const routineSuccess = ROUTINE_SUCCESS_EVENTS.has(operation.event);
    const row = {
      user_id: operation.userId,
      event: operation.event,
      tier: operation.tier || null,
      duration_ms: boundedInt(operation.durationMs),
      item_count: boundedInt(operation.itemCount, 10_000),
      reason_code: safeToken(operation.reasonCode),
      sample_weight: routineSuccess ? SUCCESS_SAMPLE_WEIGHT : 1,
    };
    void Promise.resolve(supabase.from('daily_mission_operations').insert(row))
      .then(({ error }) => {
        if (error) console.debug('[daily-mission-telemetry] insert refused', error.message);
      })
      .catch(() => undefined);
  } catch {
    /* Operational telemetry must never surface to the player. */
  }
}

export function isDailyMissionFailure(event: DailyMissionOperationEvent): boolean {
  return FAILURE_EVENTS.has(event);
}
