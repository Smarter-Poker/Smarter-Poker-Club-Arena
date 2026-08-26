import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

type Handler = (event: any) => void;

const bus = {
  events: [] as string[],
  handlers: [] as Handler[],
  removed: 0,
};

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    subscribe: (event: string, handler: Handler) => {
      bus.events.push(event);
      bus.handlers.push(handler);
      return () => {
        bus.removed += 1;
      };
    },
  },
}));

vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

import { useSeatedProfileSync } from '../../src/hooks/useSeatedProfileSync';

const A = 'aaaaaaaa-1111-2222-3333-444444444444';
const B = 'bbbbbbbb-1111-2222-3333-444444444444';

beforeEach(() => {
  bus.events = [];
  bus.handlers = [];
  bus.removed = 0;
});

describe('useSeatedProfileSync', () => {
  it('subscribes to TABLE_PROFILES_UPDATE on the master bus', () => {
    renderHook(() => useSeatedProfileSync('t1', [A, B], () => {}));
    expect(bus.events).toHaveLength(1);
    expect(bus.events[0]).toBe('TABLE_PROFILES_UPDATE');
  });

  it('does nothing without a table or without any seated player', () => {
    renderHook(() => useSeatedProfileSync(null, [A], () => {}));
    renderHook(() => useSeatedProfileSync('t1', [], () => {}));
    renderHook(() => useSeatedProfileSync('t1', [null, undefined], () => {}));
    expect(bus.events).toHaveLength(0);
  });

  it('drops anything that is not a uuid', () => {
    // It should not subscribe if the array contains no valid UUIDs
    renderHook(() => useSeatedProfileSync('t1', ["'); drop table profiles; --"], () => {}));
    expect(bus.events).toHaveLength(0);
  });

  it('reads arena_avatar_url, because realtime carries raw column names', () => {
    const onChange = vi.fn();
    renderHook(() => useSeatedProfileSync('t1', [A], onChange));
    bus.handlers[0]({
      payload: {
        newRow: {
          id: A,
          arena_avatar_url: '/avatars/table/vip_wolf@2x.webp',
          avatar_url: '/social.jpg',
        },
      },
    });
    expect(onChange).toHaveBeenCalledWith({
      userId: A,
      avatar: '/avatars/table/vip_wolf@2x.webp',
      frame: null,
      aura: null,
    });
  });

  it('carries the cosmetics through alongside the avatar', () => {
    const onChange = vi.fn();
    renderHook(() => useSeatedProfileSync('t1', [A], onChange));
    bus.handlers[0]({
      payload: {
        newRow: { id: A, equipped_frame: 'frame-gold', equipped_aura: 'aura-fire' },
      },
    });
    expect(onChange).toHaveBeenCalledWith({
      userId: A,
      avatar: undefined,
      frame: 'frame-gold',
      aura: 'aura-fire',
    });
  });

  it('reports a missing avatar as undefined, never as an empty string', () => {
    const onChange = vi.fn();
    renderHook(() => useSeatedProfileSync('t1', [A], onChange));
    bus.handlers[0]({ payload: { newRow: { id: A, arena_avatar_url: '' } } });
    expect(onChange.mock.calls[0][0].avatar).toBeUndefined();
  });

  it('ignores a payload with no id', () => {
    const onChange = vi.fn();
    renderHook(() => useSeatedProfileSync('t1', [A], onChange));
    bus.handlers[0]({ payload: { newRow: { equipped_frame: 'frame-gold' } } });
    bus.handlers[0]({ payload: { newRow: {} } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('ignores a payload for a user that is not seated', () => {
    const onChange = vi.fn();
    renderHook(() => useSeatedProfileSync('t1', [A], onChange));
    // B is not in the array [A]
    bus.handlers[0]({ payload: { newRow: { id: B, equipped_frame: 'frame-gold' } } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('survives a throwing callback without tearing down the subscription', () => {
    const onChange = vi.fn(() => {
      throw new Error('render blew up');
    });
    renderHook(() => useSeatedProfileSync('t1', [A], onChange));
    expect(() =>
      bus.handlers[0]({ payload: { newRow: { id: A, equipped_frame: 'frame-gold' } } })
    ).not.toThrow();
  });

  it('does not resubscribe when only the callback identity changes', () => {
    const { rerender } = renderHook(({ cb }) => useSeatedProfileSync('t1', [A], cb), {
      initialProps: { cb: () => {} },
    });
    rerender({ cb: () => {} });
    rerender({ cb: () => {} });
    expect(bus.events).toHaveLength(1);
    expect(bus.removed).toBe(0);
  });

  it('does not resubscribe when the same ids arrive in a different order', () => {
    const { rerender } = renderHook(({ ids }) => useSeatedProfileSync('t1', ids, () => {}), {
      initialProps: { ids: [A, B] as (string | null | undefined)[] },
    });
    rerender({ ids: [B, A] });
    expect(bus.events).toHaveLength(1);
    expect(bus.removed).toBe(0);
  });

  it('resubscribes when a player actually joins', () => {
    const { rerender } = renderHook(({ ids }) => useSeatedProfileSync('t1', ids, () => {}), {
      initialProps: { ids: [A] as (string | null | undefined)[] },
    });
    rerender({ ids: [A, B] });
    expect(bus.events).toHaveLength(2);
    expect(bus.removed).toBe(1);
  });

  it('removes the subscription on unmount', () => {
    const { unmount } = renderHook(() => useSeatedProfileSync('t1', [A], () => {}));
    unmount();
    expect(bus.removed).toBe(1);
  });
});
