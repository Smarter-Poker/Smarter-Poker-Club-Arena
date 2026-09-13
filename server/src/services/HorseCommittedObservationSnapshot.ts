import { createHash } from 'node:crypto';
import { supabase } from './supabase.js';
import {
  qualifyAdaptiveHand,
  type QualifiedAdaptiveObservation,
} from '../engine/HorseAdaptiveObservation.js';
import type { CompletedHandObservation } from '../engine/horseDecision/protocol.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const COMMITTED_OBSERVATION_LIMITS = Object.freeze({
  maxHands: 512,
  maxActionsPerHand: 4096,
  maxSourceActions: 20_000,
  maxSourceBytes: 8_388_608,
  maxObservations: 20_000,
  maxWindowMs: 6 * 3_600_000,
  timeoutMs: 5_000,
});
export interface CommittedObservationRequest {
  readonly actorId: string;
  /** Commit-row time, never an observation-time completeness watermark. */
  readonly fromMs: number;
  readonly throughMs: number;
}
export type CommittedObservationSnapshot =
  | Readonly<{ status: 'unavailable'; reason: string }>
  | Readonly<{
      status: 'snapshot';
      version: 1;
      actorKey: string;
      source: Readonly<{
        coverage: 'retained_committed_roster_rows';
        fromMs: number;
        throughMs: number;
        readAtMs: number;
        snapshotId: string;
        hands: number;
        sourceBytes: number;
        sourceDigest: string;
      }>;
      observations: readonly QualifiedAdaptiveObservation[];
      rejected: Readonly<Record<string, number>>;
    }>;
const unavailable = (reason: string): CommittedObservationSnapshot =>
  Object.freeze({ status: 'unavailable', reason });
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const serverReasons = new Set([
  'action_budget_exceeded',
  'invalid_window',
  'hand_budget_exceeded',
  'byte_budget_exceeded',
  'invalid_or_oversized_hand',
]);

/**
 * Acquire and qualify on an isolated background worker, never the action clock.
 * The RPC is one STABLE PostgreSQL statement; there is no page/notification gap.
 * This is complete only for retained committed roster rows visible to that
 * statement, not for unfinished hands, past retention loss or qualified coverage.
 * No aggregate is persisted or incremented here, so retry cannot double-update.
 */
