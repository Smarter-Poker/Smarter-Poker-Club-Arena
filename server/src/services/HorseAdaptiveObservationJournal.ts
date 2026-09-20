import { createHash } from 'node:crypto';
import { supabase } from './supabase.js';
import type { CommittedObservationSnapshot } from './HorseCommittedObservationSnapshot.js';
import {
  adaptiveSessionPartition,
  ADAPTIVE_OBSERVATION_HORIZON_MS,
  type AdaptivePartition,
  type QualifiedAdaptiveObservation,
} from '../engine/HorseAdaptiveObservation.js';

export const ADAPTIVE_JOURNAL_LIMITS = Object.freeze({
  observations: 20_000,
  batchBytes: 16_777_216,
  observationBytes: 16_384,
  scopeBytes: 8192,
  timeoutMs: 5000,
});
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const bytes = (value: string) => Buffer.byteLength(value);
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const digest = (v: unknown): v is string => typeof v === 'string' && SHA.test(v);
const refusal = (reason: string) => Object.freeze({ status: 'unavailable' as const, reason });
const actions = ['fold', 'check', 'call', 'bet', 'raise'];
const origins = ['player', 'pre_action', 'horse_policy'];

/** Only the qualifier's bounded public array vocabulary crosses this boundary. */
function freezeScope(value: unknown): readonly unknown[] {
  let nodes = 0;
  const visit = (v: unknown, depth: number): unknown => {
    if (++nodes > 1024 || depth > 8) throw Error('invalid_scope');
    if (Array.isArray(v)) return Object.freeze(v.map((item) => visit(item, depth + 1)));
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))
      return v;
    if (typeof v === 'string' && v.length <= 64 && !/[{}]/.test(v)) return v;
    throw Error('invalid_scope');
  };
  if (!Array.isArray(value) || value.length !== 29 || value[0] !== 'adaptive-public-node-v1')
    throw Error('invalid_scope');
  return visit(value, 0) as readonly unknown[];
}

/** Canonical tuple preserves exact bytes for conflict detection across restarts. */
function encode(o: QualifiedAdaptiveObservation): string {
  return JSON.stringify([
    o.version,
    o.observationId,
    o.handId,
    o.actorKey,
    o.sessionKey,
    o.observedAtMs,
    o.partition,
    o.scopeKey,
    JSON.stringify(o.scope),
    o.action,
    o.facedBet,
    o.origin,
  ]);
}

function decodeWithScope(
  text: unknown,
  knownScope?: { raw: string; frozen: readonly unknown[] }
): QualifiedAdaptiveObservation {
  if (typeof text !== 'string' || bytes(text) > ADAPTIVE_JOURNAL_LIMITS.observationBytes)
    throw Error('invalid_observation');
  const a = JSON.parse(text);
  if (
    !Array.isArray(a) ||
    a.length !== 12 ||
    a[0] !== 1 ||
    typeof a[2] !== 'string' ||
    !UUID.test(a[2]) ||
    typeof a[1] !== 'string' ||
    !a[1].startsWith(a[2] + ':') ||
    !/^(?:0|[1-9][0-9]{0,3})$/.test(a[1].slice(37)) ||
    Number(a[1].slice(37)) >= 4096 ||
    !digest(a[3]) ||
    !digest(a[4]) ||
    !integer(a[5]) ||
    a[5] < 0 ||
    !['training', 'holdout'].includes(a[6]) ||
    adaptiveSessionPartition(a[4]) !== a[6] ||
    !digest(a[7]) ||
    typeof a[8] !== 'string' ||
    bytes(a[8]) > ADAPTIVE_JOURNAL_LIMITS.scopeBytes ||
    hash(a[8]) !== a[7] ||
    !actions.includes(a[9]) ||
    typeof a[10] !== 'boolean' ||
    !origins.includes(a[11])
  )
    throw Error('invalid_observation');
  const o: QualifiedAdaptiveObservation = Object.freeze({
    version: 1,
    observationId: a[1],
    handId: a[2],
    actorKey: a[3],
    sessionKey: a[4],
    observedAtMs: a[5],
    partition: a[6],
    scopeKey: a[7],
    scope: knownScope?.raw === a[8] ? knownScope.frozen : freezeScope(JSON.parse(a[8])),
    action: a[9],
    facedBet: a[10],
    origin: a[11],
  });
  if (encode(o) !== text) throw Error('noncanonical_observation');
  return o;
}
export function decodeAdaptiveJournalObservation(text: unknown): QualifiedAdaptiveObservation {
  return decodeWithScope(text);
}
const decode = decodeAdaptiveJournalObservation;

