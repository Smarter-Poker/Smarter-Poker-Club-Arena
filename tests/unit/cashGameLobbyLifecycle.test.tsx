import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ rpc: vi.fn(), viewer: 'player-a' as string | null }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: state.rpc } }));
vi.mock('../../src/stores/useUserStore', () => ({
  useUserStore: (select: (value: { user: { id: string } | null }) => unknown) =>
    select({ user: state.viewer ? { id: state.viewer } : null }),
}));
import { useCashGameLobby } from '../../src/components/table/useCashGameLobby';

const snapshot = (gameId = 'game', owner = 'player-a') => ({
  game: { id: gameId },
  tables: [],
  must_move_list: [],
  me: { user_id: owner },
});
type RpcReply = { data: unknown; error: unknown };
const response = (data: unknown): RpcReply => ({ data, error: null });
function deferred() {
  let resolve!: (value: ReturnType<typeof response>) => void;
  const promise = new Promise<ReturnType<typeof response>>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  state.viewer = 'player-a';
});
afterEach(() => vi.useRealTimers());

describe('lobby observations belong to one viewer and one opening', () => {
  it('clears a completed snapshot on reopening and does not retain it after a failed new read', async () => {
    const next = deferred();
    state.rpc.mockResolvedValueOnce(response(snapshot())).mockReturnValue(next.promise);
    const { result, rerender } = renderHook(({ open }) => useCashGameLobby('game', open, 5000), {
      initialProps: { open: true },
    });
    await flush();
    expect(result.current.lobby).not.toBeNull();
    rerender({ open: false });
    rerender({ open: true });
    expect(result.current.lobby).toBeNull();
    await act(async () =>
      next.resolve({ data: null, error: { message: 'temporarily unavailable' } })
    );
    expect(result.current.lobby).toBeNull();
    expect(result.current.error).not.toBeNull();
  });

  it('cannot resurrect game A when A is reopened before the intervening game B read completes', async () => {
    const pending = deferred();
    state.rpc.mockResolvedValueOnce(response(snapshot())).mockReturnValue(pending.promise);
    const { result, rerender } = renderHook(({ game }) => useCashGameLobby(game, true, 5000), {
      initialProps: { game: 'game' },
    });
    await flush();
    rerender({ game: 'other' });
    rerender({ game: 'game' });
    expect(result.current.lobby).toBeNull();
  });

  it.each(['player-b', null])(
    'withdraws the old viewer and action when identity becomes %s',
    async (viewer) => {
      const next = deferred();
      state.rpc.mockResolvedValueOnce(response(snapshot())).mockReturnValue(next.promise);
      const { result, rerender } = renderHook(() => useCashGameLobby('game', true, 5000));
      await flush();
      let action: ReturnType<typeof result.current.beginAction> = null;
      act(() => {
        action = result.current.beginAction();
      });
      expect(action!.isCurrent()).toBe(true);
      state.viewer = viewer;
      rerender();
      expect(result.current.lobby).toBeNull();
      expect(action!.isCurrent()).toBe(false);
      expect(result.current.busy).toBe(false);
      expect(state.rpc).toHaveBeenCalledTimes(2);
    }
  );

  it('ignores an old viewer read that arrives after the next viewer snapshot', async () => {
    const old = deferred();
    state.rpc
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue(response(snapshot('game', 'player-b')));
    const { result, rerender } = renderHook(() => useCashGameLobby('game', true, 5000));
    state.viewer = 'player-b';
    rerender();
    await flush();
    await act(async () => old.resolve(response(snapshot())));
    expect(result.current.lobby?.me?.user_id).toBe('player-b');
  });

  it('retains the current opening snapshot after an ordinary refresh error', async () => {
    const data = snapshot();
    state.rpc
      .mockResolvedValueOnce(response(data))
      .mockResolvedValue({ data: null, error: { message: 'offline' } });
    const { result } = renderHook(() => useCashGameLobby('game', true, 5000));
    await flush();
    await act(async () => {
      await result.current.load();
    });
    expect(result.current.lobby).toBe(data);
    expect(result.current.error).toEqual({ message: 'offline' });
  });

  it('lets a valid slow read finish instead of starving it with overlapping polls', async () => {
    state.rpc.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(response(snapshot())), 6000))
    );
    const { result } = renderHook(() => useCashGameLobby('game', true, 5000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(result.current.lobby).not.toBeNull();
    expect(state.rpc).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(state.rpc).toHaveBeenCalledTimes(2);
  });

  it('does not poll during a mutation, but allows its explicit confirmation read', async () => {
    state.rpc.mockResolvedValue(response(snapshot()));
    const { result } = renderHook(() => useCashGameLobby('game', true, 5000));
    await flush();
    let action: ReturnType<typeof result.current.beginAction> = null;
    act(() => {
      action = result.current.beginAction();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(state.rpc).toHaveBeenCalledTimes(1);
    await act(async () => {
      await result.current.load();
      action!.finish();
    });
    expect(state.rpc).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(state.rpc).toHaveBeenCalledTimes(3);
  });

  it('keeps the newer explicit read pending when the superseded reply settles', async () => {
    const old = deferred();
    const next = deferred();
    state.rpc.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const { result } = renderHook(() => useCashGameLobby('game', true, 5000));
    let refresh!: Promise<void>;
    act(() => {
      refresh = result.current.load();
    });
    await act(async () => old.resolve(response(snapshot('game', 'old'))));
    expect(result.current.lobby).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(state.rpc).toHaveBeenCalledTimes(2);
    await act(async () => {
      next.resolve(response(snapshot()));
      await refresh;
    });
    expect(result.current.lobby?.me?.user_id).toBe('player-a');
  });

  it('ignores a late superseded reply after a newer explicit refresh has succeeded', async () => {
    const old = deferred();
    state.rpc.mockReturnValueOnce(old.promise).mockResolvedValue(response(snapshot()));
    const { result } = renderHook(() => useCashGameLobby('game', true, 5000));
    await act(async () => {
      await result.current.load();
    });
    await act(async () => old.resolve(response(snapshot('game', 'old'))));
    expect(result.current.lobby?.me?.user_id).toBe('player-a');
  });

  it('starts one live poll loop after Strict Mode effect replay', async () => {
    const old = deferred();
    state.rpc.mockReturnValueOnce(old.promise).mockResolvedValue(response(snapshot()));
    // React 19 replays initial effects for root Strict Mode, not a nested wrapper.
    const { result, unmount } = renderHook(() => useCashGameLobby('game', true, 5000), {
      reactStrictMode: true,
    });
    await flush();
    expect(state.rpc).toHaveBeenCalledTimes(2);
    await act(async () => old.resolve(response(snapshot('game', 'old'))));
    expect(result.current.lobby?.me?.user_id).toBe('player-a');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(state.rpc).toHaveBeenCalledTimes(3);
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(state.rpc).toHaveBeenCalledTimes(3);
  });

  it('prevents a double tap and keeps an old action finish from clearing the new viewer action', async () => {
    state.rpc.mockResolvedValue(response(snapshot()));
    const { result, rerender } = renderHook(() => useCashGameLobby('game', true, 5000));
    await flush();
    let oldAction: ReturnType<typeof result.current.beginAction> = null;
    act(() => {
      oldAction = result.current.beginAction();
      expect(result.current.beginAction()).toBeNull();
    });
    state.viewer = 'player-b';
    rerender();
    await flush();
    let newAction: ReturnType<typeof result.current.beginAction> = null;
    act(() => {
      newAction = result.current.beginAction();
    });
    act(() => {
      oldAction!.finish();
    });
    expect(newAction!.isCurrent()).toBe(true);
    expect(result.current.busy).toBe(true);
    act(() => {
      newAction!.finish();
    });
    expect(result.current.busy).toBe(false);
  });
});
