import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

type Handler = (event: any) => void;

const bus = {
  events: [] as string[],
  handlers: new Map<string, Handler[]>(),
  removed: 0,
};

const emitBus = (event: string, payload: unknown) => {
  for (const handler of bus.handlers.get(event) ?? []) handler({ payload });
};

const realtime = {
  channelNames: [] as string[],
  bindings: [] as Array<{ config: Record<string, string>; handler: Handler }>,
  statuses: [] as Array<(status: string, error?: Error) => void>,
  removed: 0,
  profileRows: [] as Array<Record<string, unknown>>,
  profileReads: 0,
};

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    subscribe: (event: string, handler: Handler) => {
      bus.events.push(event);
      const handlers = bus.handlers.get(event) ?? [];
      handlers.push(handler);
      bus.handlers.set(event, handlers);
      return () => {
        bus.removed += 1;
      };
    },
  },
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        in: () => {
          realtime.profileReads += 1;
          return Promise.resolve({ data: realtime.profileRows, error: null });
        },
      }),
    }),
    channel: (name: string) => {
      realtime.channelNames.push(name);
      const channel = {
        on: (_kind: string, config: Record<string, string>, handler: Handler) => {
          realtime.bindings.push({ config, handler });
          return channel;
        },
        subscribe: (callback: (status: string, error?: Error) => void) => {
          realtime.statuses.push(callback);
          return channel;
        },
      };
      return channel;
    },
    removeChannel: () => {
      realtime.removed += 1;
      return Promise.resolve();
    },
  },
}));

vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

import { useSeatedProfileSync } from '../../src/hooks/useSeatedProfileSync';

const A = 'aaaaaaaa-1111-2222-3333-444444444444';
const B = 'bbbbbbbb-1111-2222-3333-444444444444';

beforeEach(() => {
  bus.events = [];
  bus.handlers = new Map();
  bus.removed = 0;
  realtime.channelNames = [];
  realtime.bindings = [];
  realtime.statuses = [];
  realtime.removed = 0;
  realtime.profileRows = [];
  realtime.profileReads = 0;
});