/** Model sweeps contain exactly one public node. Reuse its frozen, validated
 * scope instead of retaining thousands of identical nested arrays. Every row
 * still passes digest, canonical encoding, partition and identity validation. */
export function decodeScopedAdaptiveJournalObservations(
  rows: readonly string[],
  scopeKey: string
): readonly QualifiedAdaptiveObservation[] {
  if (!digest(scopeKey) || rows.length > ADAPTIVE_JOURNAL_LIMITS.observations)
    throw Error('invalid_scope');
  let knownScope: { raw: string; frozen: readonly unknown[] } | undefined;
  return rows.map((text) => {
    const observation = decodeWithScope(text, knownScope);
    if (observation.scopeKey !== scopeKey) throw Error('invalid_scope');
    knownScope ??= { raw: JSON.stringify(observation.scope), frozen: observation.scope };
    return observation;
  });
}

export interface PreparedAdaptiveJournalBatch {
  readonly status: 'prepared';
  readonly batchKey: string;
  readonly batchDigest: string;
  readonly observations: number;
  readonly payload: string;
}

/** Pure preparation: no background timer, activation, counter or data write. */
export function prepareAdaptiveJournalBatch(
  snapshot: CommittedObservationSnapshot
): PreparedAdaptiveJournalBatch | ReturnType<typeof refusal> {
  try {
    if (
      !snapshot ||
      snapshot.status !== 'snapshot' ||
      snapshot.version !== 1 ||
      !digest(snapshot.actorKey) ||
      !snapshot.source ||
      snapshot.source.coverage !== 'retained_committed_roster_rows' ||
      snapshot.source.acceptance !== 'atomic_hand_receipts' ||
      !digest(snapshot.source.sourceDigest) ||
      !integer(snapshot.source.fromMs) ||
      !integer(snapshot.source.throughMs) ||
      snapshot.source.fromMs < 0 ||
      snapshot.source.throughMs <= snapshot.source.fromMs ||
      snapshot.source.throughMs - snapshot.source.fromMs > 21_600_000 ||
      !integer(snapshot.source.readAtMs) ||
      snapshot.source.throughMs > snapshot.source.readAtMs ||
      !Array.isArray(snapshot.observations) ||
      snapshot.observations.length > ADAPTIVE_JOURNAL_LIMITS.observations ||
      !snapshot.rejected ||
      typeof snapshot.rejected !== 'object' ||
      Array.isArray(snapshot.rejected)
    )
      return refusal('invalid_snapshot');
    const rejected = Object.entries(snapshot.rejected).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    );
    if (
      rejected.length > 64 ||
      rejected.some(
        ([reason, count]) =>
          !/^[a-z_]{1,64}$/.test(reason) || !integer(count) || count < 0 || count > 20_000
      )
    )
      return refusal('invalid_rejections');
    const ids = new Set<string>();
    const rows = snapshot.observations
      .map((item) => {
        const text = encode(item),
          o = decode(text);
        if (
          o.actorKey !== snapshot.actorKey ||
          ids.has(o.observationId) ||
          o.observedAtMs > snapshot.source.readAtMs ||
          o.observedAtMs < snapshot.source.readAtMs - ADAPTIVE_OBSERVATION_HORIZON_MS
        )
          throw Error('invalid_observation');
        ids.add(o.observationId);
        return { id: o.observationId, text };
      })
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const s = snapshot.source;
    const batchKey = hash(
      ['adaptive-journal-v1', snapshot.actorKey, s.sourceDigest, s.fromMs, s.throughMs].join('|')
    );
    const payload = JSON.stringify([
      1,
      batchKey,
      snapshot.actorKey,
      s.fromMs,
      s.throughMs,
      s.sourceDigest,
      rejected,
      rows.map((row) => row.text),
    ]);
    if (bytes(payload) > ADAPTIVE_JOURNAL_LIMITS.batchBytes)
      return refusal('batch_budget_exceeded');
    return Object.freeze({
      status: 'prepared',
      batchKey,
      batchDigest: hash(payload),
      observations: rows.length,
      payload,
    });
  } catch {
    return refusal('invalid_observation');
  }
}

