/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE ACTION CLOCK — derived from the deadline, published once a second,
 *  and NOT through the page's state
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `useTableTimer` used to INTEGRATE the countdown from requestAnimationFrame
 * deltas and push the result into React state every ~33ms. That state lives in
 * TablePage, so the whole table re-rendered about thirty times a second for the
 * length of anybody's turn — and requestAnimationFrame does not run in a hidden
 * tab, so locking the phone on your own turn froze the clock that decides
 * whether to spend a time bank.
 *
 * The countdown is now `(deadline - serverNow()) / 1000`, evaluated by two
 * drivers (RAF while visible, a plain interval always) and published only when
 * the WHOLE SECOND changes — into an external store, NOT into React state, so
 * the caller does not render for it at all. (The render count that proves that
 * lives in actionClockDoesNotRenderTheTable.test.tsx; what is pinned here is
 * that the readings themselves did not change.)
 *
 * These tests pin the three things that must stay true:
 *
 *   1. the seconds it reports are the seconds that are actually left, measured
 *      against the ENGINE's deadline;
 *   2. it still expires, and it still fires the hero timeout exactly once per
 *      turn — from the interval alone, with no animation frames at all, which
 *      is precisely the hidden-tab case that used to freeze;
 *   3. it does NOT publish thirty times a second.
 *
 * requestAnimationFrame is stubbed to never call back, on purpose: everything
 * below is driven by the watchdog interval, so a pass here is a pass for a
 * backgrounded tab.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTableTimer, type UseTableTimerReturn } from '../../src/hooks/useTableTimer';

/** No animation frames anywhere in this file — the tab is "hidden". */
let rafSpy: ReturnType<typeof vi.spyOn>;
let cafSpy: ReturnType<typeof vi.spyOn>;

/** The published reading. It is on the store now, not on the hook's return. */
const read = (r: { current: UseTableTimerReturn }) => r.current.clock.getSnapshot();

beforeEach(() => {
  // Fake timers FIRST — they install their own requestAnimationFrame, and the
  // stub below has to be the one that wins.
  vi.useFakeTimers();
  rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
  cafSpy = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
});

afterEach(() => {
  rafSpy.mockRestore();
  cafSpy.mockRestore();
  vi.useRealTimers();
});

describe('the action clock reads the deadline', () => {
  it('starts at the whole seconds remaining and counts them down', () => {
    const now = Date.now();
    const { result } = renderHook(() =>
      useTableTimer({
        isActiveTurn: true,
        isHeroTurn: true,
        onTimeout: vi.fn(),
        turnDeadlineMs: now + 15_000,
        activeSeatKey: 3,
      })
    );

    expect(read(result).seconds).toBe(15);
    expect(read(result).progress).toBeCloseTo(100, 5);

    act(() => void vi.advanceTimersByTime(1000));
    expect(read(result).seconds).toBe(14);

    act(() => void vi.advanceTimersByTime(9000));
    expect(read(result).seconds).toBe(5);
    // Urgency is the last five seconds of the hero's clock.
    expect(read(result).isUrgent).toBe(true);

    act(() => void vi.advanceTimersByTime(5000));
    expect(read(result).seconds).toBe(0);
    expect(read(result).isUrgent).toBe(false);
    expect(read(result).progress).toBe(0);
  });

  it('seeds ZERO when the deadline has already passed, never a fresh full turn', () => {
    // Reconnecting onto an expired turn. Seeding initialTime here is what used
    // to re-fire the timeout and disagree with the CSS ring, which lands at 0.
    const { result } = renderHook(() =>
      useTableTimer({
        isActiveTurn: true,
        isHeroTurn: false,
        onTimeout: vi.fn(),
        turnDeadlineMs: Date.now() - 4000,
        activeSeatKey: 2,
      })
    );
    expect(read(result).seconds).toBe(0);
  });

  it('restarts from the new deadline when the turn changes', () => {
    const now = Date.now();
    const { result, rerender } = renderHook(
      (props: Parameters<typeof useTableTimer>[0]) => useTableTimer(props),
      {
        initialProps: {
          isActiveTurn: true,
          isHeroTurn: false,
          onTimeout: vi.fn(),
          turnDeadlineMs: now + 15_000,
          activeSeatKey: 1,
        },
      }
    );

    act(() => void vi.advanceTimersByTime(12_000));
    expect(read(result).seconds).toBe(3);

    // Next seat's turn opens.
    const later = Date.now();
    rerender({
      isActiveTurn: true,
      isHeroTurn: false,
      onTimeout: vi.fn(),
      turnDeadlineMs: later + 15_000,
      activeSeatKey: 2,
    });
    expect(read(result).seconds).toBe(15);
  });

  it('a time bank RESETS the clock rather than nudging a display value', () => {
    const now = Date.now();
    const { result } = renderHook(() =>
      useTableTimer({
        isActiveTurn: true,
        isHeroTurn: true,
        onTimeout: vi.fn(),
        turnDeadlineMs: now + 15_000,
        activeSeatKey: 4,
      })
    );

    act(() => void vi.advanceTimersByTime(13_000));
    expect(read(result).seconds).toBe(2);

    act(() => result.current.resetTimer(20));
    expect(read(result).seconds).toBe(20);

    // And the reset holds: the next evaluation agrees with it instead of
    // snapping back to the stale engine deadline.
    act(() => void vi.advanceTimersByTime(1000));
    expect(read(result).seconds).toBe(19);
  });

  it('re-publishes urgency when hero takes over the clock mid-second', () => {
    /* Urgency depends on the clock AND on whose turn it is. It used to be
       derived on the caller's render path, which tracked `isHeroTurn` for free;
       now it is published, so a change of turn between two whole seconds has to
       force a publication of its own. */
    const now = Date.now();
    const { result, rerender } = renderHook(
      (props: Parameters<typeof useTableTimer>[0]) => useTableTimer(props),
      {
        initialProps: {
          isActiveTurn: true,
          isHeroTurn: false,
          onTimeout: vi.fn(),
          turnDeadlineMs: now + 4000,
          activeSeatKey: 8,
        },
      }
    );

    expect(read(result).seconds).toBe(4);
    expect(read(result).isUrgent).toBe(false);

    rerender({
      isActiveTurn: true,
      isHeroTurn: true,
      onTimeout: vi.fn(),
      turnDeadlineMs: now + 4000,
      activeSeatKey: 8,
    });
    expect(read(result).isUrgent).toBe(true);
  });
});

