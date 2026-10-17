export interface FlightPoint {
  x: number;
  y: number;
}

/** Live DOM bounds include rotation, viewport fitting, hero lift and the BBJ cap. */
export function winnerViewportPoint(
  root: Element | null,
  userId: string,
  fallback: FlightPoint
): FlightPoint {
  const seat = Array.from(root?.querySelectorAll<HTMLElement>('[data-player-id]') ?? []).find(
    (element) => element.dataset.playerId === userId
  );
  const rect = seat?.querySelector('.seat__info')?.getBoundingClientRect();
  return rect && rect.width > 0 && rect.height > 0
    ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    : fallback;
}
export function potViewportPoint(root: Element | null, fallback: FlightPoint): FlightPoint {
  const rect = (
    root?.querySelector('.pot-display__pile') ?? root?.querySelector('.pot-display')
  )?.getBoundingClientRect();
  return rect && rect.width > 0 && rect.height > 0
    ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    : fallback;
}
/** A transformed table/tile is a fixed-position containing block, too. */
export function viewportPointInFrame(
  point: FlightPoint,
  frame: { left: number; top: number; width: number; height: number },
  localWidth: number,
  localHeight: number
): FlightPoint {
  return {
    x: (point.x - frame.left) / (frame.width / localWidth || 1),
    y: (point.y - frame.top) / (frame.height / localHeight || 1),
  };
}