export type AdaptiveJournalWriteResult =
  | ReturnType<typeof refusal>
  | Readonly<{
      status: 'recorded' | 'unknown' | 'rejected';
      batchKey: string;
      batchDigest: string;
      observations: number;
    }>;

/** Validate recovered canonical bytes without inventing a new source snapshot.
 * A historical receipt proves what was recorded, not current-window coverage. */
export function validateAdaptiveJournalBatchPayload(
  payload: unknown
): PreparedAdaptiveJournalBatch {
  if (typeof payload !== 'string' || bytes(payload) > ADAPTIVE_JOURNAL_LIMITS.batchBytes)
    throw Error('invalid_batch');
  const b = JSON.parse(payload);
  if (
    !Array.isArray(b) ||
    b.length !== 8 ||
    b[0] !== 1 ||
    !digest(b[1]) ||
    !digest(b[2]) ||
    !integer(b[3]) ||
    !integer(b[4]) ||
    b[3] < 0 ||
    b[4] <= b[3] ||
    b[4] - b[3] > 21_600_000 ||
    !digest(b[5]) ||
    !Array.isArray(b[6]) ||
    b[6].length > 64 ||
    !Array.isArray(b[7]) ||
    b[7].length > ADAPTIVE_JOURNAL_LIMITS.observations ||
    b[1] !== hash(['adaptive-journal-v1', b[2], b[5], b[3], b[4]].join('|'))
  )
    throw Error('invalid_batch');
  let previousReason = '';
  for (const r of b[6]) {
    if (
      !Array.isArray(r) ||
      r.length !== 2 ||
      typeof r[0] !== 'string' ||
      !/^[a-z_]{1,64}$/.test(r[0]) ||
      r[0] <= previousReason ||
      !integer(r[1]) ||
      r[1] < 0 ||
      r[1] > 20_000
    )
      throw Error('invalid_batch');
    previousReason = r[0];
  }
  let previousId = '';
  for (const row of b[7]) {
    const o = decode(row);
    if (o.actorKey !== b[2] || o.observationId <= previousId) throw Error('invalid_batch');
    previousId = o.observationId;
  }
  // Whitespace, duplicate keys/IDs, noncanonical numbers and substituted row
  // encodings cannot acquire the receipt of the bytes originally submitted.
  if (JSON.stringify(b) !== payload) throw Error('invalid_batch');
  return Object.freeze({
    status: 'prepared',
    batchKey: b[1],
    batchDigest: hash(payload),
    observations: b[7].length,
    payload,
  });
}

/** Recover the exact submitted public batch by its previously computed key.
 * Missing/legacy payloads remain unavailable; never reconstruct from a newer
 * source query or claim that a missing receipt proves a write rolled back. */
export async function readAdaptiveJournalBatch(
  batchKey: string
): Promise<PreparedAdaptiveJournalBatch | ReturnType<typeof refusal>> {
  if (!digest(batchKey)) return refusal('invalid_request');
  try {
    const { data, error } = await supabase
      .rpc('fn_horse_adaptive_journal_batch', {
        p_batch_key: batchKey,
      })
      .abortSignal(AbortSignal.timeout(ADAPTIVE_JOURNAL_LIMITS.timeoutMs));
    if (error) return refusal('source_unavailable');
    if (data?.version !== 1) return refusal('invalid_receipt');
    if (data.status === 'unavailable')
      return refusal(
        ['batch_not_found', 'legacy_batch_payload_unavailable'].includes(data.reason)
          ? data.reason
          : 'invalid_receipt'
      );
    if (data.status !== 'recorded') return refusal('invalid_receipt');
    const batch = validateAdaptiveJournalBatchPayload(data.payload);
    if (
      batch.batchKey !== batchKey ||
      data.batchKey !== batch.batchKey ||
      data.batchDigest !== batch.batchDigest ||
      data.observations !== batch.observations
    )
      return refusal('invalid_receipt');
    return batch;
  } catch {
    return refusal('invalid_receipt');
  }
}

