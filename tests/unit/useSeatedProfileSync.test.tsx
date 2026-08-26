/**
 * useSeatedProfileSync — the propagation mechanism for issue #2.
 *
 * WHAT WAS BROKEN: changing your avatar changed it on your own screen only.
 * Other players kept the old face until they reloaded, because identity fields
 * only reach them on the engine snapshot and the engine only re-reads `profiles`
 * at the top of a deal.
 *
 * THE TRAP THIS FILE PINS: `table_seats` is NOT in the `supabase_realtime`
 * publication (checked against production 2026-08-25 — 109 tables, that is not
 * one of them), so the `table-seats-live:${tableId}` subscription that sits ten
 * lines above the mount site in TablePage has never delivered a row. `profiles`
 * IS in the publication. Copying the seats pattern would have produced a fix
 * that changed nothing and looked applied, which is worse than the bug.
 *
 * A note on realtime payload shape: the rest of this codebase reads the avatar
 * as `select('avatar_url:arena_avatar_url')`. A select alias is a PostgREST
 * feature. A replication payload carries RAW COLUMN NAMES, so the handler must
 * read `arena_avatar_url` — asserted below, because reading `avatar_url` here
 * would silently deliver undefined forever.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

type Handler = (payload: { new?: Record<string, unknown> }) => void;

const bus = {
  channels: [] as Array<{ name: string; filter: string; event: string; table: string }>,
  handlers: [] as Handler[],
  removed: 0,
};

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    channel: (name: string) => {
      const chan: any = {
        name,
        on: (_type: string, cfg: any, handler: Handler) => {
          bus.channels.push({
            name,
            filter: cfg.filter,
            event: cfg.event,
            table: cfg.table,
          });
          bus.handlers.push(handler);
          return chan;
        },
        subscribe: () => chan,
      };
      return chan;
    },
    removeChannel: () => {
      bus.removed += 1;
    },
  },
}));

vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

import { useSeatedProfileSync } from '../../src/hooks/useSeatedProfileSync';

const A = 'aaaaaaaa-1111-2222-3333-444444444444';
const B = 'bbbbbbbb-1111-2222-3333-444444444444';

beforeEach(() => {
  bus.channels = [];
  bus.handlers = [];
  bus.removed = 0;
});

describe('useSeatedProfileSync', () => {
  it('subscribes to profiles, not table_seats', () => {
    renderHook(() => useSeatedProfileSync('t1', [A, B], () => {}));
    expect(bus.channels).toHaveLength(1);
    expect(bus.channels[0].table).toBe('profiles');
    expect(bus.channels[0].event).toBe('UPDATE');
    expect(bus.channels[0].name).toBe('table-profiles-live:t1');
  });

  it('filters to exactly the seated ids with one channel, not one each', () => {
    renderHook(() => useSeatedProfileSync('t1', [A, B], () => {}));
    expect(bus.channels).toHaveLength(1);
    expect(bus.channels[0].filter).toBe(`id=in.(${[A, B].sort().join(',')})`);
  });

  it('does nothing without a table or without any seated player', () => {
    renderHook(() => useSeatedProfileSync(null, [A], () => {}));
    renderHook(() => useSeatedProfileSync('t1', [], () => {}));
    renderHook(() => useSeatedProfileSync('t1', [null, undefined], () => {}));
    expect(bus.channels).toHaveLength(0);
  });

  it('drops anything that is not a uuid rather than splicing it into the filter', () => {
    renderHook(() => useSeatedProfileSync('t1', [A, "'); drop table profiles; --"], () => {}));
    expect(bus.channels[0].filter).toBe(`id=in.(${A})`);
  });

  it('reads arena_avatar_url, because realtime carries raw column names', () => {
    const onChange = vi.fn();
    renderHook(() => useSeatedProfileSync('t1', [A], onChange));
    bus.handlers[0]({
      new: {
        id: A,
        arena_avatar_url: '/avatars/table/vip_wolf@2x.webp',
        avatar_url: '/social.jpg',
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
      new: { id: A, equipped_frame: 'frame-gold', equipped_aura: 'aura-fire' },
    });
    expect(onChange).toHaveBeenCalledWith({
      userId: A,
      avatar: undefined,
      frame: 'frame-gold',
      aura: 'aura-fire',
    });
  });

  it('reports a missing avatar as undefined, never as an empty string', () => {
    // The merge treats undefined as "no news" and keeps what the snapshot put on
    // the seat. '' would blank a face on any unrelated profiles UPDATE.
    const onChange = vi.fn();
    renderHook(() => useSeatedProfileSync('t1', [A], onChange));
    bus.handlers[0]({ new: { id: A, arena_avatar_url: '' } });
    expect(onChange.mock.calls[0][0].avatar).toBeUndefined();
  });

  it('ignores a payload with no id', () => {
    const onChange = vi.fn();
    renderHook(() => useSeatedProfileSync('t1', [A], onChange));
    bus.handlers[0]({ new: { equipped_frame: 'frame-gold' } });
    bus.handlers[0]({});
    expect(onChange).not.toHaveBeenCalled();
  });

  it('survives a throwing callback without tearing down the subscription', () => {
    const onChange = vi.fn(() => {
      throw new Error('render blew up');
    });
    renderHook(() => useSeatedProfileSync('t1', [A], onChange));
    expect(() => bus.handlers[0]({ new: { id: A, equipped_frame: 'frame-gold' } })).not.toThrow();
  });

  it('does not resubscribe when only the callback identity changes', () => {
    // TablePage is one enormous component and re-creates its callbacks on every
    // render. Without the ref this would rebuild a realtime subscription
    // continuously.
    const { rerender } = renderHook(({ cb }) => useSeatedProfileSync('t1', [A], cb), {
      initialProps: { cb: () => {} },
    });
    rerender({ cb: () => {} });
    rerender({ cb: () => {} });
    expect(bus.channels).toHaveLength(1);
    expect(bus.removed).toBe(0);
  });

  it('does not resubscribe when the same ids arrive in a different order', () => {
    const { rerender } = renderHook(({ ids }) => useSeatedProfileSync('t1', ids, () => {}), {
      initialProps: { ids: [A, B] as (string | null | undefined)[] },
    });
    rerender({ ids: [B, A] });
    expect(bus.channels).toHaveLength(1);
    expect(bus.removed).toBe(0);
  });

  it('resubscribes when a player actually joins', () => {
    const { rerender } = renderHook(({ ids }) => useSeatedProfileSync('t1', ids, () => {}), {
      initialProps: { ids: [A] as (string | null | undefined)[] },
    });
    rerender({ ids: [A, B] });
    expect(bus.channels).toHaveLength(2);
    expect(bus.removed).toBe(1);
    expect(bus.channels[1].filter).toBe(`id=in.(${[A, B].sort().join(',')})`);
  });

  it('removes the channel on unmount', () => {
    const { unmount } = renderHook(() => useSeatedProfileSync('t1', [A], () => {}));
    unmount();
    expect(bus.removed).toBe(1);
  });
});
