import { createHash, randomUUID } from 'node:crypto';
import { supabase } from './supabase.js';
import {
  readCommittedObservationSnapshot,
  type CommittedObservationRequest,
} from './HorseCommittedObservationSnapshot.js';
import { prepareAdaptiveJournalBatch } from './HorseAdaptiveObservationJournal.js';

const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const requestValid = (r: CommittedObservationRequest) =>
  r &&
  uuid(r.actorId) &&
  Number.isSafeInteger(r.fromMs) &&
  Number.isSafeInteger(r.throughMs) &&
  r.fromMs >= 0 &&
  r.throughMs > r.fromMs &&
  r.throughMs - r.fromMs <= 21600000;
const keyOf = (r: CommittedObservationRequest) =>
  createHash('sha256')
    .update(['horse-source-request-v1', r.actorId, r.fromMs, r.throughMs].join('|'))
    .digest('hex');
const rpc = (name: string, args: Record<string, unknown>) =>
  supabase.rpc(name, args).abortSignal(AbortSignal.timeout(5000));
const unavailable = (reason: string) => Object.freeze({ status: 'unavailable' as const, reason });
const gapReasons = new Set(['source_expired', 'source_budget_exceeded', 'invalid_source']);

/** Persist the requested scope before any source read. Durable admission is
 * acceptance of work, not observation coverage, journal completion or learning. */
export async function admitObservationCapture(input: CommittedObservationRequest) {
  const r = { actorId: input?.actorId, fromMs: input?.fromMs, throughMs: input?.throughMs };
  if (!requestValid(r)) return unavailable('invalid_request');
  const requestKey = keyOf(r);
  try {
    const { data, error } = await rpc('fn_admit_horse_observation_capture', {
      p_actor: r.actorId,
      p_from_ms: r.fromMs,
      p_through_ms: r.throughMs,
    });
    if (error) return Object.freeze({ status: 'unknown' as const, requestKey });
    if (data?.version === 1 && data.status === 'unavailable')
      return unavailable(
        ['invalid_request', 'capacity_busy', 'capture_queue_full', 'source_expired'].includes(
          data.reason
        )
          ? data.reason
          : 'invalid_receipt'
      );
    if (
      data?.version !== 1 ||
      data.status !== 'durable' ||
      data.requestKey !== requestKey ||
      !['queued', 'leased', 'admitted', 'gap'].includes(data.state)
    )
      return Object.freeze({ status: 'unknown' as const, requestKey });
    if (
      data.state === 'admitted' &&
      (!sha(data.batchKey) ||
        !sha(data.batchDigest) ||
        !Number.isSafeInteger(data.observations) ||
        data.observations < 0 ||
        data.observations > 20000)
    )
      return Object.freeze({ status: 'unknown' as const, requestKey });
    if (data.state === 'gap' && !gapReasons.has(data.reason))
      return Object.freeze({ status: 'unknown' as const, requestKey });
    return Object.freeze({
      status: 'durable' as const,
      requestKey,
      state: data.state as 'queued' | 'leased' | 'admitted' | 'gap',
    });
  } catch {
    return Object.freeze({ status: 'unknown' as const, requestKey });
  }
}

export type ObservationCaptureResult =
  | Readonly<{ status: 'idle' }>
  | ReturnType<typeof unavailable>
  | Readonly<{
      status: 'admitted' | 'gap' | 'deferred' | 'lease_lost' | 'unknown';
      requestKey: string;
    }>;

/** One bounded off-clock acquisition. A lease fences the exact source request;
 * queue insertion and request acknowledgment commit together. A lost reply is
 * unknown, and retry claims the original request, not a guessed newer window. */
export async function processObservationCapture(): Promise<ObservationCaptureResult> {
  const token = randomUUID();
  let claim: Record<string, unknown>;
  try {
    const { data, error } = await rpc('fn_claim_horse_observation_capture', {
      p_lease_token: token,
    });
    if (error || data?.version !== 1) return unavailable('claim_unavailable');
    if (data.status === 'idle') return Object.freeze({ status: 'idle' });
    if (data.status === 'gap' && sha(data.requestKey) && gapReasons.has(data.reason))
      return Object.freeze({ status: 'gap', requestKey: data.requestKey });
    if (data.status !== 'claimed' || data.leaseToken !== token || !sha(data.requestKey))
      return unavailable('invalid_claim');
    claim = data;
  } catch {
    return unavailable('claim_unavailable');
  }
  const request = {
    actorId: claim.actorId,
    fromMs: claim.fromMs,
    throughMs: claim.throughMs,
  } as CommittedObservationRequest;
  if (!requestValid(request) || keyOf(request) !== claim.requestKey)
    return unavailable('invalid_claim');
  const requestKey = claim.requestKey as string;
  const result = (status: 'admitted' | 'gap' | 'deferred' | 'lease_lost' | 'unknown') =>
    Object.freeze({ status, requestKey });
  let payload: string | null = null,
    reason = 'source_unavailable';
  let expected: Readonly<{ batchKey: string; batchDigest: string; observations: number }> | null =
    null;
  try {
    const source = await readCommittedObservationSnapshot(request);
    if (source.status === 'snapshot') {
      const batch = prepareAdaptiveJournalBatch(source);
      if (batch.status === 'prepared') {
        payload = batch.payload;
        expected = {
          batchKey: batch.batchKey,
          batchDigest: batch.batchDigest,
          observations: batch.observations,
        };
      } else reason = 'invalid_source';
    } else if (
      [
        'hand_budget_exceeded',
        'byte_budget_exceeded',
        'action_budget_exceeded',
        'response_budget_exceeded',
        'observation_budget_exceeded',
      ].includes(source.reason)
    )
      reason = 'source_budget_exceeded';
    else if (source.reason === 'invalid_or_oversized_hand') reason = 'invalid_source';
  } catch {
    // A local/transport exception is not evidence that source data is corrupt.
  }
  try {
    const { data, error } = await rpc('fn_finish_horse_observation_capture', {
      p_request_key: requestKey,
      p_lease_token: token,
      p_payload: payload,
      p_reason: payload === null ? reason : null,
    });
    if (error || data?.version !== 1 || data.requestKey !== requestKey) return result('unknown');
    if (data.status === 'lease_lost') return result('lease_lost');
    if (
      data.status === 'admitted' &&
      expected &&
      data.batchKey === expected.batchKey &&
      data.batchDigest === expected.batchDigest &&
      data.observations === expected.observations
    )
      return result('admitted');
    if (
      data.status === 'deferred' &&
      ['source_unavailable', 'queue_full', 'capacity_busy', 'queue_unavailable'].includes(
        data.reason
      )
    )
      return result('deferred');
    if (
      data.status === 'gap' &&
      payload === null &&
      data.reason === reason &&
      gapReasons.has(reason)
    )
      return result('gap');
    return result('unknown');
  } catch {
    return result('unknown');
  }
}

/** Only admitted request metadata expires. Unknown requests and gaps persist. */
export async function pruneObservationCaptures() {
  try {
    const { data, error } = await rpc('fn_prune_horse_observation_captures', {});
    if (
      error ||
      data?.version !== 1 ||
      data.status !== 'pruned' ||
      !Number.isSafeInteger(data.requests) ||
      data.requests < 0 ||
      data.requests > 100
    )
      return Object.freeze({ status: 'unknown' as const });
    return Object.freeze({ status: 'pruned' as const, requests: data.requests as number });
  } catch {
    return Object.freeze({ status: 'unknown' as const });
  }
}