/** Retry recovered bytes after restart. Validation completes before any await,
 * so a mutable caller cannot replace the batch being verified or submitted. */
export async function persistPreparedAdaptiveJournalBatch(
  input: PreparedAdaptiveJournalBatch
): Promise<AdaptiveJournalWriteResult> {
  let batch: PreparedAdaptiveJournalBatch;
  try {
    batch = validateAdaptiveJournalBatchPayload(input?.payload);
    if (
      input.status !== 'prepared' ||
      input.batchKey !== batch.batchKey ||
      input.batchDigest !== batch.batchDigest ||
      input.observations !== batch.observations
    )
      return refusal('invalid_batch');
  } catch {
    return refusal('invalid_batch');
  }
  return persistVerifiedBatch(batch);
}

/** A lost reply is UNKNOWN. Retry the same snapshot; never assume it rolled back. */
export async function persistAdaptiveJournalSnapshot(
  snapshot: CommittedObservationSnapshot
): Promise<AdaptiveJournalWriteResult> {
  const batch = prepareAdaptiveJournalBatch(snapshot);
  if (batch.status !== 'prepared') return batch;
  return persistVerifiedBatch(batch);
}

async function persistVerifiedBatch(
  batch: PreparedAdaptiveJournalBatch
): Promise<AdaptiveJournalWriteResult> {
  const result = (status: 'recorded' | 'unknown' | 'rejected'): AdaptiveJournalWriteResult =>
    Object.freeze({
      status,
      batchKey: batch.batchKey,
      batchDigest: batch.batchDigest,
      observations: batch.observations,
    });
  try {
    const { data, error } = await supabase
      .rpc('fn_append_horse_adaptive_observations', { p_batch: batch.payload })
      .abortSignal(AbortSignal.timeout(ADAPTIVE_JOURNAL_LIMITS.timeoutMs));
    if (error)
      return result(
        error.code === 'P0001' &&
          /^ADAPTIVE_JOURNAL_(?:INVALID_BATCH|INVALID_OBSERVATION|BATCH_CONFLICT|OBSERVATION_CONFLICT)$/.test(
            error.message
          )
          ? 'rejected'
          : 'unknown'
      );
    return result(
      data?.version === 1 &&
        data?.status === 'recorded' &&
        data?.batchKey === batch.batchKey &&
        data?.batchDigest === batch.batchDigest &&
        data?.observations === batch.observations
        ? 'recorded'
        : 'unknown'
    );
  } catch {
    return result('unknown');
  }
}

export interface AdaptiveJournalReadRequest {
  readonly actorKey: string;
  readonly scopeKey: string;
  readonly partition: AdaptivePartition;
  readonly cohort: 'human' | 'horse_policy';
  readonly fromMs: number;
  readonly toMs: number;
}
export type AdaptiveJournalReadResult =
  | ReturnType<typeof refusal>
  | Readonly<{
      status: 'snapshot';
      coverage: 'journaled_qualified_observations';
      request: Readonly<AdaptiveJournalReadRequest>;
      readAtMs: number;
      snapshotId: string;
      evidenceDigest: string;
      observations: readonly QualifiedAdaptiveObservation[];
    }>;

