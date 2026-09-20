export const STREET_WIDTH = 2.8;
export const DONKEY_SCALE = 0.78;
/** Street zero is the starting refuge. Each successful step is centered in its own street. */
export const streetCenter = (step: number) => step * STREET_WIDTH;
export function crossingTrafficVisible(lane: number, picked: number, lost: boolean): boolean {
  const current = Math.max(0, picked - (lost ? 1 : 0));
  return lane !== current && lane !== current + 1;
}
/** A confirmed collision is a one-shot presentation, never a game outcome generator. */
export function collisionFrame(elapsedMs: number, reduced = false) {
  const t = reduced ? 1 : Math.max(0, Math.min(1, elapsedMs / 1050));
  return {
    carZ: 9 - 18 * t,
    hit: t >= 0.5,
    finished: t >= 1,
    fall: Math.max(0, Math.min(1, (t - 0.5) * 2)),
  };
}
