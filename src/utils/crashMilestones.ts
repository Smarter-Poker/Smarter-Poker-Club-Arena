/**
 * The marks a screen reader hears during a Crash climb (2026-10-01).
 *
 * The readout redraws the multiplier every frame. Spoken, that is either a
 * stream nobody can follow or nothing at all, so the readout is not a live
 * region while a round climbs. These marks are what the player hears instead:
 * few enough to follow, often enough to decide when to cash out.
 */
export const CRASH_MILESTONES_CENTS = [
  150, 200, 300, 500, 1000, 2000, 5000, 10_000, 25_000, 50_000, 100_000,
] as const;

/**
 * The highest mark the climb passed between two frames, or null. A slow frame
 * can jump several marks at once; only the newest is worth saying.
 */
export function crossedMilestone(previousCents: number, cents: number): number | null {
  let crossed: number | null = null;
  for (const mark of CRASH_MILESTONES_CENTS) {
    if (previousCents < mark && cents >= mark) crossed = mark;
  }
  return crossed;
}