/** Complete for this journal population only; never emits a model completeness flag. */
export async function readAdaptiveJournalSnapshot(
  request: AdaptiveJournalReadRequest
): Promise<AdaptiveJournalReadResult> {
  if (
    !request ||
    !digest(request.actorKey) ||
    !digest(request.scopeKey) ||
    !['training', 'holdout'].includes(request.partition) ||
    !['human', 'horse_policy'].includes(request.cohort) ||
    !integer(request.fromMs) ||
    !integer(request.toMs) ||
    request.fromMs < 0 ||
    request.toMs <= request.fromMs ||
    request.toMs - request.fromMs > ADAPTIVE_OBSERVATION_HORIZON_MS
  )
    return refusal('invalid_request');
  // Capture caller-owned fields before the network await.
  const r = Object.freeze({
    actorKey: request.actorKey,
    scopeKey: request.scopeKey,
    partition: request.partition,
    cohort: request.cohort,
    fromMs: request.fromMs,
    toMs: request.toMs,
  });
  try {
    const { data, error } = await supabase
      .rpc('fn_horse_adaptive_journal_snapshot', {
        p_actor_key: r.actorKey,
        p_scope_key: r.scopeKey,
        p_partition: r.partition,
        p_cohort: r.cohort,
        p_from_ms: r.fromMs,
        p_to_ms: r.toMs,
      })
      .abortSignal(AbortSignal.timeout(ADAPTIVE_JOURNAL_LIMITS.timeoutMs));
    if (error) return refusal('source_unavailable');
    if (
      data?.version === 1 &&
      data?.status === 'unavailable' &&
      ['invalid_request', 'observation_budget_exceeded', 'byte_budget_exceeded'].includes(
        data.reason
      )
    )
      return refusal(data.reason);
    if (
      data?.version !== 1 ||
      data?.status !== 'snapshot' ||
      data?.reason !== null ||
      data?.coverage !== 'journaled_qualified_observations' ||
      Object.entries(r).some(([key, value]) => data[key] !== value) ||
      !integer(data.readAtMs) ||
      data.readAtMs < r.toMs ||
      r.fromMs < data.readAtMs - ADAPTIVE_OBSERVATION_HORIZON_MS ||
      typeof data.snapshotId !== 'string' ||
      !/^\d+:\d+:(?:\d+(?:,\d+)*)?$/.test(data.snapshotId) ||
      !integer(data.observations) ||
      data.observations < 0 ||
      data.observations > ADAPTIVE_JOURNAL_LIMITS.observations ||
      !integer(data.bytes) ||
      data.bytes < 0 ||
      data.bytes > ADAPTIVE_JOURNAL_LIMITS.batchBytes ||
      !Array.isArray(data.rows) ||
      data.rows.length !== data.observations
    )
      return refusal('invalid_source');
    const observations: QualifiedAdaptiveObservation[] = [],
      ids = new Set<string>();
    let size = 0,
      previous: QualifiedAdaptiveObservation | undefined;
    for (const row of data.rows) {
      const o = decode(row);
      size += bytes(row);
      if (
        size > ADAPTIVE_JOURNAL_LIMITS.batchBytes ||
        ids.has(o.observationId) ||
        o.actorKey !== r.actorKey ||
        o.scopeKey !== r.scopeKey ||
        o.partition !== r.partition ||
        (r.cohort === 'human' ? o.origin === 'horse_policy' : o.origin !== 'horse_policy') ||
        o.observedAtMs < r.fromMs ||
        o.observedAtMs >= r.toMs ||
        (previous &&
          (o.observedAtMs < previous.observedAtMs ||
            (o.observedAtMs === previous.observedAtMs &&
              o.observationId <= previous.observationId)))
      )
        return refusal('invalid_source_observation');
      ids.add(o.observationId);
      previous = o;
      observations.push(o);
    }
    if (size !== data.bytes) return refusal('invalid_source');
    return Object.freeze({
      status: 'snapshot',
      coverage: 'journaled_qualified_observations',
      request: r,
      readAtMs: data.readAtMs,
      snapshotId: data.snapshotId,
      evidenceDigest: hash(JSON.stringify(['adaptive-journal-snapshot-v1', r, data.rows])),
      observations: Object.freeze(observations),
    });
  } catch {
    return refusal('source_unavailable');
  }
}
