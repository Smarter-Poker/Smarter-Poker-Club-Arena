import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const model = vi.hoisted(() => ({
  options: null as any,
  rows: [] as Record<string, unknown>[],
  error: null as unknown,
  pending: null as Promise<any> | null,
  reads: [] as string[][],
  handlers: new Map<string, Set<(event: any) => void>>(),
}));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    subscribe: (name: string, handler: (event: any) => void) => {
      if (!model.handlers.has(name)) model.handlers.set(name, new Set());
      model.handlers.get(name)!.add(handler);
      return () => model.handlers.get(name)!.delete(handler);
    },
  },
}));
vi.mock('../../src/hooks/useMasterBusBroadcastChannel', () => ({
  useMasterBusBroadcastChannel: (options: any) => {
    model.options = options;
  },
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        in: (_column: string, ids: string[]) => {
          model.reads.push(ids);
          const reply = model.pending ?? Promise.resolve({ data: model.rows, error: model.error });
          return Object.assign(reply, { abortSignal: () => reply });
        },
      }),
    }),
    // The predecessor can join its dead WAL channel; failures against it are
    // missing delivery/health behavior, not an absent mocked SDK method.
    channel: () => {
      const c = { on: () => c, subscribe: () => c };
      return c;
    },
    removeChannel: () => Promise.resolve(),
  },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
