import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBombPotCountdown } from '../../src/hooks/useBombPotCountdown';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('bomb pot display energy', () => {
  it('sleeps through the quiet window, counts visible seconds and stops at NEXT HAND', () => {
    let renders = 0;
    const { result, unmount } = renderHook(() => {
      renders++;
      return useBombPotCountdown(1_000_000, 3);
    });
    expect(result.current).toBeNull();
    const initialRenders = renders;
    act(() => vi.advanceTimersByTime(896_000));
    expect(renders).toBe(initialRenders);
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe('0:03');
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe('0:02');
    act(() => vi.advanceTimersByTime(2000));
    expect(result.current).toBe('NEXT HAND');
    expect(vi.getTimerCount()).toBe(0);
    const stoppedRenders = renders;
    act(() => vi.advanceTimersByTime(600_000));
    expect(renders).toBe(stoppedRenders);
    unmount();
  });

  it('aligns fractional seconds and re-arms when the engine publishes another deadline', () => {
    const { result, rerender, unmount } = renderHook(
      ({ deadline }) => useBombPotCountdown(deadline),
      { initialProps: { deadline: 161_250 } }
    );
    expect(result.current).toBe('1:02');
    act(() => vi.advanceTimersByTime(250));
    expect(result.current).toBe('1:01');
    act(() => vi.advanceTimersByTime(61_000));
    expect(result.current).toBe('NEXT HAND');
    rerender({ deadline: Date.now() + 120_000 });
    expect(result.current).toBe('2:00');
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('runs no display callbacks while Safari is hidden and reads current time on pageshow', () => {
    const hidden = vi.spyOn(document, 'visibilityState', 'get');
    const { result, unmount } = renderHook(() => useBombPotCountdown(110_000));
    expect(result.current).toBe('0:10');
    hidden.mockReturnValue('hidden');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(vi.getTimerCount()).toBe(0);
    vi.setSystemTime(120_000);
    hidden.mockReturnValue('visible');
    act(() => window.dispatchEvent(new Event('pageshow')));
    expect(result.current).toBe('NEXT HAND');
    expect(vi.getTimerCount()).toBe(0);
    unmount();
  });

  it('starts no timer without a deadline or while a higher priority bomb status is displayed', () => {
    const { result, rerender, unmount } = renderHook(
      ({ deadline, enabled }) => useBombPotCountdown(deadline, 0, enabled),
      { initialProps: { deadline: undefined as number | undefined, enabled: true } }
    );
    expect(result.current).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    rerender({ deadline: 120_000, enabled: false });
    expect(result.current).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    rerender({ deadline: 120_000, enabled: true });
    expect(result.current).toBe('0:20');
    rerender({ deadline: undefined, enabled: true });
    expect(result.current).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    unmount();
  });

  it('keeps an inactive table asleep and catches up when selected again', () => {
    const { result, rerender, unmount } = renderHook(
      ({ active }) => useBombPotCountdown(110_000, 0, active),
      { initialProps: { active: false } }
    );
    expect(result.current).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(20_000));
    rerender({ active: true });
    expect(result.current).toBe('NEXT HAND');
    expect(vi.getTimerCount()).toBe(0);
    unmount();
  });
});
