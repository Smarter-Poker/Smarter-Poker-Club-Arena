import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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
const key = 't-break-e796074d-2f13-4b8e-b010-7b26219a44c2';
beforeEach(async () => {
  vi.useFakeTimers();
  wire.joins.length = 0;
  wire.sockets.length = 0;
  vi.mocked(supabase.channel).mockClear();
  vi.mocked(supabase.removeChannel).mockClear();
  masterBus.init();
  await realtime.setAuth('reserved-fixture-session');
});
afterEach(async () => {
  masterBus.reset();
  await Promise.resolve();
  realtime.disconnect();
  vi.clearAllTimers();
  vi.useRealTimers();
});
async function join(name = key) {
  const channel = masterBus.getOrCreateChannel(name);
  const level = vi.fn();
  const status = vi.fn();
  channel.on(
    'postgres_changes',
    {
      event: 'UPDATE',
      schema: 'public',
      table: 'tournaments',
      filter: 'id=eq.e796074d-2f13-4b8e-b010-7b26219a44c2',
    },
    () => {}
  );
  channel.on('broadcast', { event: 'tournament_event' }, level).subscribe(status);
  await vi.advanceTimersByTimeAsync(0);
  expect(status).toHaveBeenCalledWith('SUBSCRIBED');
  return { channel, level, status };
}
it('keeps the original authenticated tournament channel alive through health check and SDK rejoin', async () => {
  const { channel, level, status } = await join();
  const initial = structuredClone(wire.joins[0].payload);
  await vi.advanceTimersByTimeAsync(29_900);
  wire.sockets[0].receive(channel.topic, 'phx_error', {});
  expect(channel.state).toBe('errored');
  expect(status).toHaveBeenCalledWith('CHANNEL_ERROR', expect.anything());
  expect((channel as any).rejoinTimer.timer).toBeDefined();
  await vi.advanceTimersByTimeAsync(100);
  expect(masterBus.hasChannel(key)).toBe(true);
  expect(supabase.removeChannel).not.toHaveBeenCalled();
  expect((channel as any).rejoinTimer.timer).toBeDefined();
  await vi.advanceTimersByTimeAsync(900);
  expect(channel.state).toBe('joined');
  expect(wire.joins).toHaveLength(2);
  expect(wire.joins[1].payload).toEqual(initial);
  expect(initial.access_token).toBe('reserved-fixture-session');
  expect(initial.config.private).toBe(false);
  expect(supabase.channel).toHaveBeenCalledTimes(1);
  expect(realtime.getChannels()).toEqual([channel]);
  wire.sockets[0].receive(channel.topic, 'broadcast', {
    event: 'tournament_event',
    payload: { type: 'level_up', payload: { level: 5 } },
  });
  expect(level).toHaveBeenCalledTimes(1);
  expect(level).toHaveBeenCalledWith(
    expect.objectContaining({ payload: { type: 'level_up', payload: { level: 5 } } }),
    undefined
  );
});
it('preserves both shared consumers until their normal final cleanup', async () => {
  const { channel } = await join();
  expect(masterBus.getOrCreateChannel(key)).toBe(channel);
  await vi.advanceTimersByTimeAsync(29_900);
  wire.sockets[0].receive(channel.topic, 'phx_error', {});
  await vi.advanceTimersByTimeAsync(100);
  masterBus.removeRegisteredChannel(key);
  expect(masterBus.hasChannel(key)).toBe(true);
  expect(supabase.removeChannel).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(900);
  expect(channel.state).toBe('joined');
  masterBus.removeRegisteredChannel(key);
  await vi.advanceTimersByTimeAsync(0);
  expect(masterBus.hasChannel(key)).toBe(false);
  expect(supabase.removeChannel).toHaveBeenCalledExactlyOnceWith(channel);
  expect(realtime.getChannels()).toHaveLength(0);
  expect((channel as any).rejoinTimer.timer).toBeUndefined();
});
it.each(['unrelated-feed', 't-break-invalid'])(
  'retains ordinary dead-channel cleanup for %s',
  async (name) => {
    const { channel } = await join(name);
    await vi.advanceTimersByTimeAsync(29_900);
    wire.sockets[0].receive(channel.topic, 'phx_error', {});
    await vi.advanceTimersByTimeAsync(100);
    expect(masterBus.hasChannel(name)).toBe(false);
    expect(supabase.removeChannel).toHaveBeenCalledExactlyOnceWith(channel);
  }
);
it('retains existing secure hole-card protection', async () => {
  const { channel } = await join('table-cards-secure-fixture');
  await vi.advanceTimersByTimeAsync(29_900);
  wire.sockets[0].receive(channel.topic, 'phx_error', {});
  await vi.advanceTimersByTimeAsync(100);
  expect(supabase.removeChannel).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(900);
  expect(channel.state).toBe('joined');
});