describe('the hero timeout', () => {
  it('fires exactly once per turn, with no animation frames at all', () => {
    const onTimeout = vi.fn();
    const now = Date.now();
    renderHook(() =>
      useTableTimer({
        isActiveTurn: true,
        isHeroTurn: true,
        onTimeout,
        turnDeadlineMs: now + 15_000,
        activeSeatKey: 5,
      })
    );

    expect(rafSpy).toHaveBeenCalled(); // it asked; nothing answered
    expect(onTimeout).not.toHaveBeenCalled();

    act(() => void vi.advanceTimersByTime(15_000));
    expect(onTimeout).toHaveBeenCalledTimes(1);

    // Hold at zero for another ten seconds. The latch must not fire again —
    // every extra call is a second time bank spent and a second auto-fold.
    act(() => void vi.advanceTimersByTime(10_000));
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('does not fire when the hero is not the one on the clock', () => {
    const onTimeout = vi.fn();
    renderHook(() =>
      useTableTimer({
        isActiveTurn: true,
        isHeroTurn: false,
        onTimeout,
        turnDeadlineMs: Date.now() + 5000,
        activeSeatKey: 6,
      })
    );
    act(() => void vi.advanceTimersByTime(10_000));
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('does not fire on a stale deadline between hands', () => {
    // isActiveTurn false means nobody is on the clock. A deadline left over
    // from the hand that just ended must not spend a time bank.
    const onTimeout = vi.fn();
    renderHook(() =>
      useTableTimer({
        isActiveTurn: false,
        isHeroTurn: true,
        onTimeout,
        turnDeadlineMs: Date.now() - 1000,
        activeSeatKey: 0,
      })
    );
    act(() => void vi.advanceTimersByTime(5000));
    expect(onTimeout).not.toHaveBeenCalled();
  });
});

describe('the clock does not publish thirty times a second', () => {
  it('publishes once per whole second, not once per evaluation', () => {
    let publications = 0;
    const now = Date.now();
    const { result } = renderHook(() =>
      useTableTimer({
        isActiveTurn: true,
        isHeroTurn: true,
        onTimeout: vi.fn(),
        turnDeadlineMs: now + 15_000,
        activeSeatKey: 7,
      })
    );

    const unsubscribe = result.current.clock.subscribe(() => {
      publications += 1;
    });

    /* The clock is evaluated 150 times across this loop (the watchdog runs
       every 500ms and the throttle admits one evaluation per 50ms); it must
       PUBLISH about fifteen. The old integrating loop pushed state every ~33ms
       — roughly 450 across the same turn. */
    for (let i = 0; i < 150; i += 1) {
      act(() => void vi.advanceTimersByTime(100));
    }
    unsubscribe();

    expect(publications).toBeGreaterThanOrEqual(14);
    expect(publications).toBeLessThanOrEqual(18);
  });
});
