import { StrictMode, useEffect } from 'react';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCashierHistory } from '../src/hooks/useCashierHistory';
import { reportError } from '../src/utils/errorReporter';

vi.mock('../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
const row = (id: string) => ({
  id,
  created_at: '2026-09-09T07:00:00Z',
  amount: 5,
  type: 'credit',
  wallet_type: 'PLAYER',
  category: 'transfer',
  description: id,
});
const cacheKey = (user = 'player-a', club = 'club-a') =>
  `cashier_tx_cache_v2_${JSON.stringify([user, club])}`;
function deferred() {
  let resolve!: (value: ReturnType<typeof row>[]) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<ReturnType<typeof row>[]>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = () =>
  act(async () => {
    await Promise.resolve();
  });

describe('Cashier history request ownership', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
  });

  it('coalesces ordinary duplicate reads', async () => {
    const gate = deferred();
    const read = vi.fn(() => gate.promise);
    const { result } = renderHook(() =>
      useCashierHistory({ userId: 'player-a', clubId: 'club-a', read })
    );
    let first!: Promise<void>;
    act(() => {
      first = result.current.load();
      expect(result.current.load()).toBe(first);
    });
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => {
      gate.resolve([row('fresh')]);
      await first;
    });
    expect(result.current.transactions).toEqual([row('fresh')]);
    expect(result.current.loading).toBe(false);
  });

  it('retains invalidations during both the first and trailing reads without applying obsolete snapshots', async () => {
    const gates = [deferred(), deferred(), deferred()];
    const read = vi
      .fn()
      .mockImplementationOnce(() => gates[0].promise)
      .mockImplementationOnce(() => gates[1].promise)
      .mockImplementationOnce(() => gates[2].promise);
    const { result } = renderHook(() =>
      useCashierHistory({ userId: 'player-a', clubId: 'club-a', read })
    );
    let loaded!: Promise<void>;
    act(() => {
      loaded = result.current.load();
    });
    await flush();
    act(() => {
      for (let i = 0; i < 10; i++) result.current.load({ force: true });
    });
    await act(async () => {
      gates[0].resolve([row('obsolete-1')]);
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.current.transactions).toEqual([]);
    expect(sessionStorage.getItem(cacheKey())).toBeNull();
    act(() => {
      result.current.load({ force: true });
    });
    await act(async () => {
      gates[1].resolve([row('obsolete-2')]);
    });
    expect(read).toHaveBeenCalledTimes(3);
    expect(result.current.transactions).toEqual([]);
    await act(async () => {
      gates[2].resolve([row('current')]);
      await loaded;
    });
    expect(result.current.transactions).toEqual([row('current')]);
    expect(result.current.loading).toBe(false);
  });

  it.each(['club', 'account'])(
    'retires old responses and starts the new %s read immediately',
    async (kind) => {
      const a = deferred();
      const b = deferred();
      const readA = vi.fn(() => a.promise);
      const readB = vi.fn(() => b.promise);
      const { result, rerender } = renderHook((props) => useCashierHistory(props), {
        initialProps: { userId: 'player-a', clubId: 'club-a', read: readA },
      });
      act(() => {
        result.current.load();
        result.current.load({ force: true });
      });
      await flush();
      const retiredLoad = result.current.load;
      rerender({
        userId: kind === 'account' ? 'player-b' : 'player-a',
        clubId: kind === 'club' ? 'club-b' : 'club-a',
        read: readB,
      });
      expect(result.current.transactions).toEqual([]);
      act(() => {
        result.current.load();
      });
      await flush();
      expect(readB).toHaveBeenCalledTimes(1);
      await act(async () => {
        a.resolve([row('retired')]);
        await retiredLoad({ force: true });
      });
      expect(result.current.transactions).toEqual([]);
      expect(result.current.loading).toBe(true);
      expect(sessionStorage.getItem(cacheKey())).toBeNull();
      expect(readA).toHaveBeenCalledTimes(1);
      await act(async () => {
        b.resolve([row('new-scope')]);
      });
      expect(result.current.transactions).toEqual([row('new-scope')]);
    }
  );

  it('does not revive an old request when returning to the same club', async () => {
    const first = deferred();
    const latest = deferred();
    const read = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => latest.promise);
    const { result, rerender } = renderHook(
      ({ clubId }) => useCashierHistory({ userId: 'player-a', clubId, read }),
      { initialProps: { clubId: 'club-a' } }
    );
    act(() => {
      result.current.load();
    });
    await flush();
    const retired = result.current.load;
    rerender({ clubId: 'club-b' });
    rerender({ clubId: 'club-a' });
    act(() => {
      result.current.load();
    });
    await flush();
    await act(async () => {
      first.resolve([row('old-a')]);
      await retired();
    });
    expect(result.current.transactions).toEqual([]);
    await act(async () => {
      latest.resolve([row('new-a')]);
    });
    expect(result.current.transactions).toEqual([row('new-a')]);
  });

  it('retires queued work and cache writes on unmount', async () => {
    const gate = deferred();
    const read = vi.fn(() => gate.promise);
    const { result, unmount } = renderHook(() =>
      useCashierHistory({ userId: 'player-a', clubId: 'club-a', read })
    );
    act(() => {
      result.current.load();
      result.current.load({ force: true });
    });
    await flush();
    unmount();
    await act(async () => {
      gate.resolve([row('retired')]);
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(cacheKey())).toBeNull();
  });

  it('works through StrictMode effect cleanup and setup', async () => {
    const read = vi.fn().mockResolvedValue([row('fresh')]);
    const { result } = renderHook(
      () => useCashierHistory({ userId: 'player-a', clubId: 'club-a', read }),
      { wrapper: StrictMode }
    );
    await act(async () => {
      await result.current.load();
    });
    expect(result.current.transactions).toEqual([row('fresh')]);
    expect(result.current.loading).toBe(false);
  });

  it('preserves known rows and cache on failure, then clears the error on successful retry', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce([row('known')])
      .mockRejectedValueOnce(new Error('read refused'))
      .mockResolvedValueOnce([]);
    const { result } = renderHook(() =>
      useCashierHistory({ userId: 'player-a', clubId: 'club-a', read })
    );
    await act(async () => {
      await result.current.load();
    });
    const cached = sessionStorage.getItem(cacheKey());
    await act(async () => {
      await result.current.load({ force: true });
    });
    expect(result.current.transactions).toEqual([row('known')]);
    expect(result.current.error).toMatch(/Could Not Be Refreshed/);
    expect(sessionStorage.getItem(cacheKey())).toBe(cached);
    expect(reportError).toHaveBeenCalled();
    await act(async () => {
      await result.current.load({ force: true });
    });
    expect(result.current.transactions).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('keeps the last confirmed rows visible during an active refresh', async () => {
    const gate = deferred();
    const read = vi
      .fn()
      .mockResolvedValueOnce([row('known')])
      .mockImplementationOnce(() => gate.promise);
    const { result } = renderHook(() =>
      useCashierHistory({ userId: 'player-a', clubId: 'club-a', read })
    );
    await act(async () => {
      await result.current.load();
    });
    act(() => {
      result.current.load({ force: true });
    });
    await flush();
    expect(result.current.loading).toBe(true);
    expect(result.current.transactions).toEqual([row('known')]);
    await act(async () => {
      gate.resolve([row('new')]);
    });
  });

  it('loads only the cache for the current user and club', () => {
    const put = (clubId: string) =>
      sessionStorage.setItem(
        cacheKey('player-a', clubId),
        JSON.stringify({ userId: 'player-a', clubId, data: [row(clubId)], cachedAt: Date.now() })
      );
    put('club-a');
    put('club-b');
    const { result, rerender } = renderHook(
      ({ clubId }) => useCashierHistory({ userId: 'player-a', clubId, read: vi.fn() }),
      { initialProps: { clubId: 'club-a' } }
    );
    expect(result.current.transactions).toEqual([row('club-a')]);
    rerender({ clubId: 'club-b' });
    expect(result.current.transactions).toEqual([row('club-b')]);
  });

  it.each(['legacy', 'expired', 'future', 'wrong-scope', 'malformed'])(
    'ignores a %s cache',
    (kind) => {
      const cached = {
        userId: 'player-a',
        clubId: kind === 'wrong-scope' ? 'club-b' : 'club-a',
        data: [row('untrusted')],
        cachedAt: Date.now() + (kind === 'future' ? 10000 : kind === 'expired' ? -300001 : 0),
      };
      sessionStorage.setItem(
        kind === 'legacy' ? 'cashier_tx_cache_player-a' : cacheKey(),
        kind === 'malformed' ? '{' : JSON.stringify(cached)
      );
      const { result } = renderHook(() =>
        useCashierHistory({ userId: 'player-a', clubId: 'club-a', read: vi.fn() })
      );
      expect(result.current.transactions).toEqual([]);
    }
  );

  it('does not read when signed out or missing a club', async () => {
    const read = vi.fn();
    const { result, rerender } = renderHook((props) => useCashierHistory({ ...props, read }), {
      initialProps: { userId: undefined as string | undefined, clubId: 'club-a' as string | null },
    });
    await act(async () => {
      await result.current.load();
    });
    rerender({ userId: 'player-a', clubId: null });
    await act(async () => {
      await result.current.load();
    });
    expect(read).not.toHaveBeenCalled();
  });
  it('retires the first StrictMode effect request before the remounted request runs', async () => {
    const read = vi.fn().mockResolvedValue([row('current-effect')]);
    const { result } = renderHook(
      () => {
        const history = useCashierHistory({ userId: 'player-a', clubId: 'club-a', read });
        useEffect(() => {
          history.load();
        }, [history.load]);
        return history;
      },
      { wrapper: StrictMode }
    );
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.current.transactions).toEqual([row('current-effect')]);
  });

  it('does not let storage failures turn a successful read into a failed history', async () => {
    const read = vi.fn().mockResolvedValue([row('fresh')]);
    const storage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')!;
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => {
          throw new Error('storage full');
        },
      },
    });
    try {
      const { result } = renderHook(() =>
        useCashierHistory({ userId: 'player-a', clubId: 'club-a', read })
      );
      await act(async () => {
        await result.current.load();
      });
      expect(result.current.transactions).toEqual([row('fresh')]);
      expect(result.current.error).toBeNull();
      expect(reportError).toHaveBeenCalled();
    } finally {
      Object.defineProperty(globalThis, 'sessionStorage', storage);
    }
  });

  it('ignores malformed cached row fields before rendering them', () => {
    sessionStorage.setItem(
      cacheKey(),
      JSON.stringify({
        userId: 'player-a',
        clubId: 'club-a',
        cachedAt: Date.now(),
        data: [{ ...row('malformed'), category: { unexpected: true } }],
      })
    );
    const { result } = renderHook(() =>
      useCashierHistory({ userId: 'player-a', clubId: 'club-a', read: vi.fn() })
    );
    expect(result.current.transactions).toEqual([]);
  });

  it('retains a queued refresh after a failed read', async () => {
    const gate = deferred();
    const read = vi
      .fn()
      .mockImplementationOnce(() => gate.promise)
      .mockResolvedValueOnce([row('recovered')]);
    const { result } = renderHook(() =>
      useCashierHistory({ userId: 'player-a', clubId: 'club-a', read })
    );
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.load();
    });
    await flush();
    act(() => {
      result.current.load({ force: true });
    });
    await act(async () => {
      gate.reject(new Error('connection lost'));
      await pending;
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.current.transactions).toEqual([row('recovered')]);
    expect(result.current.error).toBeNull();
  });
});
