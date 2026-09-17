import {
  horseMindHandFromDecision,
  horseMindHandIdentityKey,
  type HorseMindHandIdentity,
} from './HorseMindHandIdentity.js';

/** A local plan namespace, not a controller acceptance or durable receipt. */
export interface HorsePlanContext {
  readonly version: 1;
  readonly hand: HorseMindHandIdentity | null;
}

type DecisionCoordinate = {
  fence: string;
  generation: number;
  player: { seat: number };
};
type BatchRequest = DecisionCoordinate & {
  requestId: number;
  decisionKey: string;
  player: { seat: number; user_id: string };
  gameState: { stage: string };
};

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const uint = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

export function horsePlanContextFromDecision(request: DecisionCoordinate): HorsePlanContext {
  return Object.freeze({ version: 1, hand: horseMindHandFromDecision(request) });
}

export function horsePlanContextIsValid(value: unknown): value is HorsePlanContext {
  return (
    object(value) &&
    exact(value, ['version', 'hand']) &&
    value.version === 1 &&
    (value.hand === null || horseMindHandIdentityKey(value.hand) !== null)
  );
}

export function horsePlanContextKey(value: unknown): string | null {
  if (!horsePlanContextIsValid(value) || value.hand === null) return null;
  return `plan-hand-v1:${value.hand.tableId.toLowerCase()}:${value.hand.handNumber}`;
}

export function horsePlanContextMatchesRequest(
  value: unknown,
  request: DecisionCoordinate
): value is HorsePlanContext {
  if (!horsePlanContextIsValid(value)) return false;
  const expected = horsePlanContextFromDecision(request);
  return value.hand === null
    ? expected.hand === null
    : expected.hand !== null && horsePlanContextKey(value) === horsePlanContextKey(expected);
}

/** The original FAST identity is separate from the later COMMIT job ID.
 * Shape and coordinate equality never establish actual controller acceptance. */
export interface HorsePlanBatchBinding {
  readonly version: 'horse-plan-batch-v1';
  readonly fastRequestId: number;
  readonly generation: number;
  readonly fence: string;
  readonly decisionKey: string;
  readonly actorId: string;
  readonly seat: number;
  readonly street: string;
  readonly planContext: HorsePlanContext;
}

export function horsePlanBatchBindingIsValid(value: unknown): value is HorsePlanBatchBinding {
  if (
    !object(value) ||
    !exact(value, [
      'version',
      'fastRequestId',
      'generation',
      'fence',
      'decisionKey',
      'actorId',
      'seat',
      'street',
      'planContext',
    ]) ||
    value.version !== 'horse-plan-batch-v1' ||
    !uint(value.fastRequestId) ||
    value.fastRequestId === 0 ||
    !uint(value.generation) ||
    typeof value.fence !== 'string' ||
    !value.fence.length ||
    value.fence.length > 512 ||
    typeof value.decisionKey !== 'string' ||
    !/^phase5-v1:[a-f0-9]{64}$/.test(value.decisionKey) ||
    typeof value.actorId !== 'string' ||
    !value.actorId.length ||
    value.actorId.length > 256 ||
    !uint(value.seat) ||
    value.seat < 1 ||
    value.seat > 10 ||
    typeof value.street !== 'string' ||
    !['preflop', 'flop', 'turn', 'river'].includes(value.street)
  )
    return false;
  return horsePlanContextMatchesRequest(value.planContext, {
    fence: value.fence,
    generation: value.generation,
    player: { seat: value.seat },
  });
}

export function horsePlanBatchBindingFromRequest(request: BatchRequest): HorsePlanBatchBinding {
  const binding: HorsePlanBatchBinding = Object.freeze({
    version: 'horse-plan-batch-v1',
    fastRequestId: request.requestId,
    generation: request.generation,
    fence: request.fence,
    decisionKey: request.decisionKey,
    actorId: request.player.user_id,
    seat: request.player.seat,
    street: request.gameState.stage,
    planContext: horsePlanContextFromDecision(request),
  });
  if (!horsePlanBatchBindingIsValid(binding)) throw Error('Horse plan batch request is invalid');
  return binding;
}

/** Canonical field projection, not caller property order or a source authority hash. */
export function horsePlanBatchBindingKey(value: unknown): string | null {
  if (!horsePlanBatchBindingIsValid(value)) return null;
  return JSON.stringify([
    value.version,
    value.fastRequestId,
    value.generation,
    value.fence,
    value.decisionKey,
    value.actorId,
    value.seat,
    value.street,
    horsePlanContextKey(value.planContext),
  ]);
}

export function horsePlanBatchBindingMatchesRequest(
  value: unknown,
  request: BatchRequest
): value is HorsePlanBatchBinding {
  try {
    const actual = horsePlanBatchBindingKey(value);
    return (
      actual !== null &&
      actual === horsePlanBatchBindingKey(horsePlanBatchBindingFromRequest(request))
    );
  } catch {
    return false;
  }
}
