/**
 * useMasterBusSubscriptions — the grouped form must share ONE debounce window.
 *
 * It previously called masterBus.subscribeDebounced once per event type, and
 * that allocates a fresh timer key per call, so N events meant N independent
 * timers rather than the single coalescing window the hook documents.
 *
 * Real cost: CashierPage.notifyWalletChange emits WALLET_REFRESHED and
 * BALANCE_UPDATED (both bypass fingerprint dedup) and DynamicWallet listens for
 * both in one grouped subscription — so one chip send ran a full wallet
 * refetch twice, 8 Supabase round trips. A distribute made it three.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const handlers = new Map<string, ((e: { payload: unknown }) => void)[]>();
const subscribeDebouncedSpy = vi.fn();

vi.mock('@/core/MasterBus', () => ({
  masterBus: {
    subscribe: (evt: string, h: (e: { payload: unknown }) => void) => {
      const list = handlers.get(evt) ?? [];
      list.push(h);
      handlers.set(evt, list);
      return () => {
        const l = (handlers.get(evt) ?? []).filter((x) => x !== h);
        handlers.set(evt, l);
      };
    },
    subscribeDebounced: (...args: unknown[]) => {
      subscribeDebouncedSpy(...args);
      return () => {};
    },
  },
}));

import { useMasterBusSubscriptions } from '@/hooks/useMasterBusSubscription';

const emit = (evt: string, payload: unknown = {}) =>
  (handlers.get(evt) ?? []).forEach((h) => h({ payload }));

beforeEach(() => {
  handlers.clear();
  subscribeDebouncedSpy.mockReset();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('useMasterBusSubscriptions — grouped debounce', () => {
  it('coalesces two different events in the window into ONE handler call', () => {
    const handler = vi.fn();
    renderHook(() => useMasterBusSubscriptions(['A', 'B'] as never, handler, { debounce: 500 }));

    emit('A');
    emit('B');
    expect(handler).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    // One window, one call — previously this was two (one timer per event type)
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not use the per-event subscribeDebounced any more', () => {
    renderHook(() => useMasterBusSubscriptions(['A', 'B'] as never, vi.fn(), { debounce: 500 }));
    expect(subscribeDebouncedSpy).not.toHaveBeenCalled();
  });

  it('passes the LAST payload through', () => {
    const handler = vi.fn();
    renderHook(() => useMasterBusSubscriptions(['A', 'B'] as never, handler, { debounce: 300 }));
    emit('A', { n: 1 });
    emit('B', { n: 2 });
    vi.advanceTimersByTime(300);
    expect(handler).toHaveBeenCalledWith({ n: 2 });
  });

  it('fires per-event immediately when no debounce is configured', () => {
    const handler = vi.fn();
    renderHook(() => useMasterBusSubscriptions(['A', 'B'] as never, handler));
    emit('A');
    emit('B');
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('drops a pending call if the component unmounts first', () => {
    const handler = vi.fn();
    const { unmount } = renderHook(() =>
      useMasterBusSubscriptions(['A'] as never, handler, { debounce: 500 })
    );
    emit('A');
    unmount();
    vi.advanceTimersByTime(500);
    expect(handler).not.toHaveBeenCalled();
  });
});
