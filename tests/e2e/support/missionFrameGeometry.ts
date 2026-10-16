export interface MissionFrameEdge {
  card: number;
  frame: number;
  layoutGap: number;
  scroll?: number;
}

/** One single-precision coordinate ULP, capped below 1/1,000 CSS pixel.
 * Fractional compositor translations can round the two viewport edges
 * separately. Large offscreen coordinates must never buy a visible gap. */
export function missionFrameCoordinateRoundoff(card: number, frame: number, scroll = 0): number {
  const magnitude = Math.max(
    1,
    Math.abs(card),
    Math.abs(frame),
    Math.abs(card + scroll),
    Math.abs(frame + scroll)
  );
  return Math.min(2 ** -10, 2 ** (Math.floor(Math.log2(magnitude)) - 23));
}

export function missionFrameEdgeIsContinuous(edge: MissionFrameEdge): boolean {
  if (![edge.card, edge.frame, edge.layoutGap, edge.scroll ?? 0].every(Number.isFinite))
    return false;
  // This independent CSS-layout measurement retains the strict one-pixel
  // contract. Coordinate roundoff cannot excuse a real inset beyond it.
  if (Math.abs(edge.layoutGap) > 1) return false;
  return (
    Math.abs(edge.frame - edge.card) <=
    1 + missionFrameCoordinateRoundoff(edge.card, edge.frame, edge.scroll)
  );
}
