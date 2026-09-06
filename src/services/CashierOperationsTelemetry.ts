import { supabase } from '../lib/supabase';

export type CashierOperationEvent =
  | 'roster_page_succeeded'
  | 'roster_page_failed'
  | 'batch_succeeded'
  | 'batch_partial'
  | 'batch_failed';

export type CashierOperation = {
  userId: string | null | undefined;
  clubId: string | null | undefined;
  event: CashierOperationEvent;
  operation: 'roster' | 'send' | 'ticket';
  durationMs?: number;
  itemCount?: number;
  pageNumber?: number;
  successCount?: number;
  failureCount?: number;
  reasonCode?: string;
};

const SUCCESS_SAMPLE_RATE = 0.1;

function isFailure(event: CashierOperationEvent): boolean {
  return event === 'roster_page_failed' || event === 'batch_partial' || event === 'batch_failed';
}

/** Failures are complete; routine success is sampled to keep the sink cheap. */
export function shouldRecordCashierOperation(
  event: CashierOperationEvent,
  random = Math.random()
): boolean {
  return isFailure(event) || random < SUCCESS_SAMPLE_RATE;
}

function boundedInt(value: number | undefined, max = 1_000_000): number | null {
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

/** Convert a Supabase/server error to a bounded category without storing its message. */
export function cashierReasonCode(error: unknown): string {
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
 * Append one privacy-safe operational signal. This is deliberately
 * fire-and-forget: observability can explain a cashier failure, but can never
 * become the reason a money action or roster load fails.
 */
export function recordCashierOperation(operation: CashierOperation): void {
  try {
    if (!operation.userId || !operation.clubId || !shouldRecordCashierOperation(operation.event)) {
      return;
    }
    const args = {
      p_club_id: operation.clubId,
      p_event: operation.event,
      p_operation: operation.operation,
      p_duration_ms: boundedInt(operation.durationMs, 300_000),
      p_item_count: boundedInt(operation.itemCount),
      p_page_number: boundedInt(operation.pageNumber, 100_000),
      p_success_count: boundedInt(operation.successCount),
      p_failure_count: boundedInt(operation.failureCount),
      p_reason_code: safeToken(operation.reasonCode),
    };
    // The database derives user_id from auth.uid(), validates this club scope,
    // and derives sample_weight. Neither identity nor SLO weighting is trusted
    // to a browser-provided row anymore.
    void Promise.resolve(supabase.rpc('fn_record_cashier_operation', args))
      .then(({ error }) => {
        if (error) console.debug('[cashier-telemetry] RPC refused', error.message);
      })
      .catch(() => undefined);
  } catch {
    /* Operational telemetry must never surface to the cashier. */
  }
}
