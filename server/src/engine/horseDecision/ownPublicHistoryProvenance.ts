import {
  horseObserverReadContextKey,
  type HorseObserverReadContext,
} from '../HorseObserverReadContext.js';

/** Closed operational reasons only; never transport errors, cards or provider responses. */
export const HORSE_HISTORY_LOAD_FAILURES = [
  'provider_error',
  'provider_empty_response',
  'provider_source_mismatch',
  'provider_invalid_window',
  'provider_deadline',
  'provider_thrown',
] as const;
export type HorseHistoryLoadFailure = (typeof HORSE_HISTORY_LOAD_FAILURES)[number];
export type HorseHistoryLoadReporter = (reason: HorseHistoryLoadFailure) => void;
export type HorseOwnPublicHistoryLoader = (
  context: HorseObserverReadContext,
  report?: HorseHistoryLoadReporter
) => Promise<unknown>;

const PENDING_REASONS = ['loading', 'load_capacity'] as const;
const AVAILABLE_REASONS = ['packet_ready', 'worker_acknowledged', 'packet_after_cutoff'] as const;
const UNAVAILABLE_REASONS = [
  ...HORSE_HISTORY_LOAD_FAILURES,
  'cache_disposed',
  'retry_load_capacity',
  'retention_invalid_claim',
  'retention_heap_unavailable',
  'retention_heap_headroom',
  'retention_capacity',
  'invalid_window',
  'context_mismatch',
  'packet_size_refused',
  'load_rejected',
  'load_thrown',
] as const;
export type HorseHistoryReadReason =
  | (typeof PENDING_REASONS)[number]
  | (typeof AVAILABLE_REASONS)[number]
  | (typeof UNAVAILABLE_REASONS)[number];
export interface HorseHistoryReadProvenance {
  readonly version: 1;
  readonly context: HorseObserverReadContext;
  readonly decisionTimeMs: number;
  /** Cache availability, not proof that this worker consumed loaded history. */
  readonly state: 'pending' | 'available' | 'unavailable';
  readonly reason: HorseHistoryReadReason;
}

export function horseHistoryReadProvenanceIsValid(
  value: unknown,
  context: HorseObserverReadContext,
  state: unknown,
  decisionTimeMs: number
): value is HorseHistoryReadProvenance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  const key = horseObserverReadContextKey(context);
  if (
    !key ||
    Object.keys(p).length !== 5 ||
    !['version', 'context', 'decisionTimeMs', 'state', 'reason'].every((k) =>
      Object.hasOwn(p, k)
    ) ||
    p.version !== 1 ||
    !Number.isSafeInteger(p.decisionTimeMs) ||
    (p.decisionTimeMs as number) < 0 ||
    p.decisionTimeMs !== decisionTimeMs ||
    horseObserverReadContextKey(p.context) !== key ||
    p.state !== state
  )
    return false;
  const reasons: readonly string[] =
    p.state === 'pending'
      ? PENDING_REASONS
      : p.state === 'available'
        ? AVAILABLE_REASONS
        : p.state === 'unavailable'
          ? UNAVAILABLE_REASONS
          : [];
  return typeof p.reason === 'string' && reasons.includes(p.reason);
}
