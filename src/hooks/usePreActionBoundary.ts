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
  armedAt: number | null;
  event: { seat?: unknown; hand_number?: unknown; timestamp?: unknown };
}): boolean {
  if (input.heroSeat <= 0 || Number(input.event.seat) !== input.heroSeat) return false;
  const hand = Number(input.event.hand_number);
  if (Number.isFinite(hand) && hand > 0 && hand !== input.handNumber) return false;
  const at = Number(input.event.timestamp);
  // A delayed echo from the action before this tap cannot cancel the new arm.
  return input.armedAt === null || !Number.isFinite(at) || at >= input.armedAt;
}
