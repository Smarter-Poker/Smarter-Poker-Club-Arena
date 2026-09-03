/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  useAnimationQueue — no celebration is ever skipped
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The bug this exists for: a three-way all-in busts TWO players. The engine
 * processes eliminations one at a time, so it broadcasts `bounty_collected`
 * twice, milliseconds apart. Both landed in a single useState and the second
 * overwrote the first — two heads taken, one celebration shown.
 *
 * Same "superseded in its own tick" class as the seven engine-side pacing
 * fixes, relocated into React state.
 */

import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useAnimationQueue } from '../../src/hooks/useAnimationQueue';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('useAnimationQueue', () => {
  it('starts idle', () => {
    const { result } = renderHook(() => useAnimationQueue<string>());
    expect(result.current.current).toBeNull();
    expect(result.current.pending).toBe(0);
  });

  it('shows the first item immediately', () => {
    const { result } = renderHook(() => useAnimationQueue<string>());
    act(() => result.current.enqueue('ko-1'));
    expect(result.current.current).toBe('ko-1');
    expect(result.current.pending).toBe(0);
  });

  it('THE REGRESSION: a second item in the same tick does not replace the first', () => {
    const { result } = renderHook(() => useAnimationQueue<string>());
    act(() => {
      // Both broadcasts land before React re-renders — the exact race.
      result.current.enqueue('ko-1');
      result.current.enqueue('ko-2');
    });
    expect(result.current.current).toBe('ko-1');
    expect(result.current.pending).toBe(1);
  });

  it('advances to the next only when the current one finishes', () => {
    const { result } = renderHook(() => useAnimationQueue<string>());
    act(() => {
      result.current.enqueue('ko-1');
      result.current.enqueue('ko-2');
    });
    act(() => {
      result.current.complete();
      vi.advanceTimersByTime(1);
    });
    expect(result.current.current).toBe('ko-2');
    expect(result.current.pending).toBe(0);
  });

  it('clears between items so the next replays from the top', () => {
    const { result } = renderHook(() => useAnimationQueue<string>());
    act(() => {
      result.current.enqueue('ko-1');
      result.current.enqueue('ko-2');
    });
    // Without the null gap a component keyed on identity would treat the two
    // as one continuous item and never restart its entrance animation.
    act(() => result.current.complete());
    expect(result.current.current).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.current).toBe('ko-2');
  });

  it('returns to idle after the last item', () => {
    const { result } = renderHook(() => useAnimationQueue<string>());
    act(() => result.current.enqueue('only'));
    act(() => result.current.complete());
    expect(result.current.current).toBeNull();
    expect(result.current.pending).toBe(0);
  });

  it('handles a full table busting at once, in order, losing none', () => {
    const { result } = renderHook(() => useAnimationQueue<string>());
    const all = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    act(() => all.forEach((x) => result.current.enqueue(x)));

    const seen: string[] = [];
    for (let i = 0; i < all.length; i++) {
      expect(result.current.current).not.toBeNull();
      seen.push(result.current.current as string);
      act(() => {
        result.current.complete();
        vi.advanceTimersByTime(1);
      });
    }
    expect(seen).toEqual(all);
    expect(result.current.current).toBeNull();
  });

  it('accepts new items while one is already playing', () => {
    const { result } = renderHook(() => useAnimationQueue<string>());
    act(() => result.current.enqueue('first'));
    act(() => result.current.enqueue('late-arrival'));
    expect(result.current.current).toBe('first');
    expect(result.current.pending).toBe(1);
    act(() => {
      result.current.complete();
      vi.advanceTimersByTime(1);
    });
    expect(result.current.current).toBe('late-arrival');
  });

  it('completing while idle is a no-op, not a crash', () => {
    const { result } = renderHook(() => useAnimationQueue<string>());
    expect(() => act(() => result.current.complete())).not.toThrow();
    expect(result.current.current).toBeNull();
  });

  it('can be reused after draining', () => {
    const { result } = renderHook(() => useAnimationQueue<string>());
    act(() => result.current.enqueue('round-1'));
    act(() => result.current.complete());
    expect(result.current.current).toBeNull();
    act(() => result.current.enqueue('round-2'));
    expect(result.current.current).toBe('round-2');
  });
});
