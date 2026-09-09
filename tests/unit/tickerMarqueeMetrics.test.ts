/**
 * THE LOOP HAS TO CLOSE, AND THE PACE HAS TO MEAN THE SAME THING EVERY TIME
 *
 * Two defects from the 2026-09-05 audit live here, and both were invisible to
 * the old suite because nothing measured the rail.
 *
 * DEAD RAIL. The message was duplicated exactly twice and animated to
 * `translateX(-50%)`. On a wide display two copies are narrower than the track,
 * so both are on screen at once with empty bar after them and the "loop" is a
 * gap sweeping past. The first describe block below is that arithmetic.
 *
 * FIXED DURATION. `--ticker-speed` was a whole-loop time, so one countdown
 * crawled and eight joined operational messages blurred - from the same
 * operator setting. Pace is px/sec now, and `speedSeconds` keeps its stored
 * name, range and direction so no club has to be re-educated and no migration
 * has to run.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_PX_PER_SECOND,
  MIN_PX_PER_SECOND,
  marqueeMetrics,
  pxPerSecondFor,
} from '../../src/components/tournament/marqueeMetrics';

describe('marqueeMetrics: the loop always closes', () => {
  it('renders enough copies to cover the travel plus the whole track', () => {
    /* THE INVARIANT. At the end of the animation the scroller has moved one
       copy width, so the visible window reads scroller pixels
       [copy, copy + track]. Content shorter than that is empty rail. */
    const cases = [
      { trackWidth: 2530, copyWidth: 3900 },
      { trackWidth: 375, copyWidth: 380 },
      { trackWidth: 900, copyWidth: 901 },
      { trackWidth: 1200, copyWidth: 4800 },
      { trackWidth: 3440, copyWidth: 3441 },
    ];
    for (const c of cases) {
      const m = marqueeMetrics({ ...c, pxPerSecond: 55 });
      expect(m.isStatic, `${c.trackWidth}/${c.copyWidth}`).toBe(false);
      expect(
        m.copies * c.copyWidth,
        `${m.copies} copies of ${c.copyWidth} must cover ${c.copyWidth + c.trackWidth}`
      ).toBeGreaterThanOrEqual(m.travelPx + c.trackWidth);
    }
  });

  it('is the regression: the screenshot no longer scrolls at all', () => {
    /* The screenshot that opened the audit: a ~390px announcement on a ~2530px
       track. The old renderer drew two copies - 780px inside 2530px - and slid
       them, so the reader saw the same line twice and then 1,750px of empty
       rail. There are two correct answers to that geometry and this is the
       better one: the message FITS, so it holds still and centres. Nothing
       sweeps, because there is nothing to sweep to. */
    const m = marqueeMetrics({ trackWidth: 2530, copyWidth: 390, pxPerSecond: 55 });
    expect(m.isStatic).toBe(true);
    expect(m.travelPx).toBe(0);
  });

  it('and when it genuinely does not fit, it covers the gap', () => {
    /* Eight joined operational messages on a phone. Here motion is the right
       answer and the copies have to close the loop. */
    const m = marqueeMetrics({ trackWidth: 375, copyWidth: 3200, pxPerSecond: 55 });
    expect(m.isStatic).toBe(false);
    expect(m.copies * 3200).toBeGreaterThanOrEqual(m.travelPx + 375);
  });

  it('travels one copy width, never a percentage of the scroller', () => {
    /* A percentage is a fraction of a container whose width changes with the
       number of copies, which is exactly how -50% stopped being one copy. */
    const m = marqueeMetrics({ trackWidth: 1000, copyWidth: 1400, pxPerSecond: 55 });
    expect(m.travelPx).toBe(1400);
  });

  it('never renders fewer than two copies when it is moving', () => {
    const m = marqueeMetrics({ trackWidth: 100, copyWidth: 4000, pxPerSecond: 55 });
    expect(m.copies).toBeGreaterThanOrEqual(2);
  });
});

describe('marqueeMetrics: motion means there is more to read', () => {
  it('holds still when the message fits the rail', () => {
    const m = marqueeMetrics({ trackWidth: 1200, copyWidth: 500, pxPerSecond: 55 });
    expect(m.isStatic).toBe(true);
    expect(m.copies).toBe(1);
    expect(m.durationSeconds).toBe(0);
  });

  it('holds still rather than animating against numbers it does not have', () => {
    for (const input of [
      { trackWidth: 0, copyWidth: 0 },
      { trackWidth: 900, copyWidth: 0 },
      { trackWidth: 0, copyWidth: 400 },
      { trackWidth: Number.NaN, copyWidth: 400 },
      { trackWidth: 900, copyWidth: Number.NaN },
    ]) {
      expect(marqueeMetrics({ ...input, pxPerSecond: 55 }).isStatic).toBe(true);
    }
  });
});

describe('marqueeMetrics: one pace, every message length', () => {
  it('takes twice as long over twice the content', () => {
    const short = marqueeMetrics({ trackWidth: 300, copyWidth: 800, pxPerSecond: 55 });
    const long = marqueeMetrics({ trackWidth: 300, copyWidth: 1600, pxPerSecond: 55 });
    expect(long.durationSeconds).toBeCloseTo(short.durationSeconds * 2, 0);
  });

  it('is the regression: a fixed duration read at different speeds', () => {
    /* Under the old rule both of these were 24 seconds, so the second one went
       past at four times the pace of the first. */
    const one = marqueeMetrics({ trackWidth: 300, copyWidth: 400, pxPerSecond: 55 });
    const eight = marqueeMetrics({ trackWidth: 300, copyWidth: 3200, pxPerSecond: 55 });
    expect(one.durationSeconds).not.toBe(eight.durationSeconds);
    // Same pixels per second, whatever the length.
    expect(400 / one.durationSeconds).toBeCloseTo(3200 / eight.durationSeconds, 0);
  });

  it('clamps a nonsense pace instead of dividing by it', () => {
    const m = marqueeMetrics({ trackWidth: 300, copyWidth: 1200, pxPerSecond: 0 });
    expect(Number.isFinite(m.durationSeconds)).toBe(true);
    expect(m.durationSeconds).toBeGreaterThan(0);
  });
});

describe('pxPerSecondFor: the stored setting keeps its meaning', () => {
  it('lands the default 24 on the pace this was tuned against', () => {
    expect(pxPerSecondFor(24)).toBe(55);
  });

  it('keeps the slider running fast to slow', () => {
    expect(pxPerSecondFor(8)).toBeGreaterThan(pxPerSecondFor(24));
    expect(pxPerSecondFor(24)).toBeGreaterThan(pxPerSecondFor(60));
  });

  it('stays inside the readable band at both ends of the stored range', () => {
    for (const seconds of [8, 12, 24, 36, 48, 60]) {
      const pace = pxPerSecondFor(seconds);
      expect(pace).toBeGreaterThanOrEqual(MIN_PX_PER_SECOND);
      expect(pace).toBeLessThanOrEqual(MAX_PX_PER_SECOND);
    }
  });

  it('falls back rather than dividing by zero or by a word', () => {
    expect(pxPerSecondFor(0)).toBe(55);
    expect(pxPerSecondFor(Number.NaN)).toBe(55);
    expect(pxPerSecondFor(-4)).toBe(55);
  });
});
