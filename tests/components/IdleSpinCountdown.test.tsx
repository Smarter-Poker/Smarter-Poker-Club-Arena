import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, renderHook } from '@testing-library/react';
import { useIdleSpinCountdown } from '../../src/hooks/useIdleSpinCountdown';

const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('one foreground idle spin decision', () => {
  it('fires once after exactly 30 visible seconds and uses the latest callback', () => {
    const first = vi.fn(),
      latest = vi.fn();
    const view = renderHook(({ callback }) => useIdleSpinCountdown(true, true, 'a', callback), {
      initialProps: { callback: first },
    });
    advance(29000);
    expect(view.result.current).toBe(1);
    expect(first).not.toHaveBeenCalled();
    view.rerender({ callback: latest });
    advance(999);
    expect(latest).not.toHaveBeenCalled();
    advance(1);
    expect(latest).toHaveBeenCalledTimes(1);
    expect(view.result.current).toBe(0);
    advance(60000);
    expect(latest).toHaveBeenCalledTimes(1);
  });
  it('pauses hidden time and resumes the remaining fraction', () => {
    const hidden = vi.spyOn(document, 'hidden', 'get'),
      done = vi.fn();
    hidden.mockReturnValue(false);
    renderHook(() => useIdleSpinCountdown(true, true, 'a', done));
    advance(10200);
    hidden.mockReturnValue(true);
    fireEvent(document, new Event('visibilitychange'));
    advance(60000);
    expect(done).not.toHaveBeenCalled();
    hidden.mockReturnValue(false);
    fireEvent(document, new Event('visibilitychange'));
    advance(19799);
    expect(done).not.toHaveBeenCalled();
    advance(1);
    expect(done).toHaveBeenCalledTimes(1);
  });
  it('does not start in a hidden tab', () => {
    const hidden = vi.spyOn(document, 'hidden', 'get'),
      done = vi.fn();
    hidden.mockReturnValue(true);
    renderHook(() => useIdleSpinCountdown(true, true, 'a', done));
    advance(60000);
    expect(done).not.toHaveBeenCalled();
    hidden.mockReturnValue(false);
    fireEvent(document, new Event('visibilitychange'));
    advance(30000);
    expect(done).toHaveBeenCalledTimes(1);
  });
  it('preserves remaining time across readiness pauses without rearming a completed window', () => {
    const done = vi.fn();
    const view = renderHook(({ ready }) => useIdleSpinCountdown(true, ready, 'a', done), {
      initialProps: { ready: true },
    });
    advance(5000);
    view.rerender({ ready: false });
    advance(60000);
    expect(done).not.toHaveBeenCalled();
    view.rerender({ ready: true });
    advance(24999);
    expect(done).not.toHaveBeenCalled();
    advance(1);
    expect(done).toHaveBeenCalledTimes(1);
    view.rerender({ ready: false });
    view.rerender({ ready: true });
    advance(30000);
    expect(done).toHaveBeenCalledTimes(1);
  });
  it('cancels immediately and grants a fresh window only when rearmed', () => {
    const done = vi.fn();
    const view = renderHook(({ armed }) => useIdleSpinCountdown(armed, true, 'a', done), {
      initialProps: { armed: true },
    });
    advance(29999);
    view.rerender({ armed: false });
    advance(60000);
    expect(done).not.toHaveBeenCalled();
    view.rerender({ armed: true });
    expect(view.result.current).toBe(30);
    advance(30000);
    expect(done).toHaveBeenCalledTimes(1);
  });
  it('resets the full window for new choices while ready or paused, and removes timers on unmount', () => {
    const done = vi.fn();
    const view = renderHook(({ ready, key }) => useIdleSpinCountdown(true, ready, key, done), {
      initialProps: { ready: true, key: 'a' },
    });
    advance(10000);
    view.rerender({ ready: true, key: 'b' });
    expect(view.result.current).toBe(30);
    advance(20000);
    expect(done).not.toHaveBeenCalled();
    view.rerender({ ready: false, key: 'c' });
    advance(60000);
    view.rerender({ ready: true, key: 'c' });
    advance(29999);
    expect(done).not.toHaveBeenCalled();
    view.unmount();
    advance(60000);
    expect(done).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
