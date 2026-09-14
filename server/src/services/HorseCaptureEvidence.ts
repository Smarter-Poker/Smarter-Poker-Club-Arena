import { createHash } from 'node:crypto';
import { supabase } from './supabase.js';
import type { CommittedObservationRequest } from './HorseCommittedObservationSnapshot.js';
import { recoverObservationSourceWitness } from './HorseObservationSourceWitness.js';

export interface CaptureEvidenceCursor {
  readonly afterFromMs: number;
  readonly throughMs: number;
  readonly segment: number;
  readonly observations: number;
  readonly revision: string;
}
export const CAPTURE_EVIDENCE_LIMITS = Object.freeze({ rows: 64, bytes: 1048576, timeoutMs: 5000 });
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const int = (v: unknown, min: number, max: number): v is number =>
  Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const unavailable = (reason: string) => Object.freeze({ status: 'unavailable' as const, reason });
const states = ['queued', 'leased', 'admitted', 'captured', 'gap'] as const;
const journalStates = ['missing', 'matched', 'payload_missing'] as const;
const queueStates = ['missing', 'queued', 'leased', 'completed', 'quarantined'] as const;

/** One read-only bounded page. A matching journal receipt is independently
 * reported; neither it nor finishing pagination proves source coverage.
 * Callers must carry the exact returned cursor and request revision forward. */
