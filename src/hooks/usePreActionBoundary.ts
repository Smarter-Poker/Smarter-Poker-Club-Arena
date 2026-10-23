import { useEffect } from 'react';

/** Snapshot action labels can disappear and return during presentation. They
 * are not proof that the hero acted after arming a new choice. */
export function usePreActionBoundary(
  handNumber: number | undefined,
  stage: string,
  inProgress: boolean,
  clear: () => void
): void {
  useEffect(() => {
    clear();
  }, [handNumber, stage, inProgress, clear]);
}

export function acceptedActionSpendsPreAction(input: {
  heroSeat: number;
  handNumber: number | undefined;
  knownHeroActionAtArm: number;
  event: { seat?: unknown; hand_number?: unknown; timestamp?: unknown };
}): boolean {
  if (input.heroSeat <= 0 || Number(input.event.seat) !== input.heroSeat) return false;
  const hand = Number(input.event.hand_number);
  if (Number.isFinite(hand) && hand > 0 && hand !== input.handNumber) return false;
  const at = Number(input.event.timestamp);
  // Compare two server timestamps. Browser/server clock skew must never
  // leave an executed choice lit, or make a valid call require a second tap.
  return !Number.isFinite(at) || at > input.knownHeroActionAtArm;
}

/** Snapshot history already includes accepted actions even if their display
 * labels are still being presented. Never compare its clock to the browser. */
export function latestHeroActionTimestamp(history: unknown, heroSeat: number): number {
  if (!Array.isArray(history)) return 0;
  return history.reduce(
    (latest, action) =>
      action && action.seat === heroSeat && Number.isFinite(Number(action.timestamp))
        ? Math.max(latest, Number(action.timestamp))
        : latest,
    0
  );
}
