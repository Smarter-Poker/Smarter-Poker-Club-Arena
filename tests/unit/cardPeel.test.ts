/**
 * THE FACE ARRIVES FROM THE TOP. It is not a corner curl and it is not a
 * bottom-up fold.
 *
 * Rebuilt 2026-09-05 from Dan's video of himself doing it with real cards.
 * He tips the pair toward himself, pivoting on the near edge, and the face
 * comes into view from the TOP DOWN - the Q and J indices first, side by side,
 * right way up, then the court art filling in beneath them.
 *
 * Two earlier versions are pinned against here because both shipped:
 *   v1  a diagonal CORNER curl with a dog-ear flap
 *   v2  a horizontal boundary running the WRONG WAY, face revealed bottom-up.
 *       That one is what "THE CARDS ARE STILL BACKWARDS" meant, so the
 *       direction is asserted explicitly below rather than left to a
 *       partition check that both versions would satisfy.
 */
import { describe, it, expect } from 'vitest';
import { computePeel, flatPeel, liftAtProgress } from '../../src/components/table/cardPeel';

const W = 50;
const H = 70;
const peel = (lift: number) => computePeel({ width: W, height: H, lift });

describe('a card lying flat', () => {
  it('shows all back and no face', () => {
    const f = flatPeel();
    expect(f.progress).toBe(0);
    expect(f.backClip).toBe('inset(0 0 0 0)');
    expect(f.faceClip).toBe('inset(0 0 100% 0)');
    expect(f.foldPercent).toBe(0);
    expect(f.bendDeg).toBe(0);
  });

  it('a touch that has not moved, or moved DOWN, is still flat', () => {
    expect(peel(0)).toEqual(flatPeel());
    expect(peel(-30)).toEqual(flatPeel());
  });
});

describe('the face is revealed from the top downward', () => {
  it('THE INDICES COME FIRST: a small lift shows the TOP of the face, not the bottom', () => {
    const f = peel(H * 0.12);
    // Face keeps its top 12% - the corner the rank and suit are printed in.
    expect(f.faceClip).toBe('inset(0 0 88% 0)');
    // Back keeps the remaining 88%, measured from its top.
    expect(f.backClip).toBe('inset(12% 0 0 0)');
  });

  it('half a card of lift puts the boundary across the middle', () => {
    const f = peel(H / 2);
    expect(f.progress).toBeCloseTo(0.5, 5);
    expect(f.foldPercent).toBeCloseTo(50, 5);
    expect(f.backClip).toBe('inset(50% 0 0 0)');
    expect(f.faceClip).toBe('inset(0 0 50% 0)');
  });

  it('the boundary travels DOWN as the drag grows (v2 ran it up)', () => {
    let last = -1;
    for (const p of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const fold = peel(H * p).foldPercent;
      expect(fold).toBeGreaterThan(last);
      last = fold;
    }
  });

  it('the two clips always partition the card with no gap and no overlap', () => {
    for (const p of [0.1, 0.25, 0.4, 0.6, 0.75, 0.9, 1]) {
      const f = peel(H * p);
      const backTop = Number(/inset\(([\d.]+)% 0 0 0\)/.exec(f.backClip)![1]);
      const faceBottom = Number(/inset\(0 0 ([\d.]+)% 0\)/.exec(f.faceClip)![1]);
      expect(backTop + faceBottom).toBeCloseTo(100, 5);
      expect(backTop).toBeCloseTo(f.foldPercent, 5);
    }
  });

  it('a full card of lift shows the whole face and none of the back', () => {
    const f = peel(H);
    expect(f.progress).toBe(1);
    expect(f.foldPercent).toBe(100);
    expect(f.faceClip).toBe('inset(0 0 0% 0)');
    expect(f.backClip).toBe('inset(100% 0 0 0)');
  });

  it('never goes past fully open, however far the finger travels', () => {
    expect(peel(H * 5).progress).toBe(1);
    expect(peel(H * 5).foldPercent).toBe(100);
  });

  it('progress rises monotonically with lift', () => {
    let last = -1;
    for (let px = 0; px <= H; px += 5) {
      const p = peel(px).progress;
      expect(p).toBeGreaterThanOrEqual(last);
      last = p;
    }
  });
});

describe('the pair tips toward the player as it comes up', () => {
  it('is flat at both ends and tipped in the middle - held to the eye it is square again', () => {
    expect(peel(0).bendDeg).toBe(0);
    expect(peel(H).bendDeg).toBeCloseTo(0, 1);
    expect(peel(H / 2).bendDeg).toBeGreaterThan(10);
  });
});

describe('liftAtProgress is the inverse, for tweening a release', () => {
  it('round-trips', () => {
    for (const p of [0, 0.3, 0.55, 1]) {
      expect(peel(liftAtProgress(H, p)).progress).toBeCloseTo(p, 5);
    }
  });
});
