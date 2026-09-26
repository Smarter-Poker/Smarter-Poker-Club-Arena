import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVisibleRead } from '../../src/hooks/useVisibleRead';

describe('visible authoritative reads', () => {
  let visibility: string;
  let online: boolean;
  beforeEach(() => {
    vi.useFakeTimers();
    visibility = 'visible';
    online = true;
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(
      () => visibility as DocumentVisibilityState
    );
    vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  const settle = () =>
    act(async () => {
      await Promise.resolve();
    });

  it('reads another session’s changed balance while the view stays open', async () => {
    const read = vi.fn().mockResolvedValueOnce(100).mockResolvedValue(70);
    const onData = vi.fn();
    const hook = renderHook(() =>
      useVisibleRead({ scopeKey: 'club-a:user-a', enabled: true, read, onData, onError: vi.fn() })
    );
    await settle();
    expect(onData).toHaveBeenLastCalledWith(100, 'initial');
    await act(() => vi.advanceTimersByTimeAsync(8_000));
    expect(onData).toHaveBeenLastCalledWith(70, 'interval');
    expect(read).toHaveBeenCalledTimes(2);
    hook.unmount();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('costs no reads while hidden, offline or closed, and refreshes on return', async () => {
    const read = vi.fn().mockResolvedValue(100);
    visibility = 'hidden';
    const hook = renderHook(
      ({ enabled }) =>
        useVisibleRead({ scopeKey: 'a', enabled, read, onData: vi.fn(), onError: vi.fn() }),
      { initialProps: { enabled: true } }
    );
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(read).not.toHaveBeenCalled();
    visibility = 'visible';
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await settle();
    expect(read).toHaveBeenCalledOnce();
    online = false;
    act(() => window.dispatchEvent(new Event('offline')));
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(read).toHaveBeenCalledOnce();
    online = true;
    act(() => window.dispatchEvent(new Event('online')));
    await settle();
    expect(read).toHaveBeenCalledTimes(2);
    hook.rerender({ enabled: false });
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('never overlaps reads and coalesces completed-command refresh requests', async () => {
    let resolve!: (value: number) => void;
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<number>((r) => {
            resolve = r;
          })
      )
      .mockResolvedValue(80);
    const hook = renderHook(() =>
      useVisibleRead({ scopeKey: 'a', enabled: true, read, onData: vi.fn(), onError: vi.fn() })
    );
    act(() => {
      hook.result.current();
      hook.result.current();
      hook.result.current();
    });
    await act(() => vi.advanceTimersByTimeAsync(8_000));
    expect(read).toHaveBeenCalledOnce();
    await act(async () => resolve(100));
    expect(read).toHaveBeenCalledTimes(2);
    hook.unmount();
  });

  it('aborts the old scope and discards its late reply after a club or user switch', async () => {
    let resolve!: (value: number) => void;
    let oldSignal!: AbortSignal;
    const read = vi
      .fn()
      .mockImplementationOnce((signal) => {
        oldSignal = signal;
        return new Promise<number>((r) => {
          resolve = r;
        });
      })
      .mockResolvedValue(20);
    const onData = vi.fn();
    const hook = renderHook(
      ({ scope }) =>
        useVisibleRead({ scopeKey: scope, enabled: true, read, onData, onError: vi.fn() }),
      { initialProps: { scope: 'club-a:user-a' } }
    );
    hook.rerender({ scope: 'club-b:user-b' });
    await settle();
    expect(oldSignal.aborted).toBe(true);
    expect(onData).toHaveBeenLastCalledWith(20, 'initial');
    await act(async () => resolve(100));
    expect(onData).toHaveBeenCalledOnce();
    hook.unmount();
  });

  it('reports failure without inventing data or immediately retrying', async () => {
    const failure = new Error('RLS refused');
    const read = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(25);
    const onData = vi.fn(),
      onError = vi.fn();
    const hook = renderHook(() =>
      useVisibleRead({ scopeKey: 'a', enabled: true, read, onData, onError })
    );
    await settle();
    expect(onError).toHaveBeenCalledWith(failure);
    expect(onData).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(7_999));
    expect(read).toHaveBeenCalledOnce();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(onData).toHaveBeenLastCalledWith(25, 'interval');
    hook.unmount();
  });
});
