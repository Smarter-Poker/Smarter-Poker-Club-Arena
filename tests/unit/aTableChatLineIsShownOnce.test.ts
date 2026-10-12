/**
 * A table chat line is shown once (2026-10-12).
 *
 * Dan typed "Good Luck" once. table_chat held exactly one row for it
 * (613ead3c-..., 05:51:17 UTC) and the Table Chat panel drew it three times.
 *
 * Two causes, both pinned here:
 *  1. realtime-js 2.90.x returns the channel ALREADY registered under a topic
 *     from `client.channel(topic)`. A previous TableWebSocket's `table:<id>`
 *     channel was still registered while its leave round-trip ran, so the
 *     next instance received that object and stacked its listeners onto it:
 *     one INSERT, one TABLE_CHAT_INSERT per stacked listener.
 *  2. useTableChat appended every TABLE_CHAT_INSERT without asking whether
 *     that row was already on screen. MasterBus only drops identical events
 *     inside 500ms, and it forwards every event to every other open
 *     smarter.poker tab, so a late echo (another tab holding the same table,
 *     a throttled background tab, a channel rejoin) was drawn again.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  registered: [] as Array<{ topic: string }>,
  stuck: false,
}));

vi.mock('../../src/lib/supabase', () => {
  const makeChannel = (topic: string) => {
    const ch: any = {
      topic,
      on: vi.fn(() => ch),
      subscribe: vi.fn((cb?: (status: string) => void) => {
        cb?.('SUBSCRIBED');
        return ch;
      }),
      track: vi.fn().mockResolvedValue(undefined),
      unsubscribe: vi.fn().mockResolvedValue('ok'),
      send: vi.fn().mockResolvedValue(undefined),
      presenceState: vi.fn().mockReturnValue({}),
    };
    return ch;
  };
  const query: any = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    order: vi.fn(() => query),
    limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    insert: vi.fn().mockResolvedValue({ data: null, error: null }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
  };
  return {
    supabase: {
      auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { user: {} } } }) },
      from: vi.fn(() => query),
      getChannels: vi.fn(() => h.registered),
      // Mirrors realtime-js 2.90.x: an existing topic returns the SAME object.
      channel: vi.fn((name: string) => {
        const topic = `realtime:${name}`;
        const existing = h.registered.find((c) => c.topic === topic);
        if (existing) return existing;
        const ch = makeChannel(topic);
        h.registered.push(ch);
        return ch;
      }),
      removeChannel: vi.fn(async (ch: any) => {
        if (!h.stuck) h.registered = h.registered.filter((c) => c !== ch);
        return 'ok';
      }),
    },
  };
});

vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

import { supabase } from '../../src/lib/supabase';
import { TableWebSocket } from '../../src/services/TableWebSocket';
import { useTableChat } from '../../src/hooks/useTableChat';
import { masterBus } from '../../src/core/MasterBus';

beforeEach(() => {
  h.registered = [];
  h.stuck = false;
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('a table channel is never reused', () => {
  it('removes a leftover table:<id> channel before creating its own, so listeners never stack', async () => {
    const leftover = (supabase as any).channel('table:t1');
    const ws = new TableWebSocket('t1', 'u1', 'Dan');
    await ws.connect();

    expect((supabase as any).removeChannel).toHaveBeenCalledWith(leftover);
    const mine = h.registered.filter((c) => c.topic === 'realtime:table:t1');
    expect(mine).toHaveLength(1);
    expect(mine[0]).not.toBe(leftover);
    expect((leftover as any).on).not.toHaveBeenCalled();
    await ws.disconnect();
  });

  it('refuses to attach to a leftover channel that will not go away', async () => {
    const leftover = (supabase as any).channel('table:t1');
    h.stuck = true;
    const ws = new TableWebSocket('t1', 'u1', 'Dan');
    await ws.connect();

    expect((leftover as any).on).not.toHaveBeenCalled();
    expect(ws.connected).toBe(false);
    await ws.disconnect();
  });
});

describe('useTableChat shows a saved row once', () => {
  it('draws one line for one row however many times it is delivered', async () => {
    const { result } = renderHook(() => useTableChat('t1', 'u1', [{ id: 'u1', name: 'Dan' }] as any));
    // Let the history load settle first, so it cannot overwrite the live lines.
    await waitFor(() => expect((supabase as any).from).toHaveBeenCalled());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const row = {
      id: '613ead3c-c76e-4bd3-ae9b-5d95e1f25137',
      table_id: 't1',
      user_id: 'u1',
      message: 'Good Luck',
      message_type: 'player',
      created_at: '2026-10-12T05:51:17.222Z',
    };
    // tests/setup.ts stubs MasterBus, so take the listener the hook
    // registered and deliver the same row to it three times - what a stacked
    // channel listener, a cross-tab echo or a rejoin replay each look like.
    const call = (masterBus.subscribe as any).mock.calls.find(
      (c: unknown[]) => c[0] === 'TABLE_CHAT_INSERT'
    );
    expect(call).toBeTruthy();
    const deliver = call[1] as (e: { payload: unknown }) => void;
    act(() => {
      for (let i = 0; i < 3; i++) deliver({ payload: { tableId: 't1', newRow: { ...row } } });
    });

    const lines = result.current.chatMessages.filter((m) => m.content === 'Good Luck');
    expect(lines).toHaveLength(1);
    expect(lines[0].id).toBe(row.id);
  });
});
