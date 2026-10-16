import { describe, expect, it } from 'vitest';
import {
  missionFrameCoordinateRoundoff,
  missionFrameEdgeIsContinuous,
} from './e2e/support/missionFrameGeometry';

describe('mission frame geometry keeps its one CSS pixel contract', () => {
  it('accepts the observed compositor roundoff but the old raw offset check fails', () => {
    const edge = { card: 2048, frame: 2049.0001220703125, layoutGap: 1 };
    expect(Math.abs(edge.frame - edge.card) <= 1).toBe(false);
    expect(missionFrameEdgeIsContinuous(edge)).toBe(true);
  });

  it.each([1.00001, 1.0001, 1.001, 1.01, 2])('rejects a real CSS layout gap of %s', (layoutGap) => {
    expect(missionFrameEdgeIsContinuous({ card: 2048, frame: 2048 + layoutGap, layoutGap })).toBe(
      false
    );
  });

  it('accounts for document coordinates when the frame has scrolled near the viewport origin', () => {
    expect(
      missionFrameEdgeIsContinuous({ card: 0, frame: 1.0001220703125, layoutGap: 1, scroll: 2048 })
    ).toBe(true);
  });

  it.each([-1, 0, 1])('retains exact offsets of %s', (offset) => {
    expect(
      missionFrameEdgeIsContinuous({ card: 3000.125, frame: 3000.125 + offset, layoutGap: offset })
    ).toBe(true);
  });

  it('rejects viewport displacement beyond coordinate roundoff even with valid CSS insets', () => {
    expect(missionFrameEdgeIsContinuous({ card: 4096, frame: 4097.001, layoutGap: 1 })).toBe(false);
    expect(missionFrameEdgeIsContinuous({ card: 10, frame: 11.0001, layoutGap: 1 })).toBe(false);
  });

  it('does not turn large offscreen coordinates into a larger visual allowance', () => {
    expect(missionFrameCoordinateRoundoff(1e6, 1e6 + 1)).toBe(2 ** -10);
    expect(missionFrameEdgeIsContinuous({ card: 1e6, frame: 1e6 + 1.01, layoutGap: 1 })).toBe(
      false
    );
  });

  it.each([NaN, Infinity, -Infinity])('refuses malformed measurements: %s', (value) => {
    for (const key of ['card', 'frame', 'layoutGap'] as const) {
      expect(
        missionFrameEdgeIsContinuous({ card: 2000, frame: 2001, layoutGap: 1, [key]: value })
      ).toBe(false);
    }
  });
});
