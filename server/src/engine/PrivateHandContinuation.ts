import { createHash } from 'node:crypto';
import type { HandContinuationBatch } from './HandContinuationLane.js';
import type { F06HandIdentity } from '../services/F06HandPermit.js';

export interface ContinuationSeat {
  user_id: string;
  seat_id: string;
  seat_joined_at: string;
  stack_before: number;
}

export interface PrivateHandContinuation {
  version: 1;
  original: Readonly<F06HandIdentity>;
  seats: readonly ContinuationSeat[];
  batch: HandContinuationBatch;
}

/** Exact bytes are the write identity, including the original private deck. */
export function encodePrivateHandContinuation(value: PrivateHandContinuation): {
  payload: string;
  sha256: string;
} {
  const payload = JSON.stringify(value, (_key, v) => {
    if (typeof v === 'bigint') return { continuationBigInt: v.toString() };
    if (v instanceof Map) return { continuationMap: [...v] };
    if (v instanceof Set) return { continuationSet: [...v] };
    return v;
  });
  if (Buffer.byteLength(payload) > 1048576) throw new Error('Hand Continuation Is Too Large');
  return { payload, sha256: createHash('sha256').update(payload).digest('hex') };
}

/** Never export this payload, deck, or its engine capture into public state. */
export function decodePrivateHandContinuation(
  payload: string,
  sha256: string
): PrivateHandContinuation {
  if (
    typeof payload !== 'string' ||
    Buffer.byteLength(payload) > 1048576 ||
    !/^[a-f0-9]{64}$/.test(sha256) ||
    createHash('sha256').update(payload).digest('hex') !== sha256
  )
    throw new Error('Hand Continuation Integrity Is Unproven');
  const result = JSON.parse(payload, (_key, value) => {
    if (!value || typeof value !== 'object') return value;
    const tagged = ['continuationBigInt', 'continuationMap', 'continuationSet'].filter(
      (k) => k in value
    );
    if (tagged.length === 0) return value;
    if (tagged.length !== 1 || Object.keys(value).length !== 1)
      throw new Error('Hand Continuation Tag Is Invalid');
    if ('continuationBigInt' in value) {
      if (
        typeof value.continuationBigInt !== 'string' ||
        !/^-?(0|[1-9][0-9]{0,30})$/.test(value.continuationBigInt)
      )
        throw new Error('Hand Continuation Units Are Invalid');
      return BigInt(value.continuationBigInt);
    }
    if ('continuationMap' in value) {
      if (
        !Array.isArray(value.continuationMap) ||
        value.continuationMap.some((entry: unknown) => !Array.isArray(entry) || entry.length !== 2)
      )
        throw new Error('Hand Continuation Map Is Invalid');
      const map = new Map(value.continuationMap);
      if (map.size !== value.continuationMap.length)
        throw new Error('Hand Continuation Map Has Duplicate Keys');
      return map;
    }
    if (!Array.isArray(value.continuationSet)) throw new Error('Hand Continuation Set Is Invalid');
    const set = new Set(value.continuationSet);
    if (set.size !== value.continuationSet.length)
      throw new Error('Hand Continuation Set Has Duplicate Values');
    return set;
  });
  if (
    !result ||
    result.version !== 1 ||
    !result.original ||
    !Array.isArray(result.seats) ||
    result.seats.length < 2 ||
    result.seats.length > 9 ||
    !result.batch ||
    result.batch.version !== 1 ||
    !Number.isSafeInteger(result.batch.sequence) ||
    result.batch.sequence < 0 ||
    typeof result.batch.controller !== 'string' ||
    !Array.isArray(result.batch.events) ||
    !result.batch.engine ||
    typeof result.batch.engine !== 'object' ||
    Array.isArray(result.batch.engine)
  )
    throw new Error('Hand Continuation Shape Is Invalid');
  return result;
}

/** Stable receipt identity survives replay of a retained time-bank event. */
export function continuationEventId(
  original: F06HandIdentity,
  sequence: number,
  index: number,
  childKey?: string
): string {
  const identity: Array<string | number> = [
    original.tournament_id,
    original.table_id,
    original.hand_number,
    sequence,
    index,
  ];
  // Existing event IDs remain byte-identical. A deterministic terminal child
  // has its own namespace while retaining the original parent's replay ID.
  if (childKey !== undefined) identity.push(childKey);
  const h = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  return (
    h.slice(0, 8) +
    '-' +
    h.slice(8, 12) +
    '-5' +
    h.slice(13, 16) +
    '-a' +
    h.slice(17, 20) +
    '-' +
    h.slice(20, 32)
  );
}
