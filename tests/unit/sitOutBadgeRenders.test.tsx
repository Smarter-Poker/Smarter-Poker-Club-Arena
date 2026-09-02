/**
 * THE BADGE ACTUALLY RENDERS A CLOCK.
 *
 * Every other assertion about this feature is a `readFileSync` plus a regex over
 * source text, and source-text tests cannot see the two defects that made the
 * first version of it useless in practice:
 *
 *   1. `sitOutAt` was a field on the player object, and `mapEngineSnapshot`
 *      builds a BRAND NEW player from a fixed list of nine fields on every
 *      engine broadcast — so the stamp was erased at the next frame.
 *   2. `SeatSlot`'s memo comparator did not compare it, so the poll that
 *      supplies the stamp could not re-render the seat that displays it. On the
 *      deferred-sit-out path (tap Sit Out mid-hand; the trigger stamps at
 *      settlement) that is the ONLY way the stamp ever arrives, so the badge
 *      showed no clock at all for the full five minutes.
 *
 * Both passed a grep. Neither passed a render. So this file renders.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { SitOutBadge } from '../../src/components/table/SitOutBadge';
import { SITOUT_MAX_MS } from '../../src/lib/sitOutDeadline';

const NOW = 1_700_000_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const badge = () => screen.getByTestId('seat-sitout-badge');

describe('with no stamp', () => {
  it('shows the plain tag and starts no timer', () => {
    render(<SitOutBadge sitOutAt={null} />);
    expect(badge().textContent).toBe('Sitting Out');
    // A tournament seat, or a stamp that has not landed yet: no clock to run.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('treats undefined the same as null', () => {
    render(<SitOutBadge />);
    expect(badge().textContent).toBe('Sitting Out');
  });
});

describe('with a server stamp', () => {
  it('renders the remaining time, hedged as an upper bound', () => {
    /* "Up To", never a bare countdown: the rule is "2 orbits or 5 minutes,
       whichever comes FIRST" and no client can see orbits, so a bare number
       promises time the player may not have. */
    render(<SitOutBadge sitOutAt={NOW - 60_000} />);
    expect(badge().textContent).toBe('Sitting Out. Up To 4:00');
  });

  it('counts down as time passes', () => {
    render(<SitOutBadge sitOutAt={NOW} />);
    expect(badge().textContent).toBe(`Sitting Out. Up To 5:00`);
    act(() => {
      vi.advanceTimersByTime(90_000);
    });
    expect(badge().textContent).toBe('Sitting Out. Up To 3:30');
  });

  it('goes urgent in the last minute, and says so in a class the CSS can reach', () => {
    render(<SitOutBadge sitOutAt={NOW - (SITOUT_MAX_MS - 30_000)} />);
    expect(badge().className).toContain('seat__sitout-badge--urgent');
    expect(badge().textContent).toBe('Sitting Out. Up To 0:30');
  });

  it('is not urgent with more than a minute left', () => {
    render(<SitOutBadge sitOutAt={NOW - 60_000} />);
    expect(badge().className).not.toContain('--urgent');
  });

  it('never claims time that has run out', () => {
    render(<SitOutBadge sitOutAt={NOW - SITOUT_MAX_MS - 5_000} />);
    expect(badge().textContent).toBe('Sitting Out. Seat At Risk');
  });

  it('stops ticking at zero instead of re-rendering forever', () => {
    /* `sitOutMsRemaining` floors at 0 rather than returning null, so anything
       keyed on "is there a deadline" stays true after expiry. Past 0:00 the
       label cannot get more urgent — an interval that keeps firing is a
       once-a-second re-render per sat-out seat for as long as the eviction
       sweep takes to land. */
    render(<SitOutBadge sitOutAt={NOW - (SITOUT_MAX_MS - 2_000)} />);
    expect(vi.getTimerCount()).toBe(1);
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(badge().textContent).toBe('Sitting Out. Seat At Risk');
    expect(vi.getTimerCount(), 'the interval is still running past 0:00').toBe(0);
  });

  it('follows a stamp that changes, without leaking the old interval', () => {
    /* The server's answer replaces the provisional local one, so the stamp DOES
       change under a mounted badge. */
    const { rerender } = render(<SitOutBadge sitOutAt={NOW} />);
    expect(badge().textContent).toBe('Sitting Out. Up To 5:00');
    rerender(<SitOutBadge sitOutAt={NOW - 120_000} />);
    expect(badge().textContent).toBe('Sitting Out. Up To 3:00');
    expect(vi.getTimerCount(), 'the old interval outlived the stamp change').toBe(1);
  });

  it('clears its interval on unmount', () => {
    const { unmount } = render(<SitOutBadge sitOutAt={NOW} />);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
