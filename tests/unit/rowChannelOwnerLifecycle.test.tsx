import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, renderHook, cleanup } from '@testing-library/react';
import { useMasterBusChannel } from '../../src/hooks/useMasterBusChannel';
import { reportError } from '../../src/utils/errorReporter';
vi.unmock('../../src/core/MasterBus');

// Only the wire is local. MasterBus and the locked Realtime SDK own registry,
// join acknowledgments, error state, rejoin timer, auth payload and teardown.
const wire = vi.hoisted(() => ({ joins: [] as Array<Record<string, any>>, sockets: [] as any[] }));
vi.mock('../../src/lib/supabase', async () => {
  const { RealtimeClient } = await import('@supabase/realtime-js');
  class LocalSocket {
    readyState = 0;
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: () => void;
    constructor() {
      wire.sockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.();
      });
    }
    send(raw: string) {
      const frame = JSON.parse(raw);
      const msg = Array.isArray(frame)
        ? { join_ref: frame[0], ref: frame[1], topic: frame[2], event: frame[3], payload: frame[4] }
        : frame;
      if (msg.event === 'phx_join') wire.joins.push(msg);
      if (['phx_join', 'phx_leave', 'heartbeat'].includes(msg.event)) {
        queueMicrotask(() =>
          this.receive(
            msg.topic,
            'phx_reply',
            {
              status: 'ok',
              response:
                msg.event === 'phx_join'
                  ? {
                      postgres_changes: (msg.payload.config.postgres_changes ?? []).map(
                        (filter: object, i: number) => ({ ...filter, id: i + 1 })
                      ),
                    }
                  : {},
            },
            msg.ref
          )
        );
      }
    }
    receive(topic: string, event: string, payload: unknown, ref?: string) {
      this.onmessage?.({ data: JSON.stringify({ topic, event, payload, ref }) });
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
  }
  const realtime = new RealtimeClient('wss://reserved-fixture.invalid/realtime/v1', {
    params: { apikey: 'isolated-fixture' },
    transport: LocalSocket as any,
  });
  return {
    supabase: {
      realtime,
      channel: vi.fn(realtime.channel.bind(realtime)),
      removeChannel: vi.fn(realtime.removeChannel.bind(realtime)),
    },
  };
});
vi.mock('../../src/stores/useArenaStore', () => ({ useArenaStore: { getState: () => ({}) } }));
vi.mock('../../src/stores/useClubStore', () => ({ useClubStore: { getState: () => ({}) } }));
vi.mock('../../src/stores/useTableStore', () => ({ useTableStore: { getState: () => ({}) } }));
vi.mock('../../src/stores/useUnionStore', () => ({ useUnionStore: { getState: () => ({}) } }));
vi.mock('../../src/stores/useWalletStore', () => ({ useWalletStore: { getState: () => ({}) } }));
vi.mock('../../src/stores/useSettingsStore', () => ({
  useSettingsStore: { getState: () => ({}) },
}));
vi.mock('../../src/stores/useUserStore', () => ({
  useUserStore: { getState: () => ({ user: null }) },
}));
vi.mock('../../src/services/RealtimeChannelService', () => ({ realtimeChannelService: {} }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
import { masterBus } from '../../src/core/MasterBus';
import { supabase } from '../../src/lib/supabase';

const realtime = (supabase as any).realtime;
beforeEach(async () => {
  vi.useFakeTimers();
  wire.joins.length = 0;
  wire.sockets.length = 0;
  vi.mocked(supabase.channel).mockClear();
  vi.mocked(supabase.removeChannel).mockClear();
  masterBus.init();
  realtime.connect();
  await vi.advanceTimersByTimeAsync(0);
  await realtime.setAuth('reserved-fixture-session');
});
afterEach(async () => {
  cleanup();
  masterBus.reset();
  await Promise.resolve();
  realtime.disconnect();
  vi.clearAllTimers();
  vi.useRealTimers();
});
it('keeps both mounted club views subscribed when the second arrives after the first join', async () => {
  const first = vi.fn(),
    second = vi.fn(),
    statuses = [vi.fn(), vi.fn()];
  const mount = (onPayload: typeof first, onSubscriptionStatus: typeof first) =>
    renderHook(() =>
      useMasterBusChannel({
        channelName: 'club-members-kings-club',
        table: 'club_members',
        filter: 'club_id=eq.11111111-1111-4111-a111-111111111111',
        event: '*',
        onPayload,
        onSubscriptionStatus,
      })
    );
  const a = mount(first, statuses[0]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(statuses[0]).toHaveBeenCalledWith('SUBSCRIBED');
  const b = mount(second, statuses[1]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(statuses[1]).toHaveBeenCalledWith('SUBSCRIBED');
  expect(realtime.getChannels()).toHaveLength(2);
  for (const join of wire.joins) {
    expect(join.payload.access_token).toBe('reserved-fixture-session');
    expect(join.payload.config.postgres_changes).toEqual([
      {
        event: '*',
        schema: 'public',
        table: 'club_members',
        filter: 'club_id=eq.11111111-1111-4111-a111-111111111111',
      },
    ]);
  }
  const channels = [...realtime.getChannels()];
  const send = (channel: any, balance: number) =>
    wire.sockets[0].receive(channel.topic, 'postgres_changes', {
      ids: [1],
      data: {
        schema: 'public',
        table: 'club_members',
        type: 'UPDATE',
        commit_timestamp: '2026-10-31T15:00:00Z',
        columns: [],
        errors: null,
        record: { id: 'member-one', chip_balance: balance },
        old_record: {},
      },
    });
  act(() => {
    channels.forEach((channel) => send(channel, 7));
  });
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
  expect(second.mock.calls[0][0]).toMatchObject({ eventType: 'UPDATE', new: { chip_balance: 7 } });
  a.unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(realtime.getChannels()).toHaveLength(1);
  act(() => {
    channels.forEach((channel) => send(channel, 8));
  });
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(2);
  expect(reportError).not.toHaveBeenCalled();
  b.unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(realtime.getChannels()).toHaveLength(0);
});