describe('useSeatedProfileSync', () => {
  it('subscribes to the zero-latency player appearance event', () => {
    renderHook(() => useSeatedProfileSync('t1', [A, B], () => {}));
    expect(bus.events).toEqual(['CUSTOMIZATION_MUTATION_STATE', 'PLAYER_APPEARANCE_CHANGED']);
  });

  it('uses one channel with one user-filtered binding per seated player', () => {
    renderHook(() => useSeatedProfileSync('t1', [A, B], () => {}));
    expect(realtime.channelNames).toHaveLength(1);
    expect(realtime.bindings.map((binding) => binding.config.filter)).toEqual([
      `id=eq.${A}`,
      `id=eq.${B}`,
    ]);
    expect(realtime.bindings.every((binding) => binding.config.table === 'profiles')).toBe(true);
  });

  it('reports channel health and reconciles the authoritative seated profiles once live', async () => {
    const onChange = vi.fn();
    realtime.profileRows = [
      {
        id: A,
        arena_avatar_url: '/avatars/table/current.webp',
        equipped_frame: 'frame-gold',
        equipped_aura: null,
      },
    ];
    const { result } = renderHook(() => useSeatedProfileSync('t1', [A], onChange));

    expect(result.current.state).toBe('connecting');
    act(() => realtime.statuses[0]?.('SUBSCRIBED'));

    await waitFor(() => expect(result.current.state).toBe('live'));
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        userId: A,
        avatar: '/avatars/table/current.webp',
        frame: 'frame-gold',
        aura: null,
      })
    );
    expect(realtime.profileReads).toBe(1);
  });

  it('re-reads seated profiles after a channel outage so missed avatar updates cannot stay stale', async () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useSeatedProfileSync('t1', [A], onChange));
    act(() => realtime.statuses[0]?.('SUBSCRIBED'));
    await waitFor(() => expect(result.current.state).toBe('live'));
    onChange.mockClear();

    act(() => realtime.statuses[0]?.('CHANNEL_ERROR', new Error('offline')));
    expect(result.current.state).toBe('error');
    realtime.profileRows = [
      {
        id: A,
        arena_avatar_url: '/avatars/table/changed-while-offline.webp',
        equipped_frame: null,
        equipped_aura: 'aura-fire',
      },
    ];
    act(() => realtime.statuses[0]?.('SUBSCRIBED'));

    await waitFor(() => expect(realtime.profileReads).toBe(2));
    expect(onChange).toHaveBeenCalledWith({
      userId: A,
      avatar: '/avatars/table/changed-while-offline.webp',
      frame: null,
      aura: 'aura-fire',
    });
  });

  it('does nothing without a table or without any seated player', () => {
    renderHook(() => useSeatedProfileSync(null, [A], () => {}));
    renderHook(() => useSeatedProfileSync('t1', [], () => {}));
    renderHook(() => useSeatedProfileSync('t1', [null, undefined], () => {}));
    expect(bus.events).toHaveLength(0);
    expect(realtime.channelNames).toHaveLength(0);
  });

  it('drops anything that is not a uuid', () => {
    // It should not subscribe if the array contains no valid UUIDs
    renderHook(() => useSeatedProfileSync('t1', ["'); drop table profiles; --"], () => {}));
    expect(bus.events).toHaveLength(0);
  });

  it('reads arena_avatar_url, because realtime carries raw column names', () => {
    const onChange = vi.fn();
    renderHook(() => useSeatedProfileSync('t1', [A], onChange));
    emitBus('PLAYER_APPEARANCE_CHANGED', {
      userId: A,
      avatar: '/avatars/table/vip_wolf@2x.webp',
      source: 'avatar-picker',
    });
    expect(onChange).toHaveBeenCalledWith({
      userId: A,
      avatar: '/avatars/table/vip_wolf@2x.webp',
      frame: undefined,
      aura: undefined,
    });
  });

  it('carries optimistic cosmetics through alongside the avatar', () => {
    const onChange = vi.fn();
    renderHook(() => useSeatedProfileSync('t1', [A], onChange));
    emitBus('PLAYER_APPEARANCE_CHANGED', {
      userId: A,
      frame: 'frame-gold',
      aura: 'aura-fire',
      source: 'cosmetic-picker',
    });
    expect(onChange).toHaveBeenCalledWith({
      userId: A,
      avatar: undefined,
      frame: 'frame-gold',
      aura: 'aura-fire',
    });
  });

  it('normalizes raw database columns from the scoped realtime binding', () => {
    const onChange = vi.fn();
    renderHook(() => useSeatedProfileSync('t1', [A], onChange));
    realtime.bindings[0].handler({
      new: {
        id: A,
        arena_avatar_url: '/avatars/table/vip_wolf@2x.webp',
        avatar_url: '/social.jpg',
        equipped_frame: null,
        equipped_aura: 'aura-fire',
      },
    });
    expect(onChange).toHaveBeenCalledWith({
      userId: A,
      avatar: '/avatars/table/vip_wolf@2x.webp',
      frame: null,
      aura: 'aura-fire',
    });
  });

  it('does not let an older database echo repaint over an optimistic avatar', () => {
    const onChange = vi.fn();
    renderHook(() => useSeatedProfileSync('t1', [A], onChange));
    emitBus('CUSTOMIZATION_MUTATION_STATE', {
      kind: 'player-appearance',
      scope: A,
      mutationId: 'avatar-2',
      state: 'pending',
    });
    emitBus('PLAYER_APPEARANCE_CHANGED', {
      userId: A,
      avatar: '/avatars/table/new.webp',
      mutationId: 'avatar-2',
      source: 'avatar-picker',
    });
    onChange.mockClear();

    realtime.bindings[0].handler({
      new: { id: A, arena_avatar_url: '/avatars/table/old.webp' },
    });
    expect(onChange).not.toHaveBeenCalled();

    emitBus('CUSTOMIZATION_MUTATION_STATE', {
      kind: 'player-appearance',
      scope: A,
      mutationId: 'avatar-2',
      state: 'confirmed',
    });
    realtime.bindings[0].handler({
      new: { id: A, arena_avatar_url: '/avatars/table/new.webp' },
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ userId: A, avatar: '/avatars/table/new.webp' })
    );
  });

  it('ignores a payload with no id', () => {
    const onChange = vi.fn();
    renderHook(() => useSeatedProfileSync('t1', [A], onChange));
    emitBus('PLAYER_APPEARANCE_CHANGED', {
      frame: 'frame-gold',
      source: 'cosmetic-picker',
    });
    realtime.bindings[0].handler({ new: {} });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('ignores a payload for a user that is not seated', () => {
    const onChange = vi.fn();
    renderHook(() => useSeatedProfileSync('t1', [A], onChange));
    // B is not in the array [A]
    emitBus('PLAYER_APPEARANCE_CHANGED', {
      userId: B,
      frame: 'frame-gold',
      source: 'cosmetic-picker',
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('survives a throwing callback without tearing down the subscription', () => {
    const onChange = vi.fn(() => {
      throw new Error('render blew up');
    });
    renderHook(() => useSeatedProfileSync('t1', [A], onChange));
    expect(() =>
      emitBus('PLAYER_APPEARANCE_CHANGED', {
        userId: A,
        frame: 'frame-gold',
        source: 'cosmetic-picker',
      })
    ).not.toThrow();
  });

  it('does not resubscribe when only the callback identity changes', () => {
    const { rerender } = renderHook(({ cb }) => useSeatedProfileSync('t1', [A], cb), {
      initialProps: { cb: () => {} },
    });
    rerender({ cb: () => {} });
    rerender({ cb: () => {} });
    expect(bus.events).toHaveLength(2);
    expect(bus.removed).toBe(0);
  });

  it('does not resubscribe when the same ids arrive in a different order', () => {
    const { rerender } = renderHook(({ ids }) => useSeatedProfileSync('t1', ids, () => {}), {
      initialProps: { ids: [A, B] as (string | null | undefined)[] },
    });
    rerender({ ids: [B, A] });
    expect(bus.events).toHaveLength(2);
    expect(bus.removed).toBe(0);
  });

  it('resubscribes when a player actually joins', () => {
    const { rerender } = renderHook(({ ids }) => useSeatedProfileSync('t1', ids, () => {}), {
      initialProps: { ids: [A] as (string | null | undefined)[] },
    });
    rerender({ ids: [A, B] });
    expect(bus.events).toHaveLength(4);
    expect(bus.removed).toBe(2);
    expect(realtime.channelNames).toHaveLength(2);
    expect(realtime.removed).toBe(1);
  });

  it('removes the subscription on unmount', () => {
    const { unmount } = renderHook(() => useSeatedProfileSync('t1', [A], () => {}));
    unmount();
    expect(bus.removed).toBe(2);
    expect(realtime.removed).toBe(1);
  });
});
