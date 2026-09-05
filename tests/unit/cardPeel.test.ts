/**
 * THE FACE COMES UP FROM THE BOTTOM, AND THAT IS DAN'S CALL, NOT A READING OF
 * HIS VIDEO.
 *
 * Three directions have shipped. The history matters because the pins below
 * exist to stop the fourth:
 *
 *   v1  a diagonal CORNER curl with a dog-ear flap
 *   v2  a horizontal boundary, face revealed BOTTOM-UP
 *   v3  I went back to the video frame by frame, concluded the face arrived
 *       from the TOP, and "corrected" v2 into it
 *   v4  Dan, on the shipped v3: "THE CARDS ARE 'PEELING BACKWARDS' TOP TO
 *       BOTTOM INSTEAD OF THE WAY I SHOWED YOU IN THE PREVIOUS VIDEO."
 *
 * So this file pins the bottom-up direction against BOTH wrong answers, and
 * asserts the top-down clips are absent by name - because a partition check,
 * which is what v2 had, is satisfied perfectly by a peel running backwards.
 */
import { describe, it, expect } from 'vitest';
import { computePeel, flatPeel, liftAtProgress } from '../../src/components/table/cardPeel';

const W = 50;
const H = 70;
const peel = (lift: number) => computePeel({ width: W, height: H, lift });

describe('a card lying flat on the felt', () => {
  it('shows all back and no face', () => {
    const f = flatPeel();
    expect(f.progress).toBe(0);
    expect(f.backClip).toBe('inset(0 0 0 0)');
    expect(f.faceClip).toBe('inset(100% 0 0 0)');
    expect(f.foldPercent).toBe(100);
    expect(f.bendDeg).toBe(0);
  });

  it('a touch that has not moved, or moved DOWN, is still flat', () => {
    expect(peel(0)).toEqual(flatPeel());
    expect(peel(-30)).toEqual(flatPeel());
  });
});

describe('the near edge lifts and the face comes up from the bottom', () => {
  it('A SMALL LIFT SHOWS THE BOTTOM OF THE FACE, NOT THE TOP', () => {
    const f = peel(H * 0.12);
    // Face keeps its bottom 12%: clip 88% off the top.
    expect(f.faceClip).toBe('inset(88% 0 0 0)');
    // Back keeps the top 88%: clip 12% off the bottom.
    expect(f.backClip).toBe('inset(0 0 12% 0)');
  });

  it('is NOT the top-down peel that shipped as v3', () => {
    // Named explicitly. v3 produced exactly these two, and every structural
    // check in this file passed while it did.
    const f = peel(H * 0.12);
    expect(f.faceClip).not.toBe('inset(0 0 88% 0)');
    expect(f.backClip).not.toBe('inset(12% 0 0 0)');
  });

  it('half a card of lift puts the boundary across the middle', () => {
    const f = peel(H / 2);
    expect(f.progress).toBeCloseTo(0.5, 5);
    expect(f.foldPercent).toBeCloseTo(50, 5);
    expect(f.backClip).toBe('inset(0 0 50% 0)');
    expect(f.faceClip).toBe('inset(50% 0 0 0)');
  });

  it('the boundary travels UP as the drag grows', () => {
    let last = 101;
    for (const p of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const fold = peel(H * p).foldPercent;
      expect(fold).toBeLessThan(last);
      last = fold;
    }
  });

  it('the two clips always partition the card with no gap and no overlap', () => {
    for (const p of [0.1, 0.25, 0.4, 0.6, 0.75, 0.9, 1]) {
      const f = peel(H * p);
      const backBottom = Number(/inset\(0 0 ([\d.]+)% 0\)/.exec(f.backClip)![1]);
      const faceTop = Number(/inset\(([\d.]+)% 0 0 0\)/.exec(f.faceClip)![1]);
      expect(backBottom + faceTop).toBeCloseTo(100, 5);
      expect(faceTop).toBeCloseTo(f.foldPercent, 5);
    }
  });

  it('a full card of lift shows the whole face and none of the back', () => {
    const f = peel(H);
    expect(f.progress).toBe(1);
    expect(f.foldPercent).toBe(0);
    expect(f.faceClip).toBe('inset(0% 0 0 0)');
    expect(f.backClip).toBe('inset(0 0 100% 0)');
  });

  it('never goes past fully open, however far the finger travels', () => {
    expect(peel(H * 5).progress).toBe(1);
    expect(peel(H * 5).foldPercent).toBe(0);
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
