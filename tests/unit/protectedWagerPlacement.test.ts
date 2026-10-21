import { describe, expect, it } from 'vitest';
import { assignProtectedWagers, wagerBoxesOverlap } from '../../src/lib/protectedWagerPlacement';
const box = (left: number, top = 0) => ({ left, top, width: 36, height: 20 });
describe('shared measured wager rail assignment', () => {
  it('preserves the sole slot of a constrained player instead of taking it greedily', () => {
    const first = box(0),
      second = box(40);
    expect(assignProtectedWagers([[first, second], [first]])).toEqual([second, first]);
  });
  it('returns no complete assignment when the measured rail cannot fit all wagers', () => {
    expect(assignProtectedWagers([[box(0)], [box(0)]])).toBeNull();
  });
  it('retains two pixels of daylight on both axes', () => {
    expect(wagerBoxesOverlap(box(0), box(37))).toBe(true);
    expect(wagerBoxesOverlap(box(0), box(38))).toBe(false);
    expect(wagerBoxesOverlap(box(0), box(0, 22))).toBe(false);
  });
});