export async function readCaptureEvidencePage(
  input: CommittedObservationRequest,
  cursor?: CaptureEvidenceCursor
) {
  const request = { actorId: input?.actorId, fromMs: input?.fromMs, throughMs: input?.throughMs };
  const after = cursor
    ? {
        afterFromMs: cursor.afterFromMs,
        throughMs: cursor.throughMs,
        segment: cursor.segment,
        observations: cursor.observations,
        revision: cursor.revision,
      }
    : null;
  if (
    typeof request.actorId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(request.actorId) ||
    !int(request.fromMs, 0, Number.MAX_SAFE_INTEGER) ||
    !int(request.throughMs, request.fromMs + 1, Number.MAX_SAFE_INTEGER) ||
    request.throughMs - request.fromMs > 21600000 ||
    (after &&
      (!int(after.afterFromMs, request.fromMs, request.throughMs - 1) ||
        !int(after.throughMs, after.afterFromMs + 1, request.throughMs) ||
        !int(after.segment, 1, 2048) ||
        !int(after.observations, 0, after.segment * 20000) ||
        !sha(after.revision)))
  )
    return unavailable('invalid_request');
  const requestKey = hash(
    ['horse-source-request-v1', request.actorId, request.fromMs, request.throughMs].join('|')
  );
  const actorKey = hash(JSON.stringify(['adaptive-actor-v1', request.actorId]));
  try {
    const { data, error } = await supabase
      .rpc('fn_horse_observation_capture_evidence', {
        p_actor: request.actorId,
        p_from_ms: request.fromMs,
        p_through_ms: request.throughMs,
        p_after_from_ms: after?.afterFromMs ?? null,
        p_revision: after?.revision ?? null,
      })
      .abortSignal(AbortSignal.timeout(CAPTURE_EVIDENCE_LIMITS.timeoutMs));
    if (error) return unavailable('read_unavailable');
    if (
      !data ||
      data.version !== 1 ||
      Buffer.byteLength(JSON.stringify(data)) > CAPTURE_EVIDENCE_LIMITS.bytes
    )
      return unavailable('invalid_receipt');
    if (data.status === 'unavailable')
      return unavailable(
        [
          'invalid_request',
          'request_not_found',
          'legacy_request_without_slices',
          'request_changed',
          'cursor_lost',
          'evidence_budget_exceeded',
        ].includes(data.reason)
          ? data.reason
          : 'invalid_receipt'
      );
    if (
      data.status !== 'snapshot' ||
      data.requestKey !== requestKey ||
      data.actorKey !== actorKey ||
      data.fromMs !== request.fromMs ||
      data.throughMs !== request.throughMs ||
      !states.includes(data.requestState) ||
      !sha(data.revision) ||
      (after && data.revision !== after.revision) ||
      !int(data.segments, 0, 2048) ||
      !int(data.observations, 0, data.segments * 20000) ||
      !int(data.capturedThroughMs, request.fromMs, request.throughMs) ||
      !int(data.readAtMs, 0, Number.MAX_SAFE_INTEGER) ||
      data.sourceCoverage !== 'not_established' ||
      data.pageFromMs !== (after?.throughMs ?? request.fromMs) ||
      data.afterSegment !== (after?.segment ?? 0) ||
      data.afterObservations !== (after?.observations ?? 0) ||
      typeof data.hasMore !== 'boolean' ||
      !Array.isArray(data.rows) ||
      data.rows.length > CAPTURE_EVIDENCE_LIMITS.rows ||
      (data.hasMore && data.rows.length !== CAPTURE_EVIDENCE_LIMITS.rows)
    )
      return unavailable('invalid_receipt');
    if (
      (data.segments === 0 && data.capturedThroughMs !== request.fromMs) ||
      (data.segments > 0 && data.capturedThroughMs === request.fromMs) ||
      (data.requestState === 'admitted' &&
        (data.segments !== 1 || data.capturedThroughMs !== request.throughMs)) ||
      (data.requestState === 'captured' &&
        (data.segments < 2 || data.capturedThroughMs !== request.throughMs))
    )
      return unavailable('invalid_receipt');
    let end = after?.throughMs ?? request.fromMs,
      segment = after?.segment ?? 0,
      total = after?.observations ?? 0;
    const rows = [];
    for (const row of data.rows) {
      if (
        !row ||
        row.fromMs !== end ||
        !int(row.throughMs, row.fromMs + 1, data.capturedThroughMs) ||
        row.segment !== segment + 1 ||
        row.segment > data.segments ||
        !sha(row.batchKey) ||
        !sha(row.batchDigest) ||
        !int(row.observations, 0, 20000) ||
        row.capturedObservations !== total + row.observations ||
        row.capturedObservations > data.observations
      )
        return unavailable('evidence_gap');
      if (row.journalReceipt === 'conflict' || row.queueState === 'conflict')
        return unavailable('journal_receipt_conflict');
      if (!journalStates.includes(row.journalReceipt) || !queueStates.includes(row.queueState))
        return unavailable('invalid_receipt');
      const missing = row.sourceWitness === null && row.sourceWitnessDigest === null;
      const source = missing
        ? null
        : recoverObservationSourceWitness(row.sourceWitness, row.sourceWitnessDigest);
      if (
        !missing &&
        (!source ||
          source.actorKey !== actorKey ||
          source.fromMs !== row.fromMs ||
          source.throughMs !== row.throughMs ||
          row.batchKey !==
            hash(
              [
                'adaptive-journal-v1',
                actorKey,
                source.sourceDigest,
                row.fromMs,
                row.throughMs,
              ].join('|')
            ))
      )
        return unavailable('invalid_source_witness');
      rows.push(
        Object.freeze({
          fromMs: row.fromMs as number,
          throughMs: row.throughMs as number,
          segment: row.segment as number,
          observations: row.observations as number,
          capturedObservations: row.capturedObservations as number,
          batchKey: row.batchKey as string,
          batchDigest: row.batchDigest as string,
          source,
          journalReceipt: row.journalReceipt as (typeof journalStates)[number],
          queueState: row.queueState as (typeof queueStates)[number],
        })
      );
      end = row.throughMs;
      segment = row.segment;
      total = row.capturedObservations;
    }
    if (
      data.hasMore
        ? end >= data.capturedThroughMs || segment >= data.segments
        : end !== data.capturedThroughMs || segment !== data.segments || total !== data.observations
    )
      return unavailable('evidence_gap');
    const last = rows.at(-1);
    const nextCursor: CaptureEvidenceCursor | null =
      data.hasMore && last
        ? Object.freeze({
            afterFromMs: last.fromMs,
            throughMs: last.throughMs,
            segment,
            observations: total,
            revision: data.revision,
          })
        : null;
    return Object.freeze({
      status: 'snapshot' as const,
      requestKey,
      actorKey,
      fromMs: request.fromMs,
      throughMs: request.throughMs,
      requestState: data.requestState as (typeof states)[number],
      capturedThroughMs: data.capturedThroughMs as number,
      segments: data.segments as number,
      observations: data.observations as number,
      revision: data.revision,
      readAtMs: data.readAtMs as number,
      sourceCoverage: 'not_established' as const,
      rows: Object.freeze(rows),
      nextCursor,
    });
  } catch {
    return unavailable('invalid_receipt');
  }
}
