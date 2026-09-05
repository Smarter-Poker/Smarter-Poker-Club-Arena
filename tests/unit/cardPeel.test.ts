/**
 * The corner peel is geometry first (src/components/table/cardPeel.ts) so the
 * feel can be pinned to the pixel: the pinched corner lands under the finger,
 * the face shows through exactly where the back was lifted, and nothing is
 * lifted until the finger moves.
 */
import { describe, it, expect } from 'vitest';
import {
  computePeel,
  clampPeelPoint,
  leftCorner,
  peelPointAtProgress,
  flatPeel,
} from '../../src/components/table/cardPeel';

const W = 60;
const H = 84;

function applyMatrix(m: string, x: number, y: number): [number, number] {
  const [a, b, c, d, e, f] = m
    .replace(/matrix\(|\)/g, '')
    .split(',')
    .map(Number);
  return [a * x + c * y + e, b * x + d * y + f];
}

function polygonPoints(poly: string): Array<[number, number]> {
  return poly
    .replace(/polygon\(|\)/g, '')
    .split(',')
    .map((pair) => {
      const [x, y] = pair.trim().split(/\s+/);
      return [(parseFloat(x) / 100) * W, (parseFloat(y) / 100) * H];
    });
}

function area(poly: Array<[number, number]>): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

describe('leftCorner: the peel opens left to right (Dan 2026-09-04)', () => {
  it('always pinches a LEFT corner, top or bottom by the finger height', () => {
    expect(leftCorner(W, H, 55, 80)).toBe('bl'); // thumb on the bottom-right
    expect(leftCorner(W, H, 5, 80)).toBe('bl');
    expect(leftCorner(W, H, 55, 5)).toBe('tl'); // finger on the top-right
    expect(leftCorner(W, H, 5, 5)).toBe('tl');
  });

  it('a rightward slide from the bottom-left grows progress', () => {
    let last = -1;
    for (let dx = 0; dx <= W; dx += 10) {
      const f = computePeel({ width: W, height: H, corner: 'bl', x: dx, y: H - dx * 0.6 });
      expect(f.progress).toBeGreaterThanOrEqual(last);
      last = f.progress;
    }
    expect(last).toBeGreaterThan(0.5);
  });
});

describe('nothing is lifted until the finger moves', () => {
  it('a touch with no movement is a flat card', () => {
    const f = computePeel({ width: W, height: H, corner: 'br', x: W, y: H });
    expect(f.progress).toBe(0);
    expect(f.coverClip).toBe('polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%)');
    expect(f.flapDepth).toBe(0);
    expect(f).toEqual(flatPeel(W, H, 'br'));
  });
});

describe('the pinched corner lands under the finger', () => {
  it.each([
    ['br', W, H],
    ['bl', 0, H],
    ['tr', W, 0],
    ['tl', 0, 0],
  ] as const)('%s corner reflects onto the drag point', (corner, cx, cy) => {
    const x = W / 2 + (cx === 0 ? 8 : -8);
    const y = H / 2 + (cy === 0 ? 10 : -10);
    const f = computePeel({ width: W, height: H, corner, x, y });
    const [rx, ry] = applyMatrix(f.flapTransform, cx, cy);
    expect(rx).toBeCloseTo(x, 2);
    expect(ry).toBeCloseTo(y, 2);
  });

  it('the reflection is its own inverse (a fold, not a stretch)', () => {
    const f = computePeel({ width: W, height: H, corner: 'br', x: 20, y: 30 });
    const [x1, y1] = applyMatrix(f.flapTransform, 13, 47);
    const [x2, y2] = applyMatrix(f.flapTransform, x1, y1);
    expect(x2).toBeCloseTo(13, 2);
    expect(y2).toBeCloseTo(47, 2);
  });
});

describe('the face shows through exactly where the back was lifted', () => {
  it('cover and flap partition the card', () => {
    const f = computePeel({ width: W, height: H, corner: 'br', x: 24, y: 40 });
    const cover = polygonPoints(f.coverClip);
    const flap = polygonPoints(f.flapClip);
    expect(area(cover) + area(flap)).toBeCloseTo(W * H, 0);
    expect(area(flap)).toBeGreaterThan(0);
    expect(area(cover)).toBeGreaterThan(0);
  });

  it('a small peel lifts a small triangle at the corner', () => {
    const f = computePeel({ width: W, height: H, corner: 'br', x: W - 10, y: H - 10 });
    const flap = polygonPoints(f.flapClip);
    expect(flap.length).toBe(3);
    expect(area(flap)).toBeLessThan(W * H * 0.05);
    expect(f.progress).toBeLessThan(0.2);
  });

  it('dragging to the opposite corner is progress 1 and folds the back in half', () => {
    // A fold can lift at most half the card - the fold line then runs through
    // the centre. Past the commit threshold SeatSlot finishes the reveal.
    const f = computePeel({ width: W, height: H, corner: 'br', x: 0, y: 0 });
    expect(f.progress).toBe(1);
    expect(area(polygonPoints(f.flapClip))).toBeCloseTo((W * H) / 2, 0);
    expect(f.foldX).toBeCloseTo(W / 2, 3);
    expect(f.foldY).toBeCloseTo(H / 2, 3);
  });

  it('progress grows monotonically along the diagonal', () => {
    let last = -1;
    for (let p = 0; p <= 1; p += 0.1) {
      const [x, y] = peelPointAtProgress(W, H, 'br', p);
      const f = computePeel({ width: W, height: H, corner: 'br', x, y });
      expect(f.progress).toBeGreaterThanOrEqual(last);
      expect(f.progress).toBeCloseTo(p, 5);
      last = f.progress;
    }
  });
});

describe('the corner cannot leave the card or overshoot', () => {
  it('a finger dragged off the far side is held at the opposite corner', () => {
    const [x, y] = clampPeelPoint(W, H, 'br', -500, -500);
    expect(Math.hypot(W - x, H - y)).toBeCloseTo(Math.hypot(W, H), 3);
  });

  it('a finger dragged outward (away from the card) does not fold it inside out', () => {
    const [x, y] = clampPeelPoint(W, H, 'br', W + 30, H + 30);
    expect(x).toBe(W);
    expect(y).toBe(H);
    expect(computePeel({ width: W, height: H, corner: 'br', x: W + 30, y: H + 30 }).progress).toBe(
      0
    );
  });

  it('a drag along the bottom edge scores lower than a drag across the card', () => {
    const edge = computePeel({ width: W, height: H, corner: 'br', x: 10, y: H }).progress;
    const across = computePeel({ width: W, height: H, corner: 'br', x: 10, y: 14 }).progress;
    expect(across).toBeGreaterThan(edge);
  });
});

describe('shading points from the fold toward the pinched corner', () => {
  it('a straight-up peel from the bottom-right shades downward', () => {
    // Corner dragged straight up: fold is horizontal, corner is BELOW the fold.
    const f = computePeel({ width: W, height: H, corner: 'br', x: W, y: H - 30 });
    expect(f.shadeAngle).toBeCloseTo(180, 3); // CSS: 180deg = toward the bottom
    expect(f.foldAngle % 180).toBeCloseTo(0, 3);
    expect(f.foldY).toBeCloseTo(H - 15, 3);
  });
});
