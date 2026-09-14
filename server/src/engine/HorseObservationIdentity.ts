import { createHash } from 'node:crypto';
import type { AcceptedActionOrigin } from '../types.js';
import type { HandSeatGeneration } from './handSeatGeneration.js';
import type { HorsePublicActionNode } from './HorsePublicActionNode.js';

/** Lineage only. A bound identity is not permission to train or change policy. */
export type HorseObservationIdentity =
  | Readonly<{
      version: 1;
      status: 'bound';
      /** Immutable hand UUID and ordinal in the complete, unfiltered action list. */
      observationId: string;
      handId: string;
      actionOrdinal: number;
      /** Opaque digest of the hand's actor/table/seat generation, never the live roster. */
      sessionKey: string;
    }>
  | Readonly<{
      version: 1;
      status: 'unavailable';
      reason:
        | 'missing_hand_identity'
        | 'invalid_actor_identity'
        | 'missing_seat_generation'
        | 'invalid_seat_generation'
        | 'non_voluntary_origin'
        | 'unavailable_public_node'
        | 'action_node_mismatch';
    }>;

export interface HorseIdentityAction {
  seat: number;
  userId?: string;
  action: string;
  stage: string;
  publicNode?: HorsePublicActionNode;
  origin?: AcceptedActionOrigin;
}

const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** Runs before the accepted hand's one atomic write, outside the action clock.
 * Retries and restarts reuse the durable identity; fences, workers, timestamps
 * and filtered action positions cannot create a second observation of it.
 * Missing lineage excludes new learning while leaving valid settlement intact.
 */
export function bindHorseObservationIdentity(
  action: HorseIdentityAction,
  actionOrdinal: number,
  context: {
    handId?: string;
    tableId: string;
    seatGenerations?: ReadonlyMap<string, HandSeatGeneration>;
  }
): HorseObservationIdentity {
  const unavailable = (
    reason: Extract<HorseObservationIdentity, { status: 'unavailable' }>['reason']
  ): HorseObservationIdentity => Object.freeze({ version: 1, status: 'unavailable', reason });
  if (!uuid(context.handId) || !Number.isSafeInteger(actionOrdinal) || actionOrdinal < 0)
    return unavailable('missing_hand_identity');
  if (!uuid(context.tableId) || !uuid(action.userId)) return unavailable('invalid_actor_identity');
  if (!['player', 'pre_action', 'horse_policy'].includes(action.origin ?? 'unknown'))
    return unavailable('non_voluntary_origin');
  const node = action.publicNode;
  if (!node || node.version !== 1 || node.status !== 'captured')
    return unavailable('unavailable_public_node');
  if (
    node.actorSeat !== action.seat ||
    !Number.isInteger(action.seat) ||
    node.street !== action.stage ||
    !Array.isArray(node.legalActions) ||
    !['fold', 'check', 'call', 'bet', 'raise', 'all_in'].includes(action.action) ||
    !node.legalActions.includes(action.action as (typeof node.legalActions)[number])
  )
    return unavailable('action_node_mismatch');
  const generation = context.seatGenerations?.get(action.userId);
  if (!generation) return unavailable('missing_seat_generation');
  if (
    !uuid(generation.seat_id) ||
    typeof generation.seat_joined_at !== 'string' ||
    generation.seat_joined_at.length > 64 ||
    !Number.isFinite(Date.parse(generation.seat_joined_at))
  )
    return unavailable('invalid_seat_generation');
  const handId = context.handId.toLowerCase();
  const sessionKey = createHash('sha256')
    .update(
      JSON.stringify([
        'horse-observation-session-v1',
        context.tableId.toLowerCase(),
        action.userId.toLowerCase(),
        generation.seat_id.toLowerCase(),
        // Keep the original database precision. Date.parse is validation only.
        generation.seat_joined_at,
      ])
    )
    .digest('hex');
  return Object.freeze({
    version: 1,
    status: 'bound',
    observationId: `${handId}:${actionOrdinal}`,
    handId,
    actionOrdinal,
    sessionKey,
  });
}
