/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CARD PEEL — the geometry of lifting a corner of a face-down card
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-04: "THE CORNERS OF THE CARDS SHOULD BE 'PEELED BACK' LIKE YOUR
 * LOOKING AT THEM AT A REAL POKER TABLE ... NOT JUST CLICK TO REVEAL, IT NEEDS
 * TO FEEL AND ACT LIKE THE USER IS ACTUALLY TOUCHING THE SCREEN AND LIFTING THE
 * CARDS OFF THE FELT."
 *
 * This module is the maths only - no DOM, no React - so it can be unit tested
 * to the pixel. SeatSlot feeds it the corner the finger grabbed and where the
 * finger is now, and paints what comes back.
 *
 * THE MODEL. A corner C of the card back is pinched and dragged to the point P.
 * The back folds along the perpendicular bisector of C->P (the FOLD LINE): the
 * part of the back nearer C than P is lifted off the face and lands, mirrored,
 * on the other side of the fold with its corner exactly under the finger. So:
 *
 *   cover  = the back, clipped to the half of the card still lying flat
 *            (points on P's side of the fold)
 *   flap   = the lifted part - the same back, clipped to the removed half and
 *            REFLECTED across the fold line (a CSS matrix), so C maps to P
 *   face   = shows through wherever the cover was removed
 *
 * A flat fold is how every page-curl in the wild is drawn; the curve of a real
 * card is sold by shading along the fold (SeatSlot.css) and by the whole card
 * lifting off the felt as progress grows.
 *
 * Coordinates are card-local pixels, origin top-left, y down. Clip paths come
 * back as percentages so they survive the card being resized under the finger;
 * the reflection matrix is in pixels because reflection depends on the aspect.
 */

export type PeelCorner = 'tl' | 'tr' | 'bl' | 'br';

export interface PeelInput {
  /** Card size in px, measured when the finger went down. */
  width: number;
  height: number;
  /** Which corner is pinched. */
  corner: PeelCorner;
  /** Where the pinched corner is now (finger position), card-local px. */
  x: number;
  y: number;
}

export interface PeelFrame {
  /**
   * 0 = flat on the felt, 1 = the corner has reached the opposite corner. This
   * is the fraction of the card's diagonal the corner has travelled toward the
   * opposite corner, so a drag along the edge (which shows little face)
   * scores low and a drag straight across scores high. Note that a fold can
   * only ever lift HALF the card (at progress 1 the fold runs through the
   * centre); the full reveal past the commit threshold is SeatSlot's job.
   */
  progress: number;
  /** `polygon(...)` in % for the part of the back still lying flat. */
  coverClip: string;
  /** `polygon(...)` in % for the lifted part, in the flap's OWN (unreflected) frame. */
  flapClip: string;
  /** CSS `matrix(a, b, c, d, e, f)` reflecting the flap across the fold line, px. */
  flapTransform: string;
  /**
   * CSS gradient angle (deg) pointing from the fold line toward the pinched
   * corner, in the flap's own frame - the direction along which the flap's
   * shading should fade from dark (at the fold) to clear (at the corner).
   */
  shadeAngle: number;
  /** Distance from the fold line to the pinched corner, px - the flap's depth. */
  flapDepth: number;
  /** Fold line midpoint, card-local px (for positioning shade bands). */
  foldX: number;
  foldY: number;
  /** Fold line direction angle in degrees (CSS rotate), 0 = horizontal. */
  foldAngle: number;
}

/**
 * The LEFT corner in the finger's half of the card. Dan 2026-09-04: "they
 * should be peeled left to right, not right to left" - so the pinched corner
 * is always on the left edge, and a slide to the right opens the card left to
 * right wherever the thumb landed.
 */
export function leftCorner(width: number, height: number, x: number, y: number): PeelCorner {
  void width;
  void x;
  return y < height / 2 ? 'tl' : 'bl';
}

/** The corner nearest a point (kept for callers that want a free peel). */
export function nearestCorner(width: number, height: number, x: number, y: number): PeelCorner {
  const left = x < width / 2;
  const top = y < height / 2;
  return top ? (left ? 'tl' : 'tr') : left ? 'bl' : 'br';
}

function cornerPoint(width: number, height: number, corner: PeelCorner): [number, number] {
  switch (corner) {
    case 'tl':
      return [0, 0];
    case 'tr':
      return [width, 0];
    case 'bl':
      return [0, height];
    case 'br':
      return [width, height];
  }
}

function oppositeCorner(corner: PeelCorner): PeelCorner {
  return corner === 'tl' ? 'br' : corner === 'tr' ? 'bl' : corner === 'bl' ? 'tr' : 'tl';
}

type Pt = [number, number];

/** Sutherland-Hodgman against one half-plane: keep points with f(p) >= 0. */
function clipPolygon(poly: Pt[], f: (p: Pt) => number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const fa = f(a);
    const fb = f(b);
    if (fa >= 0) out.push(a);
    if (fa >= 0 !== fb >= 0) {
      const t = fa / (fa - fb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

function toPercentPolygon(poly: Pt[], width: number, height: number): string {
  if (poly.length === 0) return 'polygon(0 0, 0 0, 0 0)';
  const r = (v: number) => Math.round(v * 100) / 100;
  return (
    'polygon(' +
    poly.map(([x, y]) => `${r((x / width) * 100)}% ${r((y / height) * 100)}%`).join(', ') +
    ')'
  );
}

/** A flat card: nothing lifted. */
export function flatPeel(width: number, height: number, corner: PeelCorner): PeelFrame {
  const [cx, cy] = cornerPoint(width, height, corner);
  return {
    progress: 0,
    coverClip: 'polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%)',
    flapClip: 'polygon(0 0, 0 0, 0 0)',
    flapTransform: 'matrix(1, 0, 0, 1, 0, 0)',
    shadeAngle: 0,
    flapDepth: 0,
    foldX: cx,
    foldY: cy,
    foldAngle: 0,
  };
}

/**
 * Where the pinched corner can be. The finger may wander anywhere on screen;
 * the corner it holds cannot leave the card by more than it could on a real
 * table, and cannot be pulled past the opposite corner.
 */
export function clampPeelPoint(
  width: number,
  height: number,
  corner: PeelCorner,
  x: number,
  y: number
): [number, number] {
  const [cx, cy] = cornerPoint(width, height, corner);
  const [ox, oy] = cornerPoint(width, height, oppositeCorner(corner));
  const diag = Math.hypot(width, height);
  let dx = x - cx;
  let dy = y - cy;
  // Never pull the corner AWAY from the card (behind its own edges).
  if (Math.sign(ox - cx) > 0) dx = Math.max(0, dx);
  else dx = Math.min(0, dx);
  if (Math.sign(oy - cy) > 0) dy = Math.max(0, dy);
  else dy = Math.min(0, dy);
  const d = Math.hypot(dx, dy);
  if (d > diag) {
    dx = (dx / d) * diag;
    dy = (dy / d) * diag;
  }
  return [cx + dx, cy + dy];
}

export function computePeel(input: PeelInput): PeelFrame {
  const { width, height, corner } = input;
  const [cx, cy] = cornerPoint(width, height, corner);
  const [px, py] = clampPeelPoint(width, height, corner, input.x, input.y);
  const dx = px - cx;
  const dy = py - cy;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.5) return flatPeel(width, height, corner);

  // Progress: travel projected onto the diagonal toward the opposite corner.
  const [ox, oy] = cornerPoint(width, height, oppositeCorner(corner));
  const diag = Math.hypot(ox - cx, oy - cy);
  const along = (dx * (ox - cx) + dy * (oy - cy)) / diag;
  const progress = Math.max(0, Math.min(1, along / diag));

  // Fold line: perpendicular bisector of C->P. n points from C toward P.
  const nx = dx / dist;
  const ny = dy / dist;
  const mx = (cx + px) / 2;
  const my = (cy + py) / 2;
  const side = (p: Pt) => (p[0] - mx) * nx + (p[1] - my) * ny;

  const rect: Pt[] = [
    [0, 0],
    [width, 0],
    [width, height],
    [0, height],
  ];
  const cover = clipPolygon(rect, (p) => side(p)); // P's side stays flat
  const lifted = clipPolygon(rect, (p) => -side(p)); // C's side is lifted

  // Reflection across the fold: x' = M + (I - 2nnT)(x - M).
  const a = 1 - 2 * nx * nx;
  const b = -2 * nx * ny;
  const c = -2 * nx * ny;
  const d = 1 - 2 * ny * ny;
  const e = mx - (a * mx + c * my);
  const f = my - (b * mx + d * my);
  const r = (v: number) => Math.round(v * 1e6) / 1e6;

  // In the flap's own frame the fold is still the fold, and the pinched corner
  // lies in direction -n from it. CSS gradient angle: 0deg = up, 90deg = right.
  const shadeAngle = (Math.atan2(-nx, ny) * 180) / Math.PI;
  // The fold line runs perpendicular to n; CSS rotate() is measured from +x.
  const foldAngle = (Math.atan2(nx, -ny) * 180) / Math.PI;

  return {
    progress,
    coverClip: toPercentPolygon(cover, width, height),
    flapClip: toPercentPolygon(lifted, width, height),
    flapTransform: `matrix(${r(a)}, ${r(b)}, ${r(c)}, ${r(d)}, ${r(e)}, ${r(f)})`,
    shadeAngle: r(((shadeAngle % 360) + 360) % 360),
    flapDepth: dist / 2,
    foldX: mx,
    foldY: my,
    foldAngle: r(((foldAngle % 360) + 360) % 360),
  };
}

/**
 * The point the pinched corner would be at for a given progress along the
 * diagonal - used to animate a release (spring back to 0) or a commit (fly to
 * 1) without the finger.
 */
export function peelPointAtProgress(
  width: number,
  height: number,
  corner: PeelCorner,
  progress: number
): [number, number] {
  const [cx, cy] = cornerPoint(width, height, corner);
  const [ox, oy] = cornerPoint(width, height, oppositeCorner(corner));
  const p = Math.max(0, Math.min(1, progress));
  return [cx + (ox - cx) * p, cy + (oy - cy) * p];
}