import { useSeatedProfileSync } from '../../src/hooks/useSeatedProfileSync';
const A = 'aaaaaaaa-1111-2222-3333-444444444444';
const B = 'bbbbbbbb-1111-2222-3333-444444444444';
const T = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const U = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const row = (avatar: string) => ({
  id: A,
  arena_avatar_url: avatar,
  avatar_url: '/social.jpg',
  equipped_frame: null,
  equipped_aura: 'aura-fire',
});
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};
const emit = (name: string, payload: unknown) => {
  for (const fn of model.handlers.get(name) ?? []) fn({ payload });
};
beforeEach(() => {
  model.options = null;
  model.rows = [];
  model.error = null;
  model.pending = null;
  model.reads = [];
  model.handlers.clear();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('seated appearance uses the private source signal', () => {
  it('reads a bounded roster and joins one private table topic, without publishing profiles', async () => {
    renderHook(() => useSeatedProfileSync(T, [A, B, A], vi.fn()));
    await flush();
    expect(model.reads).toEqual([[A, B]]);
    expect(model.options).toMatchObject({
      channelName: `table-appearance:${T}`,
      private: true,
      event: 'appearance_changed',
    });
  });
  it('reads the authoritative appearance after another device sends only the player identity', async () => {
    const change = vi.fn();
    renderHook(() => useSeatedProfileSync(T, [A], change));
    await flush();
    model.rows = [row('/avatars/new.webp')];
    act(() => model.options?.onPayload({ payload: { user_id: A } }));
    await flush();
    expect(change).toHaveBeenCalledWith({
      userId: A,
      avatar: '/avatars/new.webp',
      frame: null,
      aura: 'aura-fire',
    });
  });
  it('reports live only after a subscribed channel and successful authoritative read', async () => {
    model.error = new Error('permission refused');
    const { result } = renderHook(() => useSeatedProfileSync(T, [A], vi.fn()));
    await flush();
    act(() => model.options?.onSubscriptionStatus('SUBSCRIBED'));
    await flush();
    expect(result.current.state).toBe('error');
    model.error = null;
    model.rows = [row('/readable.webp')];
    act(() => model.options?.onSubscriptionStatus('SUBSCRIBED'));
    await flush();
    expect(result.current.state).toBe('live');
  });
  it('recovers a missed edit on reconnect', async () => {
    const change = vi.fn();
    const { result } = renderHook(() => useSeatedProfileSync(T, [A], change));
    await flush();
    act(() => model.options?.onSubscriptionStatus('CHANNEL_ERROR'));
    expect(result.current.state).toBe('error');
    model.rows = [row('/avatars/while-offline.webp')];
    act(() => model.options?.onSubscriptionStatus('SUBSCRIBED'));
    await flush();
    expect(change).toHaveBeenCalledWith(
      expect.objectContaining({ avatar: '/avatars/while-offline.webp' })
    );
    expect(result.current.state).toBe('live');
  });
  it('reads on visibility return but does not read an appearance signal in a hidden tab', async () => {
    const change = vi.fn();
    renderHook(() => useSeatedProfileSync(T, [A], change));
    await flush();
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    model.rows = [row('/avatars/visible.webp')];
    act(() => model.options?.onPayload({ payload: { user_id: A } }));
    await flush();
    expect(model.reads).toHaveLength(1);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await flush();
    expect(change).toHaveBeenCalledWith(
      expect.objectContaining({ avatar: '/avatars/visible.webp' })
    );
  });
  it('ignores absent or unseated signal identities', async () => {
    renderHook(() => useSeatedProfileSync(T, [A], vi.fn()));
    await flush();
    act(() => {
      model.options?.onPayload({ payload: {} });
      model.options?.onPayload({ payload: { user_id: B } });
    });
    await flush();
    expect(model.reads).toHaveLength(1);
  });
  it('keeps immediate local and cross-tab appearance events', async () => {
    const change = vi.fn();
    renderHook(() => useSeatedProfileSync(T, [A], change));
    await flush();
    act(() =>
      emit('PLAYER_APPEARANCE_CHANGED', {
        userId: A,
        avatar: '/chosen.webp',
        frame: 'gold',
        aura: null,
      })
    );
    expect(change).toHaveBeenCalledWith({
      userId: A,
      avatar: '/chosen.webp',
      frame: 'gold',
      aura: null,
    });
    change.mockClear();
    act(() => emit('PLAYER_APPEARANCE_CHANGED', { userId: B, avatar: '/other.webp' }));
    expect(change).not.toHaveBeenCalled();
  });
  it('never lets a read started before an optimistic edit repaint the old avatar', async () => {
    let resolve!: (v: unknown) => void;
    model.pending = new Promise((r) => {
      resolve = r;
    });
    const change = vi.fn();
    renderHook(() => useSeatedProfileSync(T, [A], change));
    act(() => {
      emit('CUSTOMIZATION_MUTATION_STATE', {
        kind: 'player-appearance',
        scope: A,
        mutationId: 'one',
        state: 'pending',
      });
      emit('PLAYER_APPEARANCE_CHANGED', { userId: A, avatar: '/new.webp' });
    });
    model.pending = null;
    model.rows = [row('/new.webp')];
    change.mockClear();
    act(() =>
      emit('CUSTOMIZATION_MUTATION_STATE', {
        kind: 'player-appearance',
        scope: A,
        mutationId: 'one',
        state: 'confirmed',
      })
    );
    await act(async () => resolve({ data: [row('/old.webp')], error: null }));
    await flush();
    expect(change).not.toHaveBeenCalledWith(expect.objectContaining({ avatar: '/old.webp' }));
    expect(change).toHaveBeenCalledWith(expect.objectContaining({ avatar: '/new.webp' }));
  });
  it('discards a prior table reply and releases bus/visibility listeners on unmount', async () => {
    let resolve!: (v: unknown) => void;
    model.pending = new Promise((r) => {
      resolve = r;
    });
    const change = vi.fn();
    const { rerender, unmount } = renderHook(
      ({ table }) => useSeatedProfileSync(table, [A], change),
      { initialProps: { table: T } }
    );
    model.pending = null;
    rerender({ table: U });
    await flush();
    await act(async () => resolve({ data: [row('/old-table.webp')], error: null }));
    expect(change).not.toHaveBeenCalled();
    unmount();
    const before = model.reads.length;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      emit('PLAYER_APPEARANCE_CHANGED', { userId: A, avatar: '/leaked.webp' });
    });
    await flush();
    expect(change).not.toHaveBeenCalled();
    expect(model.reads).toHaveLength(before);
    expect([...model.handlers.values()].every((set) => set.size === 0)).toBe(true);
  });
  it('does not churn for roster reordering or callback identity changes', async () => {
    const { rerender } = renderHook(({ ids, callback }) => useSeatedProfileSync(T, ids, callback), {
      initialProps: { ids: [A, B], callback: vi.fn() },
    });
    await flush();
    rerender({ ids: [B, A], callback: vi.fn() });
    await flush();
    expect(model.reads).toHaveLength(1);
  });
  it('drops non-UUID roster entries and disables an empty roster', async () => {
    renderHook(() => useSeatedProfileSync(T, ["'); drop table profiles; --"], vi.fn()));
    await flush();
    expect(model.options?.channelName).toBeNull();
    expect(model.reads).toHaveLength(0);
  });
  it('does not claim live when RLS returns an incomplete roster', async () => {
    const { result } = renderHook(() => useSeatedProfileSync(T, [A], vi.fn()));
    await flush();
    act(() => model.options?.onSubscriptionStatus('SUBSCRIBED'));
    await flush();
    expect(result.current.state).toBe('error');
  });
  it('preserves a pending optimistic edit when another seat joins', async () => {
    model.rows = [row('/old.webp'), { ...row('/other.webp'), id: B }];
    const change = vi.fn();
    const { rerender } = renderHook(({ ids }) => useSeatedProfileSync(T, ids, change), {
      initialProps: { ids: [A] },
    });
    await flush();
    act(() =>
      emit('CUSTOMIZATION_MUTATION_STATE', {
        kind: 'player-appearance',
        scope: A,
        mutationId: 'pending',
        state: 'pending',
      })
    );
    change.mockClear();
    rerender({ ids: [A, B] });
    await flush();
    expect(change).not.toHaveBeenCalledWith(expect.objectContaining({ userId: A }));
    model.rows = [row('/confirmed.webp'), { ...row('/other.webp'), id: B }];
    act(() =>
      emit('CUSTOMIZATION_MUTATION_STATE', {
        kind: 'player-appearance',
        scope: A,
        mutationId: 'pending',
        state: 'confirmed',
      })
    );
    await flush();
    expect(change).toHaveBeenCalledWith(
      expect.objectContaining({ userId: A, avatar: '/confirmed.webp' })
    );
  });
  it('contains a throwing consumer callback', async () => {
    model.rows = [row('/safe.webp')];
    const change = vi.fn(() => {
      throw new Error('render');
    });
    renderHook(() => useSeatedProfileSync(T, [A], change));
    await flush();
    expect(change).toHaveBeenCalled();
  });
});
