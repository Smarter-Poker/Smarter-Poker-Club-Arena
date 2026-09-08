import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { readDeployedShell, SHELL_READ_TIMEOUT_MS } from '../../src/lib/readDeployedShell';
import { useShellUpdateGate } from '../../src/hooks/useShellUpdateGate';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Home Screen shell recovery', () => {
  it('releases a hung request and allows the next read to succeed', async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce({ ok: true, text: async () => 'new shell' });
    vi.stubGlobal('fetch', fetcher);
    const pending = readDeployedShell('/index.html');
    await vi.advanceTimersByTimeAsync(SHELL_READ_TIMEOUT_MS);
    expect(await pending).toBeNull();
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    expect(await readDeployedShell('/index.html')).toBe('new shell');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a stalled body, including when the fetch implementation ignores abort', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, text: () => new Promise(() => {}) })
    );
    const pending = readDeployedShell('/index.html');
    await vi.advanceTimersByTimeAsync(SHELL_READ_TIMEOUT_MS);
    expect(await pending).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not treat an HTTP error document as a deployed shell', async () => {
    const text = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, text }));
    expect(await readDeployedShell('/index.html')).toBeNull();
    expect(text).not.toHaveBeenCalled();
  });

  it('checks at mount even if pageshow already fired, and throttles an immediate resume', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T14:00:00Z'));
    const sw = new EventTarget();
    Object.assign(sw, { getRegistration: vi.fn().mockResolvedValue(undefined) });
    vi.stubGlobal('navigator', { serviceWorker: sw });
    const entry = document.createElement('script');
    entry.type = 'application/json';
    entry.src = '/assets/index-current-v6.js';
    document.head.append(entry);
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '<script src="/assets/index-current-v6.js"></script>',
    });
    vi.stubGlobal('fetch', fetcher);
    const hook = renderHook(() => useShellUpdateGate());
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher).toHaveBeenCalledTimes(1);
      window.dispatchEvent(new Event('pageshow'));
      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      hook.unmount();
      entry.remove();
    }
    expect(vi.getTimerCount()).toBe(0);
  });
  it('releases the service-worker verification latch after a hung check', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T14:00:00Z'));
    const sw = new EventTarget();
    Object.assign(sw, { getRegistration: vi.fn().mockResolvedValue(undefined) });
    vi.stubGlobal('navigator', { serviceWorker: sw });
    const entry = document.createElement('script');
    entry.type = 'application/json';
    entry.src = '/assets/index-current-v6.js';
    document.head.append(entry);
    const current = {
      ok: true,
      text: async () => '<script src="/assets/index-current-v6.js"></script>',
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(current)
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue(current);
    vi.stubGlobal('fetch', fetcher);
    const hook = renderHook(() => useShellUpdateGate());
    try {
      await vi.advanceTimersByTimeAsync(0);
      sw.dispatchEvent(new MessageEvent('message', { data: { type: 'SHELL_UPDATED' } }));
      await vi.advanceTimersByTimeAsync(SHELL_READ_TIMEOUT_MS);
      sw.dispatchEvent(new MessageEvent('message', { data: { type: 'SHELL_UPDATED' } }));
      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher).toHaveBeenCalledTimes(3);
    } finally {
      hook.unmount();
      entry.remove();
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
