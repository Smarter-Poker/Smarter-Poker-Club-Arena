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