export async function readCommittedObservationSnapshot(
  request: CommittedObservationRequest
): Promise<CommittedObservationSnapshot> {
  if (
    !request ||
    typeof request.actorId !== 'string' ||
    !UUID.test(request.actorId) ||
    !integer(request.fromMs) ||
    !integer(request.throughMs) ||
    request.fromMs < 0 ||
    request.throughMs <= request.fromMs ||
    request.throughMs - request.fromMs > COMMITTED_OBSERVATION_LIMITS.maxWindowMs
  )
    return unavailable('invalid_request');
  try {
    const { data, error } = await supabase
      .rpc('fn_horse_committed_observation_snapshot', {
        p_actor: request.actorId,
        p_from_ms: request.fromMs,
        p_through_ms: request.throughMs,
      })
      .abortSignal(AbortSignal.timeout(COMMITTED_OBSERVATION_LIMITS.timeoutMs));
    if (error) return unavailable('source_unavailable');
    if (!data || typeof data !== 'object' || data.version !== 1)
      return unavailable('invalid_source');
    if (data.status === 'unavailable')
      return unavailable(serverReasons.has(data.reason) ? data.reason : 'invalid_source');
    if (
      data.status !== 'snapshot' ||
      data.reason !== null ||
      data.actor !== request.actorId ||
      data.fromMs !== request.fromMs ||
      data.throughMs !== request.throughMs ||
      data.coverage !== 'retained_committed_roster_rows' ||
      !integer(data.readAtMs) ||
      data.readAtMs < request.throughMs ||
      request.fromMs < data.readAtMs - 86_400_000 ||
      typeof data.snapshotId !== 'string' ||
      !/^\d+:\d+:(?:\d+(?:,\d+)*)?$/.test(data.snapshotId) ||
      !integer(data.handCount) ||
      data.handCount < 0 ||
      data.handCount > COMMITTED_OBSERVATION_LIMITS.maxHands ||
      !integer(data.actionCount) ||
      data.actionCount < 0 ||
      data.actionCount > COMMITTED_OBSERVATION_LIMITS.maxSourceActions ||
      !integer(data.sourceBytes) ||
      data.sourceBytes < 0 ||
      data.sourceBytes > COMMITTED_OBSERVATION_LIMITS.maxSourceBytes ||
      !Array.isArray(data.hands) ||
      data.hands.length !== data.handCount
    )
      return unavailable('invalid_source');
    const actorKey = hash(['adaptive-actor-v1', request.actorId]);
    const observations: QualifiedAdaptiveObservation[] = [],
      rejected: Record<string, number> = {};
    const ids = new Set<string>(),
      observationIds = new Set<string>(),
      manifest: unknown[] = [];
    let previous = '',
      returnedActions = 0,
      returnedBytes = 0;
    for (const hand of data.hands) {
      if (
        !hand ||
        typeof hand.id !== 'string' ||
        !UUID.test(hand.id) ||
        ids.has(hand.id) ||
        typeof hand.createdAt !== 'string' ||
        !TIME.test(hand.createdAt) ||
        !Array.isArray(hand.actions) ||
        hand.actions.length > COMMITTED_OBSERVATION_LIMITS.maxActionsPerHand
      )
        return unavailable('invalid_source_hand');
      const at = Date.parse(hand.createdAt);
      if (!integer(at)) return unavailable('invalid_source_hand');
      const microseconds = BigInt(at) * 1000n + BigInt(hand.createdAt.slice(23, 26));
      const key = hand.createdAt + ':' + hand.id;
      if (
        !integer(at) ||
        microseconds <= BigInt(request.fromMs) * 1000n ||
        microseconds > BigInt(request.throughMs) * 1000n ||
        (previous && key <= previous)
      )
        return unavailable('invalid_source_hand');
      previous = key;
      ids.add(hand.id);
      returnedActions += hand.actions.length;
      if (returnedActions > COMMITTED_OBSERVATION_LIMITS.maxSourceActions)
        return unavailable('action_budget_exceeded');
      returnedBytes += Buffer.byteLength(JSON.stringify(hand.actions));
      if (returnedBytes > COMMITTED_OBSERVATION_LIMITS.maxSourceBytes)
        return unavailable('response_budget_exceeded');
      const qualified = qualifyAdaptiveHand(
        {
          committedHandId: hand.id,
          actions: hand.actions as CompletedHandObservation['actions'],
        },
        data.readAtMs
      );
      // Bind replay to the exact returned source, including rejected entries.
      // Only hashes/counts and qualified public features leave this service.
      manifest.push([hand.id, hand.createdAt, hash(hand.actions)]);
      for (const [reason, n] of Object.entries(qualified.rejected))
        rejected[reason] = (rejected[reason] ?? 0) + n;
      for (const observation of qualified.observations) {
        if (observation.actorKey !== actorKey) continue;
        if (observationIds.has(observation.observationId))
          return unavailable('conflicting_observation');
        observationIds.add(observation.observationId);
        observations.push(observation);
        if (observations.length > COMMITTED_OBSERVATION_LIMITS.maxObservations)
          return unavailable('observation_budget_exceeded');
      }
    }
    if (returnedActions !== data.actionCount) return unavailable('invalid_source');
    return Object.freeze({
      status: 'snapshot',
      version: 1,
      actorKey,
      source: Object.freeze({
        coverage: 'retained_committed_roster_rows',
        fromMs: request.fromMs,
        throughMs: request.throughMs,
        readAtMs: data.readAtMs,
        snapshotId: data.snapshotId,
        hands: data.handCount,
        sourceBytes: data.sourceBytes,
        sourceDigest: hash([
          'committed-observation-source-v1',
          request.actorId,
          request.fromMs,
          request.throughMs,
          manifest,
        ]),
      }),
      observations: Object.freeze(observations),
      rejected: Object.freeze(rejected),
    });
  } catch {
    // Do not log a database error that could contain credentials or private rows.
    return unavailable('source_unavailable');
  }
}
