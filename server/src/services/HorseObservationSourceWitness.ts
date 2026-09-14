import { createHash } from 'node:crypto';
import type { CommittedObservationSnapshot } from './HorseCommittedObservationSnapshot.js';

export const SOURCE_WITNESS_LIMIT = 8192;
const integer = (v: unknown, min: number, max: number): v is number =>
  Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);

/** Preserve the exact source read boundary, never a source-completeness claim.
 * Only public source metadata enters this bounded canonical tuple. */
export function prepareObservationSourceWitness(snapshot: CommittedObservationSnapshot) {
  if (!snapshot || snapshot.status !== 'snapshot') return null;
  const s = snapshot.source;
  if (
    snapshot.version !== 1 ||
    !sha(snapshot.actorKey) ||
    !s ||
    s.coverage !== 'retained_committed_roster_rows' ||
    s.acceptance !== 'atomic_hand_receipts' ||
    !sha(s.sourceDigest) ||
    !integer(s.fromMs, 0, Number.MAX_SAFE_INTEGER) ||
    !integer(s.throughMs, s.fromMs + 1, Number.MAX_SAFE_INTEGER) ||
    s.throughMs - s.fromMs > 21600000 ||
    !integer(s.readAtMs, s.throughMs, Number.MAX_SAFE_INTEGER) ||
    s.fromMs < s.readAtMs - 86400000 ||
    !integer(s.hands, 0, 512) ||
    !integer(s.sourceBytes, 0, 8388608) ||
    typeof s.snapshotId !== 'string' ||
    s.snapshotId.length > SOURCE_WITNESS_LIMIT ||
    !/^\d+:\d+:(?:\d+(?:,\d+)*)?$/.test(s.snapshotId)
  )
    return null;
  const payload = JSON.stringify([
    1,
    snapshot.actorKey,
    s.fromMs,
    s.throughMs,
    s.readAtMs,
    s.snapshotId,
    s.hands,
    s.sourceBytes,
    s.sourceDigest,
    s.coverage,
    s.acceptance,
  ]);
  if (Buffer.byteLength(payload) > SOURCE_WITNESS_LIMIT) return null;
  return Object.freeze({ payload, digest: createHash('sha256').update(payload).digest('hex') });
}
