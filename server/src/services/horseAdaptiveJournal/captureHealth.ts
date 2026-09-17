export type CaptureQueueHealth =
  | Readonly<{ status: 'unknown' }>
  | Readonly<{ status: 'unavailable'; reason: 'queue_budget_exceeded' }>
  | Readonly<{
      status: 'snapshot';
      sampledAtMs: number;
      unfinished: number;
      queued: number;
      leased: number;
      gaps: number;
      ready: number;
      expiredLeases: number;
      oldestWorkAgeMs: number;
      maxAttempts: number;
    }>;
const integer = (v: unknown, max: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max;
/** Identity-free unfinished acquisition counts. Empty is never completeness. */
export function parseCaptureQueueHealth(input: unknown, now = Date.now()): CaptureQueueHealth {
  const unknown = () => Object.freeze({ status: 'unknown' as const });
  if (!input || typeof input !== 'object' || Array.isArray(input)) return unknown();
  const d = input as Record<string, unknown>;
  if (d.version !== 1) return unknown();
  if (d.status === 'unavailable' && d.reason === 'queue_budget_exceeded')
    return Object.freeze({ status: 'unavailable', reason: 'queue_budget_exceeded' });
  if (
    d.status !== 'snapshot' ||
    !integer(d.sampledAtMs, Number.MAX_SAFE_INTEGER) ||
    Math.abs(now - d.sampledAtMs) > 60000 ||
    !['unfinished', 'queued', 'leased', 'gaps', 'ready', 'expiredLeases'].every((k) =>
      integer(d[k], 256)
    ) ||
    !integer(d.oldestWorkAgeMs, Number.MAX_SAFE_INTEGER) ||
    !integer(d.maxAttempts, 1000000)
  )
    return unknown();
  const v = d as unknown as Extract<CaptureQueueHealth, { status: 'snapshot' }>;
  if (
    v.queued + v.leased + v.gaps !== v.unfinished ||
    v.ready > v.queued + v.leased ||
    v.expiredLeases > v.leased ||
    v.expiredLeases > v.ready ||
    (v.unfinished === 0 && (v.oldestWorkAgeMs !== 0 || v.maxAttempts !== 0))
  )
    return unknown();
  return Object.freeze({
    status: 'snapshot',
    sampledAtMs: v.sampledAtMs,
    unfinished: v.unfinished,
    queued: v.queued,
    leased: v.leased,
    gaps: v.gaps,
    ready: v.ready,
    expiredLeases: v.expiredLeases,
    oldestWorkAgeMs: v.oldestWorkAgeMs,
    maxAttempts: v.maxAttempts,
  });
}
