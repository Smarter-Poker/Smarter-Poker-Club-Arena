/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE CLUB STOPS REFRESHING ITSELF
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-02, binding: "CLUBS SHOULD NOT BE 'RANDOMLY REFRESHING' ON
 * THERE OWN, IT FEELS LIKE A BUG OR GLITCH THAT SHOULDN'T HAPPEN... FIX WHAT
 * EVER IS CAUSING THAT TO HAPPEN. ITS ALSO HAPPENING INSIDE OF THE TABLE
 * MANAGEMENT PAGE, FIX IT FOR EVERY PAGE AND SUB PAGE OF THE CLUB ARENA."
 *
 * Both surfaces re-read themselves on every realtime row event, and on a live
 * floor those events arrive several times a second:
 *
 *   club_members            every buy-in and cash-out moves a chip_balance
 *   game_management_events  2,108 rows in ten minutes for ONE club (measured
 *                           2026-09-02, 3.5 a second)
 *
 * So the pages rebuilt themselves continuously. Two mechanisms fix it, and
 * both are pinned here because both are invisible in a diff:
 *
 *   useCoalescedRefresh - the feed is a freshness signal, so the page re-reads
 *                         on a floor rather than on an event.
 *   mergeById           - the re-read that does happen keeps the identity of
 *                         every row it did not change, so React leaves the
 *                         rendered rows (and open menus, and scroll position)
 *                         alone.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { mergeById, rowsAreEqual } from '../../src/utils/mergeById';
import { useCoalescedRefresh } from '../../src/hooks/useCoalescedRefresh';

describe('mergeById keeps the identity of every row it did not change', () => {
  const key = (r: { id: string }) => r.id;

  it('an unchanged list returns the SAME array, so setState bails out', () => {
    const current = [
      { id: 'a', n: 1 },
      { id: 'b', n: 2 },
    ];
    const next = [
      { id: 'a', n: 1 },
      { id: 'b', n: 2 },
    ];
    expect(mergeById(current, next, key)).toBe(current);
  });

  it('a changed row is replaced and its neighbours are not', () => {
    const a = { id: 'a', n: 1 };
    const b = { id: 'b', n: 2 };
    const merged = mergeById(
      [a, b],
      [
        { id: 'a', n: 1 },
        { id: 'b', n: 99 },
      ],
      key
    );
    expect(merged).not.toBe([a, b]);
    expect(merged[0]).toBe(a); // untouched: same object, React skips it
    expect(merged[1]).not.toBe(b);
    expect(merged[1].n).toBe(99);
  });

  it('the refresh is still authoritative about membership and order', () => {
    const a = { id: 'a', n: 1 };
    const b = { id: 'b', n: 2 };
    const merged = mergeById(
      [a, b],
      [
        { id: 'b', n: 2 },
        { id: 'c', n: 3 },
      ],
      key
    );
    expect(merged.map((r) => r.id)).toEqual(['b', 'c']);
    expect(merged[0]).toBe(b); // moved, but not rebuilt
  });

  it('key order inside a row does not count as a change', () => {
    expect(rowsAreEqual({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toBe(true);
    expect(rowsAreEqual({ a: 1 }, { a: 2 })).toBe(false);
  });

  it('null and nested arrays compare structurally', () => {
    expect(rowsAreEqual({ a: null, xs: [1, { y: 2 }] }, { a: null, xs: [1, { y: 2 }] })).toBe(true);
    expect(rowsAreEqual({ xs: [1, 2] }, { xs: [2, 1] })).toBe(false);
  });
});

describe('useCoalescedRefresh re-reads on a floor, not on an event', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a burst of events costs ONE refresh, not one per event', () => {
    const refresh = vi.fn();
    const { result } = renderHook(() => useCoalescedRefresh(refresh, { minIntervalMs: 20_000 }));

    act(() => result.current.request()); // first one is immediate
    expect(refresh).toHaveBeenCalledTimes(1);

    // 200 more events inside the window - the storm this hook exists for.
    act(() => {
      for (let i = 0; i < 200; i += 1) result.current.request();
    });
    expect(refresh).toHaveBeenCalledTimes(1);

    act(() => void vi.advanceTimersByTime(20_000));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('the operator never waits: refreshNow is immediate', () => {
    const refresh = vi.fn();
    const { result } = renderHook(() => useCoalescedRefresh(refresh, { minIntervalMs: 20_000 }));
    act(() => result.current.request());
    act(() => result.current.refreshNow());
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('a hidden tab reads nothing at all', () => {
    const refresh = vi.fn();
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const { result } = renderHook(() => useCoalescedRefresh(refresh, { minIntervalMs: 20_000 }));
    act(() => {
      for (let i = 0; i < 50; i += 1) result.current.request();
    });
    act(() => void vi.advanceTimersByTime(120_000));
    expect(refresh).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('and catches up with exactly one read when the tab comes back', () => {
    const refresh = vi.fn();
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const { result } = renderHook(() => useCoalescedRefresh(refresh, { minIntervalMs: 20_000 }));
    act(() => {
      for (let i = 0; i < 50; i += 1) result.current.request();
    });
    spy.mockReturnValue('visible');
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    expect(refresh).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('a timer never fires after unmount', () => {
    const refresh = vi.fn();
    const { result, unmount } = renderHook(() =>
      useCoalescedRefresh(refresh, { minIntervalMs: 20_000 })
    );
    act(() => result.current.request());
    act(() => result.current.request()); // schedules the trailing read
    unmount();
    act(() => void vi.advanceTimersByTime(60_000));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
