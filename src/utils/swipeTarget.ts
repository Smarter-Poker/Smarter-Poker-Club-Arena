/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  swipeTargetIndex — which table a horizontal swipe lands on
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-21: "you should be able to keep swiping in one direction as
 * well, if when you get to the end by swiping right or left, it should just
 * restart at the first table."
 *
 * So the strip is a RING, not a line. Swiping left past the last table lands
 * on the first; swiping right past the first lands on the last. A player can
 * keep flicking one way and cycle their tables forever.
 *
 * Pure and exported so the wrap is unit-testable - the version of this logic
 * that lived inline in a touch handler could only ever be tested by hand, and
 * the two `if (activeIndex > 0)` / `if (activeIndex < length - 1)` guards it
 * carried are exactly what made the ends dead.
 */

export interface SwipeTargetInput {
  /** Index the strip is currently showing. */
  activeIndex: number;
  /** How many tabs are in the strip. */
  count: number;
  /** Drag distance in px: positive = dragged right, negative = dragged left. */
  offset: number;
  /** Milliseconds the gesture took, for the flick (velocity) path. */
  elapsedMs: number;
  /** Distance that commits a switch on its own. */
  threshold?: number;
  /** px/ms above which a SHORT drag still counts as a deliberate flick. */
  velocityThreshold?: number;
  /** Minimum distance a flick must cover, so a tap cannot switch tables. */
  flickMinOffset?: number;
}

export function swipeTargetIndex({
  activeIndex,
  count,
  offset,
  elapsedMs,
  threshold = 50,
  velocityThreshold = 0.3,
  flickMinOffset = 20,
}: SwipeTargetInput): number {
  // Nothing to swipe between. Also guards the modulo below against count 0.
  if (!Number.isFinite(count) || count <= 1) return activeIndex;

  const elapsed = Math.max(elapsedMs, 1);
  const velocity = Math.abs(offset) / elapsed;
  const flicked = velocity > velocityThreshold;

  const wantsPrev = offset > threshold || (flicked && offset > flickMinOffset);
  const wantsNext = offset < -threshold || (flicked && offset < -flickMinOffset);

  // Dragged RIGHT reveals what is to the LEFT: the previous table.
  if (wantsPrev) return (activeIndex - 1 + count) % count;
  // Dragged LEFT reveals the next table.
  if (wantsNext) return (activeIndex + 1) % count;
  return activeIndex;
}
