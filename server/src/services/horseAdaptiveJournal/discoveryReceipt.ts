import { createHash } from 'node:crypto';

export type DiscoveryReceipt = Readonly<
  | { status: 'unknown' }
  | { status: 'idle'; retainedGaps: number }
  | { status: 'unavailable'; reason: string }
  | {
      status:
        | 'source_recorded'
        | 'admitted'
        | 'advanced'
        | 'discovered'
        | 'refined'
        | 'deferred'
        | 'gap';
      epochKey: string;
      fromMs: number;
      throughMs: number;
      cursorMs: number;
      sliceThroughMs: number;
      state: 'pending' | 'discovered' | 'gap';
      segments: number;
      actors: number;
      skippedEpochs: number;
      retainedGaps: number;
      reason: string | null;
      sourceCoverage: 'not_established';
    }
>;
const integer = (n: unknown, max = Number.MAX_SAFE_INTEGER): n is number =>
  Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= max;
const unavailableReasons = new Set(['discovery_busy', 'gap_budget_exceeded', 'retention_backlog']);
const deferredReasons = new Set([
  'backoff',
  'capture_queue_full',
  'snapshot_budget_exceeded',
  'atomic_receipt_missing',
  'invalid_roster',
  'capacity_busy',
]);
const gapReasons = new Set([
  'source_expired',
  'segment_budget_exceeded',
  'indivisible_source_budget',
  'actor_budget_exceeded',
  'evidence_budget_exceeded',
]);
const statuses = new Set([
  'source_recorded',
  'admitted',
  'advanced',
  'discovered',
  'refined',
  'deferred',
  'gap',
]);
const fields = new Set([
  'version',
  'status',
  'epochKey',
  'fromMs',
  'throughMs',
  'cursorMs',
  'sliceThroughMs',
  'state',
  'segments',
  'actors',
  'skippedEpochs',
  'retainedGaps',
  'reason',
  'sourceCoverage',
]);
export const unknownDiscovery = (): DiscoveryReceipt => Object.freeze({ status: 'unknown' });

/** Validate and copy the bounded receipt at both transport and worker IPC
 * boundaries. A discovered roster never establishes a complete model window. */
export function parseDiscoveryReceipt(value: unknown): DiscoveryReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unknownDiscovery();
  const r = value as Record<string, unknown>;
  if (r.version !== 1 || Object.keys(r).some((key) => !fields.has(key))) return unknownDiscovery();
  if (r.status === 'idle' && Object.keys(r).length === 3 && integer(r.retainedGaps, 128))
    return Object.freeze({ status: 'idle', retainedGaps: r.retainedGaps });
  if (r.status === 'unknown' && Object.keys(r).length === 2) return unknownDiscovery();
  if (
    r.status === 'unavailable' &&
    Object.keys(r).length === 3 &&
    typeof r.reason === 'string' &&
    unavailableReasons.has(r.reason)
  )
    return Object.freeze({ status: 'unavailable', reason: r.reason });
  if (
    typeof r.status !== 'string' ||
    !statuses.has(r.status) ||
    typeof r.epochKey !== 'string' ||
    !/^[a-f0-9]{64}$/.test(r.epochKey) ||
    !integer(r.fromMs) ||
    !integer(r.throughMs) ||
    r.throughMs <= r.fromMs ||
    r.throughMs - r.fromMs > 21600000 ||
    !integer(r.cursorMs) ||
    r.cursorMs < r.fromMs ||
    r.cursorMs > r.throughMs ||
    !integer(r.sliceThroughMs) ||
    r.sliceThroughMs < r.cursorMs ||
    r.sliceThroughMs > r.throughMs ||
    !integer(r.segments, 2048) ||
    !integer(r.actors, 8192) ||
    !integer(r.skippedEpochs, 2147483647) ||
    !integer(r.retainedGaps, 128) ||
    (r.status === 'gap' && r.retainedGaps < 1) ||
    (r.reason !== null && typeof r.reason !== 'string') ||
    r.sourceCoverage !== 'not_established'
  )
    return unknownDiscovery();
  const key = createHash('sha256')
    .update(['horse-discovery-v1', r.fromMs, r.throughMs].join('|'))
    .digest('hex');
  if (r.epochKey !== key) return unknownDiscovery();
  const state = r.status === 'discovered' ? 'discovered' : r.status === 'gap' ? 'gap' : 'pending';
  if (
    r.state !== state ||
    (state === 'discovered'
      ? r.cursorMs !== r.throughMs || r.sliceThroughMs !== r.throughMs
      : r.cursorMs >= r.throughMs || r.sliceThroughMs <= r.cursorMs)
  )
    return unknownDiscovery();
  if (
    r.status === 'gap'
      ? !gapReasons.has(String(r.reason))
      : r.status === 'deferred'
        ? !deferredReasons.has(String(r.reason))
        : r.status === 'refined'
          ? r.reason !== 'source_budget_exceeded'
          : r.reason !== null
  )
    return unknownDiscovery();
  if (
    (['source_recorded', 'admitted', 'advanced', 'discovered'].includes(r.status) &&
      r.segments === 0) ||
    (r.actors > 0 && r.segments === 0)
  )
    return unknownDiscovery();
  return Object.freeze({
    status: r.status,
    epochKey: r.epochKey,
    fromMs: r.fromMs,
    throughMs: r.throughMs,
    cursorMs: r.cursorMs,
    sliceThroughMs: r.sliceThroughMs,
    state,
    segments: r.segments,
    actors: r.actors,
    skippedEpochs: r.skippedEpochs,
    retainedGaps: r.retainedGaps,
    reason: r.reason,
    sourceCoverage: 'not_established',
  }) as DiscoveryReceipt;
}
