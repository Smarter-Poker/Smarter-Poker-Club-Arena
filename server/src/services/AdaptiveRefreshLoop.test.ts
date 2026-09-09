import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAdaptiveRefreshLoop } from './AdaptiveRefreshLoop.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('createAdaptiveRefreshLoop', () => {
  it('retries a failed boot load promptly and returns to the slow cadence after success', async () => {
    vi.useFakeTimers();
    const load = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, count: 0 })
      .mockResolvedValueOnce({ ok: true, count: 240 });
    const loop = createAdaptiveRefreshLoop({
      load,
      refreshMs: 60 * 60_000,
      retryMs: 30_000,
      maxRetryMs: 5 * 60_000,
    });

    await expect(loop.runNow()).resolves.toEqual({ ok: false, count: 0 });
    loop.start();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(load).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(10 * 30_000);
    expect(load).toHaveBeenCalledTimes(2);
    loop.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not overlap a slow recovery attempt', async () => {
    vi.useFakeTimers();
    let finish: ((result: { ok: boolean }) => void) | undefined;
    const load = vi.fn(
      () =>
        new Promise<{ ok: boolean }>((resolve) => {
          finish = resolve;
        })
    );
    const loop = createAdaptiveRefreshLoop({
      load,
      refreshMs: 60_000,
      retryMs: 10_000,
      maxRetryMs: 30_000,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(load).toHaveBeenCalledTimes(1);

    finish?.({ ok: true });
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(50_000);
    expect(load).toHaveBeenCalledTimes(1);
    loop.stop();
  });

  it('backs off repeated failures without waiting for the normal refresh period', async () => {
    vi.useFakeTimers();
    const load = vi
      .fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });
    const loop = createAdaptiveRefreshLoop({
      load,
      refreshMs: 60 * 60_000,
      retryMs: 30_000,
      maxRetryMs: 5 * 60_000,
    });

    await loop.runNow();
    loop.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(load).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(load).toHaveBeenCalledTimes(3);
    loop.stop();
  });

  it('deduplicates concurrent direct loads and retries rejected attempts', async () => {
    vi.useFakeTimers();
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('PGRST002'))
      .mockResolvedValueOnce({ ok: true });
    const loop = createAdaptiveRefreshLoop({
      load,
      refreshMs: 60_000,
      retryMs: 10_000,
      maxRetryMs: 30_000,
    });

    const first = loop.runNow();
    const duplicate = loop.runNow();
    expect(first).toBe(duplicate);
    await expect(first).rejects.toThrow('PGRST002');

    loop.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(load).toHaveBeenCalledTimes(2);
    loop.stop();
  });

  it('rejects invalid timing contracts', () => {
    const load = async () => ({ ok: true });
    expect(() =>
      createAdaptiveRefreshLoop({ load, refreshMs: 0, retryMs: 1, maxRetryMs: 1 })
    ).toThrow('adaptive_refresh_invalid_refresh_ms');
    expect(() =>
      createAdaptiveRefreshLoop({
        load,
        refreshMs: 1_000,
        retryMs: 2_000,
        maxRetryMs: 2_000,
      })
    ).toThrow('adaptive_refresh_invalid_retry_ms');
    expect(() =>
      createAdaptiveRefreshLoop({
        load,
        refreshMs: 10_000,
        retryMs: 1_000,
        maxRetryMs: 500,
      })
    ).toThrow('adaptive_refresh_invalid_max_retry_ms');
  });
});
