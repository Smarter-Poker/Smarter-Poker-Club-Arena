/**
 * ═══ WHERE THE "BOMB POT!" TITLE MAY STAND (Dan 2026-09-04) ═══════════════
 *
 * "THE 'BOMB POT' THAT EXPLODES AND APPEARS ON THE TABLE NEEDS TO BE HIGHER,
 * IT COVERS THE BOARD WHILE DISPLAYING."
 *
 * Pure geometry for BombPotOverlay, in its own module so the component file
 * exports only a component (react-refresh) and the unit test imports the
 * function directly. See the note beside the constants in BombPotOverlay.tsx
 * for why a viewport percentage can never do this job.
 */

export const TITLE_GAP_PX = 10;
export const TITLE_MIN_SCALE = 0.62;
export const TITLE_FALLBACK_TOP = '22%';

export type TitleAnchor = { bottomPx: number; scale: number };

export function measureTitleAnchor(scope: ParentNode, blockHeight: number): TitleAnchor | null {
  if (typeof window === 'undefined') return null;
  const rectOf = (sel: string) => {
    const el = scope.querySelector(sel);
    if (!el) return null;
    const r = (el as HTMLElement).getBoundingClientRect();
    return r.height > 0 && r.width > 0 ? r : null;
  };
  // The pot's chip pile is absolutely positioned above the pill, so it is not
  // inside `.pot-display`'s own box; it is measured on its own.
  const ceilings = [
    rectOf('.pot-display'),
    rectOf('.pot-display__pile--pot'),
    rectOf('.community-area'),
  ].filter((r): r is DOMRect => r !== null);
  if (ceilings.length === 0) return null;
  const ceiling = Math.min(...ceilings.map((r) => r.top));

  // The seats that stand ABOVE the pot are the ones the block must not climb
  // onto. A seat is "above" when its whole box is above the ceiling.
  let floor = 0;
  scope.querySelectorAll('.seat-wrapper').forEach((el) => {
    const r = (el as HTMLElement).getBoundingClientRect();
    if (r.height > 0 && r.bottom <= ceiling) floor = Math.max(floor, r.bottom);
  });

  const band = ceiling - floor - 2 * TITLE_GAP_PX;
  const scale =
    blockHeight > 0 && band > 0 && band < blockHeight
      ? Math.max(TITLE_MIN_SCALE, band / blockHeight)
      : 1;
  return { bottomPx: Math.max(0, window.innerHeight - (ceiling - TITLE_GAP_PX)), scale };
}
