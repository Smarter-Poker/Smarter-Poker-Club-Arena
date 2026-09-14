/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE ONLY THING ON THE STRIP THAT MOVES EVERY SECOND
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Until 2026-09-14 the countdown lived in the CONTAINER: `now` was a piece of
 * state advanced by a 1Hz interval, which re-ran the lane memo, re-rendered
 * TickerRail, and rebuilt every field of every announcement - sixty times a
 * minute, on the same thread as a live poker table, to change four characters.
 *
 * The clock is now its own component with its own interval, so React updates
 * one text node and nothing above it moves. That makes this file the place
 * where the 1Hz behaviour is actually proven:
 *
 *   it counts down
 *   it stops at zero instead of counting into negatives forever
 *   it never starts at all for a deadline already past
 *   it clears its interval when it unmounts
 *   it reads an INSTANT, so a tab that slept does not wake up drifted
 *
 * Every test here fakes BOTH `Date` and the scheduler, because the whole point
 * of the component is the relationship between the two.
 */

import React, { act } from 'react';
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TickerClock } from '../../src/components/tournament/TickerClock';

const NOW = 1_800_000_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe('the clock counts its own second', () => {
  it('renders the distance to the deadline, not the deadline', () => {
    const { container } = render(<TickerClock deadlineMs={NOW + 210_000} urgent={false} />);
    expect(container.textContent).toBe('3:30');
  });

  it('advances once a second without anything above it re-rendering', () => {
    const { container } = render(<TickerClock deadlineMs={NOW + 210_000} urgent={false} />);
    advance(1_000);
    expect(container.textContent).toBe('3:29');
    advance(30_000);
    expect(container.textContent).toBe('2:59');
  });

  it('stops at zero rather than counting into negatives forever', () => {
    /* THE BATTERY BUG THIS PREVENTS. A strip that has reached 0:00 is about to
       be replaced by the container. An interval that outlives its reason is a
       phone losing a percent an hour to a bar nobody is reading. */
    const { container } = render(<TickerClock deadlineMs={NOW + 3_000} urgent />);
    advance(3_000);
    expect(container.textContent).toBe('0:00');
    expect(vi.getTimerCount()).toBe(0);
    advance(60_000);
    expect(container.textContent).toBe('0:00');
  });

  it('never starts an interval for a deadline already behind us', () => {
    render(<TickerClock deadlineMs={NOW - 5_000} urgent={false} />);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears its interval when the strip goes away', () => {
    const { unmount } = render(<TickerClock deadlineMs={NOW + 210_000} urgent={false} />);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reads an INSTANT, so a tab that slept wakes up on the right number', () => {
    /* `deadlineMs` is an absolute epoch, not a duration, which is what makes
       owning the second locally safe. A background tab whose interval was
       throttled for ten minutes recomputes from the wall clock on its next
       tick rather than resuming wherever it left off. */
    const { container } = render(<TickerClock deadlineMs={NOW + 900_000} urgent={false} />);
    expect(container.textContent).toBe('15:00');
    /* Ten minutes pass with the interval throttled. `advance` moves the fake
       clock the last second AND fires the tick, so the wall clock lands
       exactly ten minutes on. */
    vi.setSystemTime(NOW + 599_000);
    advance(1_000);
    expect(container.textContent).toBe('5:00');
  });

  it('restarts cleanly when the strip swaps to a different announcement', () => {
    const { container, rerender } = render(
      <TickerClock deadlineMs={NOW + 210_000} urgent={false} />
    );
    expect(container.textContent).toBe('3:30');
    rerender(<TickerClock deadlineMs={NOW + 45_000} urgent />);
    expect(container.textContent).toBe('0:45');
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe('the urgency treatment is on the digits and nowhere else', () => {
  it('is plain above a minute', () => {
    const { container } = render(<TickerClock deadlineMs={NOW + 210_000} urgent={false} />);
    const span = container.querySelector('.mtt-ticker__clock');
    expect(span).toBeTruthy();
    expect(span?.classList.contains('mtt-ticker__clock--urgent')).toBe(false);
  });

  it('carries the urgent class when the caller says the last minute has started', () => {
    const { container } = render(<TickerClock deadlineMs={NOW + 40_000} urgent />);
    expect(container.querySelector('.mtt-ticker__clock--urgent')).toBeTruthy();
  });
});
