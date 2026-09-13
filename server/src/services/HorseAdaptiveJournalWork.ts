import { randomUUID } from 'node:crypto';
import { supabase } from './supabase.js';
import {
  ADAPTIVE_JOURNAL_LIMITS,
  prepareAdaptiveJournalBatch,
  validateAdaptiveJournalBatchPayload,
  persistPreparedAdaptiveJournalBatch,
} from './HorseAdaptiveObservationJournal.js';
import type { CommittedObservationSnapshot } from './HorseCommittedObservationSnapshot.js';

const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const unavailable = (reason: string) => Object.freeze({ status: 'unavailable' as const, reason });
const call = (name: string, parameters: Record<string, unknown>) =>
  supabase
    .rpc(name, parameters)
    .abortSignal(AbortSignal.timeout(ADAPTIVE_JOURNAL_LIMITS.timeoutMs));

/** Persist the exact payload before attempting a journal write. No timer or
 * source watermark is created here; a lost enqueue reply remains unknown. */
export async function enqueueAdaptiveJournalWork(snapshot: CommittedObservationSnapshot) {
  const batch = prepareAdaptiveJournalBatch(snapshot);
  if (batch.status !== 'prepared') return batch;
  const result = (status: 'durable' | 'unknown') =>
    Object.freeze({
      status,
      batchKey: batch.batchKey,
      batchDigest: batch.batchDigest,
      observations: batch.observations,
    });
  try {
    const { data, error } = await call('fn_queue_horse_adaptive_batch', {
      p_payload: batch.payload,
    });
    if (error) return result('unknown');
    if (data?.version === 1 && data.status === 'unavailable') {
      return unavailable(
        [
          'capacity_busy',
          'queue_full',
          'batch_conflict',
          'legacy_batch_payload_unavailable',
        ].includes(data.reason)
          ? data.reason
          : 'invalid_receipt'
      );
    }
    return result(
      data?.version === 1 &&
        data.status === 'durable' &&
        data.batchKey === batch.batchKey &&
        data.batchDigest === batch.batchDigest &&
        data.observations === batch.observations
        ? 'durable'
        : 'unknown'
    );
  } catch {
    return result('unknown');
  }
}

export type AdaptiveJournalWorkResult =
  | ReturnType<typeof unavailable>
  | Readonly<{ status: 'idle' }>
  | Readonly<{
      status: 'completed' | 'deferred' | 'quarantined' | 'unknown' | 'lease_lost';
      batchKey: string;
    }>;

/** One bounded off-clock work item. The durable queue owns retries and the
 * lease token fences acknowledgments. A stale writer can only replay the same
 * immutable batch; it cannot complete another worker's lease or add counts. */
export async function processAdaptiveJournalWork(): Promise<AdaptiveJournalWorkResult> {
  const token = randomUUID();
  let claimed: Record<string, unknown>;
  try {
    const response = await call('fn_claim_horse_adaptive_batch', { p_lease_token: token });
    if (response.error) return unavailable('claim_unavailable');
    if (!response.data || typeof response.data !== 'object' || Array.isArray(response.data))
      return unavailable('invalid_claim');
    claimed = response.data as Record<string, unknown>;
  } catch {
    return unavailable('claim_unavailable');
  }
  if (claimed?.version === 1 && claimed.status === 'idle') return Object.freeze({ status: 'idle' });
  if (
    claimed?.version !== 1 ||
    claimed.status !== 'claimed' ||
    claimed.leaseToken !== token ||
    !sha(claimed.batchKey) ||
    !sha(claimed.batchDigest) ||
    typeof claimed.observations !== 'number' ||
    !Number.isSafeInteger(claimed.observations) ||
    claimed.observations < 0 ||
    claimed.observations > ADAPTIVE_JOURNAL_LIMITS.observations
  )
    return unavailable('invalid_claim');
  // Capture fields from the claim before any asynchronous write/reply can
  // expose another generation. No guessed payload is sent to the journal.
  const batchKey = claimed.batchKey as string,
    batchDigest = claimed.batchDigest as string;
  const observations = claimed.observations as number;
  const result = (status: 'completed' | 'deferred' | 'quarantined' | 'unknown' | 'lease_lost') =>
    Object.freeze({ status, batchKey });
  let outcome: 'recorded' | 'unknown' | 'rejected' = 'unknown';
  try {
    const batch = validateAdaptiveJournalBatchPayload(claimed.payload);
    if (
      batch.batchKey !== batchKey ||
      batch.batchDigest !== batchDigest ||
      batch.observations !== observations
    )
      return unavailable('invalid_claim');
    const written = await persistPreparedAdaptiveJournalBatch(batch);
    outcome =
      written.status === 'recorded'
        ? 'recorded'
        : written.status === 'rejected'
          ? 'rejected'
          : 'unknown';
  } catch {
    // A malformed transport response cannot quarantine a possibly valid
    // durable job. Its lease expires; the next worker re-reads the original.
    return unavailable('invalid_claim');
  }
  try {
    const { data, error } = await call('fn_finish_horse_adaptive_batch', {
      p_batch_key: batchKey,
      p_lease_token: token,
      p_outcome: outcome,
    });
    if (error || data?.version !== 1 || data.batchKey !== batchKey) return result('unknown');
    if (data.status === 'lease_lost') return result('lease_lost');
    const expected =
      outcome === 'recorded' ? 'completed' : outcome === 'unknown' ? 'deferred' : 'quarantined';
    return result(data.status === expected ? expected : 'unknown');
  } catch {
    return result('unknown');
  }
}
