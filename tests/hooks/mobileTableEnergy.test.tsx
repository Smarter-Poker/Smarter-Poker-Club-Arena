import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTableTimer } from '../../src/hooks/useTableTimer';
import { useTabKeepAlive } from '../../src/hooks/useTabKeepAlive';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('mobile table energy', () => {
  it('opening four tables does not start silent audio or empty worker pings', () => {
    const audio = vi.fn(function () {
      return {
        createOscillator: () => ({ connect() {}, start() {} }),
        createGain: () => ({ gain: {}, connect() {} }),
        destination: {},
        close: () => Promise.resolve(),
      };
    });
    const worker = vi.fn(function () {
      return { terminate() {}, postMessage() {} };
    });
    vi.stubGlobal('AudioContext', audio);
    vi.stubGlobal('Worker', worker);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:energy-test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const tables = Array.from({ length: 4 }, () => renderHook(() => useTabKeepAlive()));
    expect(audio).not.toHaveBeenCalled();
    expect(worker).not.toHaveBeenCalled();
    tables.forEach((table) => table.unmount());
  });

  it('runs a whole-second countdown without asking for display frames', () => {
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame');
    const deadline = Date.now() + 15_250;
    const onTimeout = vi.fn();
    const { result, unmount } = renderHook(() =>
      useTableTimer({
        isActiveTurn: true,
        isHeroTurn: true,
        onTimeout,
        turnDeadlineMs: deadline,
        activeSeatKey: 2,
      })
    );
    expect(result.current.clock.getSnapshot().seconds).toBe(16);
    act(() => vi.advanceTimersByTime(250));
    expect(result.current.clock.getSnapshot().seconds).toBe(15);
    act(() => vi.advanceTimersByTime(15_000));
    expect(result.current.clock.getSnapshot().seconds).toBe(0);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(raf).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    unmount();
  });
  it('re-arms a reset and extension after reaching zero, then releases on unmount', () => {
    const timeout = vi.fn();
    const { result, rerender, unmount } = renderHook((props) => useTableTimer(props), {
      initialProps: {
        isActiveTurn: true,
        isHeroTurn: true,
        onTimeout: timeout,
        turnDeadlineMs: Date.now() + 1000,
        activeSeatKey: 1,
      },
    });
    act(() => vi.advanceTimersByTime(1000));
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    act(() => result.current.resetTimer(20));
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.clock.getSnapshot().seconds).toBe(15);
    act(() => result.current.extendTimer(3));
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.clock.getSnapshot().seconds).toBe(17);
    rerender({
      isActiveTurn: true,
      isHeroTurn: true,
      onTimeout: timeout,
      turnDeadlineMs: Date.now() + 2000,
      activeSeatKey: 2,
    });
    act(() => vi.advanceTimersByTime(2000));
    expect(timeout).toHaveBeenCalledTimes(2);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('derives a delayed resume from the server deadline and never spends twice', () => {
    const timeout = vi.fn();
    const { result, unmount } = renderHook(() =>
      useTableTimer({
        isActiveTurn: true,
        isHeroTurn: true,
        onTimeout: timeout,
        turnDeadlineMs: 20_000,
        activeSeatKey: 2,
      })
    );
    // setSystemTime advances the wall clock without delivering any timers:
    // the same gap as an OS-suspended phone returning after its deadline.
    vi.setSystemTime(25_000);
    act(() => window.dispatchEvent(new Event('pageshow')));
    expect(result.current.clock.getSnapshot().seconds).toBe(0);
    expect(timeout).toHaveBeenCalledTimes(1);
    act(() => window.dispatchEvent(new Event('pageshow')));
    expect(timeout).toHaveBeenCalledTimes(1);
    unmount();
  });
  it('a timeout can synchronously start a time bank without leaving two drivers', () => {
    const onTimeout = vi.fn(() => result.current.resetTimer(20));
    const { result, unmount } = renderHook(() =>
      useTableTimer({
        isActiveTurn: true,
        isHeroTurn: true,
        onTimeout,
        turnDeadlineMs: 11_000,
        activeSeatKey: 1,
      })
    );
    act(() => vi.advanceTimersByTime(1000));
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(result.current.clock.getSnapshot().seconds).toBe(20);
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(2000));
    expect(result.current.clock.getSnapshot().seconds).toBe(18);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
