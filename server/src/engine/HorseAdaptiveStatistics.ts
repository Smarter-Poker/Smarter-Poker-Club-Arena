import { createHash } from 'node:crypto';
import {
  adaptiveSessionPartition,
  type AdaptiveAction,
  type AdaptivePartition,
} from './HorseAdaptiveObservation.js';

/** Derived action counts at their exact timestamp. No original UUID, node,
 * board, seat, ordinal or action sequence is reconstructed from this evidence. */
export interface AdaptiveStatistic {
  readonly handDigest: string;
  readonly actorKey: string;
  readonly sessionKey: string;
  readonly partition: AdaptivePartition;
  readonly scopeKey: string;
  readonly origin: 'player' | 'pre_action' | 'horse_policy';
  readonly observedAtMs: number;
  readonly action: AdaptiveAction;
  readonly observations: number;
}
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export const adaptiveHandDigest = (id: string) => createHash('sha256').update(id).digest('hex');
export const statisticTuple = (s: AdaptiveStatistic) => [
  1,
  s.handDigest,
  s.actorKey,
  s.sessionKey,
  s.partition,
  s.scopeKey,
  s.origin,
  s.observedAtMs,
  s.action,
  s.observations,
];
export function validAdaptiveStatistic(s: AdaptiveStatistic): boolean {
  return (
    !!s &&
    sha(s.handDigest) &&
    sha(s.actorKey) &&
    sha(s.sessionKey) &&
    sha(s.scopeKey) &&
    ['training', 'holdout'].includes(s.partition) &&
    adaptiveSessionPartition(s.sessionKey) === s.partition &&
    ['player', 'pre_action', 'horse_policy'].includes(s.origin) &&
    Number.isSafeInteger(s.observedAtMs) &&
    s.observedAtMs >= 0 &&
    ['fold', 'check', 'call', 'bet', 'raise'].includes(s.action) &&
    Number.isSafeInteger(s.observations) &&
    s.observations > 0 &&
    s.observations <= 4096
  );
}
export function decodeAdaptiveStatistic(text: unknown): AdaptiveStatistic {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 2048) throw Error('invalid_statistic');
  const a = JSON.parse(text);
  if (!Array.isArray(a) || a.length !== 10 || a[0] !== 1) throw Error('invalid_statistic');
  const s: AdaptiveStatistic = Object.freeze({
    handDigest: a[1],
    actorKey: a[2],
    sessionKey: a[3],
    partition: a[4],
    scopeKey: a[5],
    origin: a[6],
    observedAtMs: a[7],
    action: a[8],
    observations: a[9],
  });
  if (!validAdaptiveStatistic(s)) throw Error('invalid_statistic');
  // PostgreSQL jsonb text has deliberate whitespace; validate values, then hash
  // the original bounded transport bytes at the snapshot boundary separately.
  return s;
}
