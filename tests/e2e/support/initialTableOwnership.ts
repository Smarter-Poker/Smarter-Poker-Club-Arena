type SubscriptionFrame = { at: number; socketId: number };

/** A warm facade may transfer ownership on the same authoritative transport. */
export function assertInitialTableOwnership(
  subscriptions: readonly SubscriptionFrame[],
  expectedSocketId: number,
  observationStartedAt: number
): void {
  if (!Number.isFinite(observationStartedAt) || !Number.isInteger(expectedSocketId)) {
    throw new Error('Initial table ownership requires an exact observation and transport');
  }
  if (subscriptions.length === 0) {
    throw new Error('Initial table ownership has no subscription request');
  }
  for (const subscription of subscriptions) {
    if (!Number.isFinite(subscription.at)) {
      throw new Error('Initial table ownership has an invalid subscription timestamp');
    }
    if (subscription.socketId !== expectedSocketId) {
      throw new Error('Initial table ownership crossed physical transports');
    }
    if (subscription.at >= observationStartedAt) {
      throw new Error('Table ownership changed during the observed hand cycle');
    }
  }
}

type TableFrame = { at: number; socketId: number };

/**
 * The client may hand a facade over while the felt is still mounting: it
 * closes the facade it holds (an UNSUBSCRIBE) and acquires a new one on the
 * same physical transport in the same tick (a SUBSCRIBE). Measured in
 * production run 36511851995 (SNG dce2f701): UNSUBSCRIBE and SUBSCRIBE both
 * at 1790648806188 on socket 1, 1.7s after navigation and before the table
 * route had even mounted, while the table went on dealing for another hour.
 *
 * That pair is the same handoff `assertInitialTableOwnership` already accepts
 * for SUBSCRIBE frames, so the "never unsubscribed" assertion must accept it
 * too - but ONLY as a pair, ONLY on the observed transport, ONLY before the
 * observed hand cycle begins, and only a bounded number of times. Any other
 * UNSUBSCRIBE is a violation the caller must fail on.
 */
export const HANDOFF_PAIR_WINDOW_MS = 250;
export const MAX_INITIAL_HANDOFFS = 2;

export type UnsubscribeClassification = {
  handoffs: Array<{ unsubscribeAt: number; subscribeAt: number; socketId: number }>;
  violations: Array<{ at: number; socketId: number; why: string }>;
};

export function classifyUnsubscribes(
  unsubscribes: readonly TableFrame[],
  subscribes: readonly TableFrame[],
  expectedSocketId: number,
  observationStartedAt: number
): UnsubscribeClassification {
  if (!Number.isFinite(observationStartedAt) || !Number.isInteger(expectedSocketId)) {
    throw new Error('Unsubscribe classification requires an exact observation and transport');
  }
  const result: UnsubscribeClassification = { handoffs: [], violations: [] };
  const claimed = new Set<number>();
  for (const unsubscribe of unsubscribes) {
    if (!Number.isFinite(unsubscribe.at)) {
      result.violations.push({
        at: unsubscribe.at,
        socketId: unsubscribe.socketId,
        why: 'invalid timestamp',
      });
      continue;
    }
    if (unsubscribe.socketId !== expectedSocketId) {
      result.violations.push({
        at: unsubscribe.at,
        socketId: unsubscribe.socketId,
        why: 'crossed physical transports',
      });
      continue;
    }
    if (unsubscribe.at >= observationStartedAt) {
      result.violations.push({
        at: unsubscribe.at,
        socketId: unsubscribe.socketId,
        why: 'during the observed hand cycle',
      });
      continue;
    }
    const partnerIndex = subscribes.findIndex(
      (subscribe, index) =>
        !claimed.has(index) &&
        subscribe.socketId === unsubscribe.socketId &&
        subscribe.at >= unsubscribe.at &&
        subscribe.at - unsubscribe.at <= HANDOFF_PAIR_WINDOW_MS
    );
    if (partnerIndex < 0) {
      result.violations.push({
        at: unsubscribe.at,
        socketId: unsubscribe.socketId,
        why: 'left the table without re-acquiring it',
      });
      continue;
    }
    claimed.add(partnerIndex);
    result.handoffs.push({
      unsubscribeAt: unsubscribe.at,
      subscribeAt: subscribes[partnerIndex]!.at,
      socketId: unsubscribe.socketId,
    });
  }
  if (result.handoffs.length > MAX_INITIAL_HANDOFFS) {
    for (const extra of result.handoffs.splice(MAX_INITIAL_HANDOFFS)) {
      result.violations.push({
        at: extra.unsubscribeAt,
        socketId: extra.socketId,
        why: `more than ${MAX_INITIAL_HANDOFFS} handoffs while mounting`,
      });
    }
  }
  return result;
}
