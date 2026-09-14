export type JournalQueueHealth =
  | Readonly<{ status: 'unknown' }>
  | Readonly<{
      status: 'unavailable';
      reason: 'queue_budget_exceeded';
    }>
  | Readonly<{
      status: 'snapshot';
      sampledAtMs: number;
      unfinished: number;
      queued: number;
      leased: number;
      quarantined: number;
      ready: number;
      expiredLeases: number;
      bufferedBytes: number;
      oldestWorkAgeMs: number;
      maxAttempts: number;
    }>;
const integer = (v: unknown, max: number) =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max;
/** Pure allowlist for IPC and RPC. No queue payload, identity or error text
 * may reach public engine health. Counters are global unfinished work only. */
export function parseJournalQueueHealth(data: unknown, now = Date.now()): JournalQueueHealth {
  const unknown = (): JournalQueueHealth => Object.freeze({ status: 'unknown' });
  if (!data || typeof data !== 'object' || Array.isArray(data)) return unknown();
  const d = data as Record<string, unknown>;
  if (d.version !== 1) return unknown();
  if (d.status === 'unavailable' && d.reason === 'queue_budget_exceeded')
    return Object.freeze({ status: 'unavailable', reason: 'queue_budget_exceeded' });
  if (
    d.status !== 'snapshot' ||
    !integer(d.sampledAtMs, Number.MAX_SAFE_INTEGER) ||
    Math.abs(now - (d.sampledAtMs as number)) > 60000 ||
    !['unfinished', 'queued', 'leased', 'quarantined', 'ready', 'expiredLeases'].every((k) =>
      integer(d[k], 256)
    ) ||
    !integer(d.bufferedBytes, 67108864) ||
    !integer(d.oldestWorkAgeMs, Number.MAX_SAFE_INTEGER) ||
    !integer(d.maxAttempts, 1000000)
  )
    return unknown();
  const v = d as unknown as Extract<JournalQueueHealth, { status: 'snapshot' }>;
  if (
    v.queued + v.leased + v.quarantined !== v.unfinished ||
    v.ready > v.queued + v.leased ||
    v.expiredLeases > v.leased ||
    v.expiredLeases > v.ready ||
    (v.unfinished === 0 &&
      (v.bufferedBytes !== 0 || v.oldestWorkAgeMs !== 0 || v.maxAttempts !== 0))
  )
    return unknown();
  return Object.freeze({
    status: 'snapshot',
    sampledAtMs: v.sampledAtMs,
    unfinished: v.unfinished,
    queued: v.queued,
    leased: v.leased,
    quarantined: v.quarantined,
    ready: v.ready,
    expiredLeases: v.expiredLeases,
    bufferedBytes: v.bufferedBytes,
    oldestWorkAgeMs: v.oldestWorkAgeMs,
    maxAttempts: v.maxAttempts,
  });
}
