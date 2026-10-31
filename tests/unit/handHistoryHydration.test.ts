import { describe, expect, it, vi } from 'vitest';
import { startHandHistoryHydration } from '@/lib/handHistoryHydration';
import { shouldRefetchHandHistory, type HandHistoryLoadState } from '@/lib/handHistoryLive';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('Previous Hand hydration ownership', () => {
  it('can reopen after closing during a slow first load, without accepting the old response', async () => {
    const first = deferred<string[]>();
    const second = deferred<string[]>();
    let state: HandHistoryLoadState = 'idle';
    const commit = vi.fn();
    const onError = vi.fn();
    const setState = (next: HandHistoryLoadState) => {
      state = next;
    };
    const close = startHandHistoryHydration({
      load: () => first.promise,
      commit,
      setState,
      onError,
    });
    expect(state).toBe('loading');
    close();
    expect(
      shouldRefetchHandHistory({
        state,
        fetchedAt: null,
        fetchedTableId: null,
        tableId: 't1',
        now: 1,
      })
    ).toBe(true);
    const closeAgain = startHandHistoryHydration({
      load: () => second.promise,
      commit,
      setState,
      onError,
    });
    first.resolve(['cancelled']);
    await first.promise;
    expect(commit).not.toHaveBeenCalled();
    expect(state).toBe('loading');
    second.resolve(['current']);
    await second.promise;
    expect(commit).toHaveBeenCalledExactlyOnceWith(['current']);
    expect(state).toBe('ready');
    closeAgain();
    expect(state).toBe('ready');
    expect(onError).not.toHaveBeenCalled();
  });

  it('releases a cancelled read immediately and ignores its eventual error', async () => {
    const read = deferred<string[]>();
    const setState = vi.fn();
    const onError = vi.fn();
    const commit = vi.fn();
    const close = startHandHistoryHydration({
      load: () => read.promise,
      commit,
      setState,
      onError,
    });
    close();
    close();
    expect(setState.mock.calls).toEqual([['loading'], ['idle']]);
    read.reject(new Error('Old Table Read Failed'));
    await read.promise.catch(() => undefined);
    expect(onError).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('reports read failures as failed and allows the next open to retry', async () => {
    const read = deferred<string[]>();
    let state: HandHistoryLoadState = 'idle';
    const onError = vi.fn();
    const close = startHandHistoryHydration({
      load: () => read.promise,
      commit: vi.fn(),
      setState: (next) => {
        state = next;
      },
      onError,
    });
    const error = new Error('History Unavailable');
    read.reject(error);
    await read.promise.catch(() => undefined);
    expect(state).toBe('failed');
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    close();
    expect(state).toBe('failed');
    expect(
      shouldRefetchHandHistory({
        state,
        fetchedAt: null,
        fetchedTableId: null,
        tableId: 't1',
        now: 1,
      })
    ).toBe(true);
  });

  it('marks the committed list ready before applying saved events', async () => {
    const order: string[] = [];
    startHandHistoryHydration({
      load: async () => [],
      commit: () => {
        order.push('commit');
      },
      setState: (state) => {
        order.push(state);
      },
      onReady: () => {
        order.push('saved');
      },
      onError: vi.fn(),
    });
    await Promise.resolve();
    expect(order).toEqual(['loading', 'commit', 'ready', 'saved']);
  });
});
