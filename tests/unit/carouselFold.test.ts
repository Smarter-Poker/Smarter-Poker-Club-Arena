/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE CAROUSEL HAS NO ENDS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-21: "a user can join and be a part of unlimited amounts of
 * clubs, but the display is limited... tiles swiping back and forth in an
 * endless carousel."
 *
 * The club strip used to be a native overflow-x scroller. That has ends: reach
 * the last club and it stops, and the only way back to the first is to drag
 * through every one in between. This wrap is what removes the ends, and it is
 * the World Hub engine's own fold. It is also the one piece of maths here that
 * is easy to get subtly wrong and impossible to see in a screenshot, so it is
 * pinned directly.
 */
import { describe, it, expect } from 'vitest';
import { foldOffset } from '../../src/components/carousel/Carousel';

describe('foldOffset', () => {
  it('puts the LAST card immediately left of the first', () => {
    // Five clubs, the first centred. Club 5 is one step to the left, not four
    // to the right: that is the whole feature.
    expect(foldOffset(4, 0, 5)).toBe(-1);
    expect(foldOffset(1, 0, 5)).toBe(1);
  });

  it('wraps in both directions from anywhere in the list', () => {
    // Centred on the last card, the FIRST is one step to the right.
    expect(foldOffset(0, 4, 5)).toBe(1);
    expect(foldOffset(3, 4, 5)).toBe(-1);
  });

  it('never returns an offset outside half the list', () => {
    for (const total of [1, 2, 3, 7, 12, 40]) {
      for (let pos = 0; pos < total; pos += 0.25) {
        for (let i = 0; i < total; i++) {
          const off = foldOffset(i, pos, total);
          expect(Math.abs(off)).toBeLessThanOrEqual(total / 2 + 1e-9);
        }
      }
    }
  });

  it('holds mid-drag, at fractional positions', () => {
    // Half a card into a swipe: the two neighbours straddle centre.
    expect(foldOffset(0, 0.5, 4)).toBeCloseTo(-0.5);
    expect(foldOffset(1, 0.5, 4)).toBeCloseTo(0.5);
  });

  it('survives a position that has run far past the list length', () => {
    // The scroll position is unbounded by design: a fling adds cards to it
    // without normalising, so this must stay correct after many laps.
    expect(foldOffset(0, 100, 5)).toBe(0);
    expect(foldOffset(1, 100, 5)).toBe(1);
    expect(foldOffset(0, -100, 5)).toBe(0);
  });

  it('is a no-op for an empty list', () => {
    expect(foldOffset(0, 0, 0)).toBe(0);
  });

  it('handles a single club without wrapping it onto itself', () => {
    expect(foldOffset(0, 0, 1)).toBe(0);
  });
});
