import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RealtimeClient } from '@supabase/realtime-js';
import { RealtimeAdmission } from '../../src/lib/realtimeAdmission';
const state = vi.hoisted(() => ({
  client: undefined as RealtimeClient | undefined,
  auth: new Set<(event: string) => void>(),
}));
vi.mock('../../src/core/MasterBus', async () => await vi.importActual('../../src/core/MasterBus'));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(resolve),
      };
      return builder;
    },
    auth: {
      onAuthStateChange: (listener: (event: string) => void) => {
        state.auth.add(listener);
        return { data: { subscription: { unsubscribe: () => state.auth.delete(listener) } } };
      },
    },
    get realtime() {
      return state.client;
    },
    channel: (...args: Parameters<RealtimeClient['channel']>) => state.client!.channel(...args),
    removeChannel: (...args: Parameters<RealtimeClient['removeChannel']>) =>
      state.client!.removeChannel(...args),
  },
}));
import { realtimeAdmission } from '../../src/lib/realtimeAdmission';
import {
  useUserThemeRealtime,
  useUserThemeSettings,
  __themeRealtimeChannelCount,
} from '../../src/hooks/useUserThemeSettings';

class NativeSocketFixture extends EventTarget {
  static instances: NativeSocketFixture[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = NativeSocketFixture.CONNECTING;
  sent: Array<Record<string, any>> = [];
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(_url: string | URL, _protocols?: string | string[]) {
    super();
    NativeSocketFixture.instances.push(this);
  }

  open() {
    this.readyState = NativeSocketFixture.OPEN;
    const event = new Event('open');
    this.dispatchEvent(event);
    this.onopen?.(event);
  }

  send(encoded: string) {
    const message = JSON.parse(encoded);
    this.sent.push(message);
    // Keep the provider transport healthy while deliberately withholding only
    // the channel join ACK; heartbeat failure has its own unchanged deadline.
    if (message.topic === 'phoenix' && message.event === 'heartbeat') {
      queueMicrotask(() =>
        this.onmessage?.({
          data: JSON.stringify({
            topic: 'phoenix',
            event: 'phx_reply',
            ref: message.ref,
            payload: { status: 'ok', response: {} },
          }),
        })
      );
    }
  }

  close() {
    this.readyState = NativeSocketFixture.CLOSED;
    const event = new Event('close');
    this.dispatchEvent(event);
    this.onclose?.(event);
  }

  fail() {
    const event = new Event('error');
    this.dispatchEvent(event);
    this.onerror?.(event);
  }
}

let readiness: RealtimeAdmission;
beforeEach(() => {
  vi.useFakeTimers();
  NativeSocketFixture.instances = [];
  state.auth.clear();
  readiness = new RealtimeAdmission(NativeSocketFixture as unknown as typeof WebSocket);
  vi.spyOn(realtimeAdmission, 'onReadinessChange').mockImplementation((...args) =>
    readiness.onReadinessChange(...args)
  );
  vi.spyOn(realtimeAdmission, 'ready').mockImplementation((...args) => readiness.ready(...args));
  state.client = new RealtimeClient('wss://fixture.invalid/realtime/v1', {
    params: { apikey: 'synthetic-public-fixture' },
    transport: readiness.transport,
    accessToken: async () => 'synthetic-fixture-token-not-a-credential',
  });
});
afterEach(() => {
  cleanup();
  state.client?.disconnect();
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});
async function advance(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
function acknowledge(socket: NativeSocketFixture) {
  const join = socket.sent.find((message) => message.event === 'phx_join');
  expect(join).toBeDefined();
  socket.onmessage?.({
    data: JSON.stringify({
      topic: join!.topic,
      event: 'phx_reply',
      ref: join!.ref,
      payload: {
        status: 'ok',
        response: {
          postgres_changes: join!.payload.config.postgres_changes.map((filter: unknown) => ({
            ...(filter as object),
            id: 1,
          })),
        },
      },
    }),
  });
}

it('the real hook does not spend its join deadline while a measured15.164s cold socket opens', async () => {
  const mounted = renderHook(() => useUserThemeRealtime('fixture-user'));
  await advance();
  const socket = NativeSocketFixture.instances[0];
  await advance(10_001);
  expect(mounted.result.current.state).toBe('connecting');
  expect(socket.sent).toEqual([]);
  await advance(5_163);
  act(() => socket.open());
  await advance();
  expect(state.client!.timeout).toBe(10_000);
  expect(socket.sent.filter((message) => message.event === 'phx_join')).toHaveLength(1);
  expect(mounted.result.current.state).toBe('connecting');
  act(() => acknowledge(socket));
  await advance();
  expect(mounted.result.current.state).toBe('live');
  expect(mounted.result.current.reconciliationRevision).toBe(1);
  mounted.unmount();
  expect(__themeRealtimeChannelCount()).toBe(0);
});

it('retains the integrated60s page join budget without changing the SDK client default', async () => {
  const mounted = renderHook(() => useUserThemeRealtime('fixture-user'));
  await advance();
  act(() => NativeSocketFixture.instances[0].open());
  await advance();
  expect(state.client!.timeout).toBe(10_000);
  expect(state.client!.getChannels()[0].timeout).toBe(60_000);
  await advance(59_999);
  expect(mounted.result.current.state).toBe('connecting');
  await advance(1);
  expect(mounted.result.current.state).toBe('error');
  expect(mounted.result.current.reconciliationRevision).toBe(0);
});

it('shares a pending admission across mounted tables and aborts only its final owner', async () => {
  // A separate live owner keeps the SDK transport in use after our last ref.
  state.client!.channel('unrelated-owner').subscribe();
  const first = renderHook(() => useUserThemeRealtime('fixture-user'));
  const second = renderHook(() => useUserThemeRealtime('fixture-user'));
  await advance();
  expect(realtimeAdmission.ready).toHaveBeenCalledTimes(1);
  const signal = vi.mocked(realtimeAdmission.ready).mock.calls[0][1];
  first.unmount();
  expect(signal.aborted).toBe(false);
  const socket = NativeSocketFixture.instances[0];
  second.unmount();
  expect(signal.aborted).toBe(true);
  act(() => socket.open());
  await advance();
  expect(
    socket.sent.filter(
      (message) =>
        message.event === 'phx_join' &&
        message.topic === 'realtime:user-theme-settings:fixture-user'
    )
  ).toEqual([]);
  expect(socket.readyState).toBe(NativeSocketFixture.OPEN);
  expect(__themeRealtimeChannelCount()).toBe(0);
});

it('explicit retry cancels the prior generation before a late shared socket can join it', async () => {
  const mounted = renderHook(() => useUserThemeRealtime('fixture-user'));
  await advance();
  const retired = state.client!.getChannels()[0];
  const signal = vi.mocked(realtimeAdmission.ready).mock.calls[0][1];
  act(() => mounted.result.current.retry());
  await advance();
  expect(signal.aborted).toBe(true);
  expect(realtimeAdmission.ready).toHaveBeenCalledTimes(2);
  act(() => NativeSocketFixture.instances.at(-1)!.open());
  await advance();
  expect(retired.joinedOnce).toBe(false);
  expect(
    NativeSocketFixture.instances
      .flatMap((socket) => socket.sent)
      .filter((message) => message.event === 'phx_join')
  ).toHaveLength(1);
  expect(mounted.result.current.state).toBe('connecting');
});

it('an account change prevents the old account from joining the shared transport', async () => {
  const mounted = renderHook(({ user }) => useUserThemeRealtime(user), {
    initialProps: { user: 'old-user' },
  });
  await advance();
  const retired = state.client!.getChannels()[0];
  const signal = vi.mocked(realtimeAdmission.ready).mock.calls[0][1];
  mounted.rerender({ user: 'next-user' });
  await advance();
  expect(signal.aborted).toBe(true);
  act(() => NativeSocketFixture.instances.at(-1)!.open());
  await advance();
  expect(retired.joinedOnce).toBe(false);
  const joins = NativeSocketFixture.instances
    .flatMap((socket) => socket.sent)
    .filter((message) => message.event === 'phx_join');
  expect(joins).toHaveLength(1);
  expect(joins[0].topic).toBe('realtime:user-theme-settings:next-user');
});

it('reports admission failure through its existing error state without a false reconciliation', async () => {
  vi.mocked(realtimeAdmission.ready).mockRejectedValueOnce(
    new Error('Synthetic authentication failed')
  );
  const mounted = renderHook(() => useUserThemeRealtime('fixture-user'));
  await advance();
  expect(mounted.result.current.state).toBe('error');
  expect(mounted.result.current.reconciliationRevision).toBe(0);
  expect(state.client!.getChannels()[0].joinedOnce).toBe(false);
});

it('recovers a timed-out initial admission on the same physical socket and delivers the named row event', async () => {
  const mounted = renderHook(() => ({
    health: useUserThemeRealtime('fixture-user'),
    settings: useUserThemeSettings('fixture-user', 'nlh'),
  }));
  await advance();
  const channel = state.client!.getChannels()[0];
  const socket = NativeSocketFixture.instances[0];
  await advance(20_000);
  expect(mounted.result.current.health.state).toBe('error');
  expect(channel.joinedOnce).toBe(false);
  act(() => socket.open());
  await advance();
  expect(NativeSocketFixture.instances).toHaveLength(1);
  expect(state.client!.getChannels()[0]).toBe(channel);
  expect(socket.sent.filter((message) => message.event === 'phx_join')).toHaveLength(1);
  expect(mounted.result.current.health.state).toBe('connecting');
  act(() => acknowledge(socket));
  await advance();
  expect(mounted.result.current.health.state).toBe('live');
  expect(mounted.result.current.health.reconciliationRevision).toBe(1);
  const join = socket.sent.find((message) => message.event === 'phx_join')!;
  act(() =>
    socket.onmessage?.({
      data: JSON.stringify({
        topic: join.topic,
        event: 'postgres_changes',
        payload: {
          ids: [1],
          data: {
            schema: 'public',
            table: 'user_theme_settings',
            type: 'UPDATE',
            commit_timestamp: '2026-10-13T23:40:00Z',
            columns: [
              { name: 'game_type', type: 'text' },
              { name: 'table_id', type: 'text' },
              { name: 'updated_at', type: 'timestamptz' },
            ],
            record: { game_type: 'ALL', table_id: 'jade_city', updated_at: '2026-10-13T23:40:00Z' },
            old_record: {},
          },
        },
      }),
    })
  );
  await advance();
  expect(mounted.result.current.settings.theme.table_id).toBe('jade_city');
  expect(state.auth.size).toBe(0);
  act(() => {
    window.dispatchEvent(new Event('online'));
    socket.open();
  });
  await advance();
  expect(socket.sent.filter((message) => message.event === 'phx_join')).toHaveLength(1);
});

it('late open, auth and online cannot revive a released owner after admission failure', async () => {
  state.client!.channel('unrelated-owner').subscribe();
  const mounted = renderHook(() => useUserThemeRealtime('fixture-user'));
  await advance();
  const socket = NativeSocketFixture.instances[0];
  await advance(20_000);
  expect(mounted.result.current.state).toBe('error');
  const retiredAuth = [...state.auth];
  expect(retiredAuth).toHaveLength(1);
  mounted.unmount();
  expect(state.auth.size).toBe(0);
  act(() => {
    socket.open();
    for (const listener of retiredAuth) listener('TOKEN_REFRESHED');
    window.dispatchEvent(new Event('online'));
  });
  await advance();
  expect(__themeRealtimeChannelCount()).toBe(0);
  expect(
    socket.sent.filter(
      (message) =>
        message.event === 'phx_join' &&
        message.topic === 'realtime:user-theme-settings:fixture-user'
    )
  ).toEqual([]);
  expect(socket.readyState).toBe(NativeSocketFixture.OPEN);
});

it('recovers the same channel when the existing stored-session auth promise fulfills after admission timeout', async () => {
  state.client!.disconnect();
  let resolveAuth!: (token: string) => void;
  const token = new Promise<string>((resolve) => {
    resolveAuth = resolve;
  });
  state.client = new RealtimeClient('wss://fixture.invalid/realtime/v1', {
    params: { apikey: 'synthetic-public-fixture' },
    transport: readiness.transport,
    accessToken: () => token,
  });
  const mounted = renderHook(() => useUserThemeRealtime('fixture-user'));
  await advance();
  const socket = NativeSocketFixture.instances[0];
  act(() => socket.open());
  await advance(20_000);
  expect(mounted.result.current.state).toBe('error');
  expect(socket.sent).toEqual([]);
  act(() => resolveAuth('synthetic-fixture-token-not-a-credential'));
  await advance();
  expect(NativeSocketFixture.instances).toHaveLength(1);
  expect(socket.sent.filter((message) => message.event === 'phx_join')).toHaveLength(1);
  expect(mounted.result.current.state).toBe('connecting');
  act(() => acknowledge(socket));
  await advance();
  expect(mounted.result.current.state).toBe('live');
  expect(mounted.result.current.reconciliationRevision).toBe(1);
});

it('recovers a retired page join on a real online event with a fresh binding and no shared socket bounce', async () => {
  const mounted = renderHook(() => useUserThemeRealtime('fixture-user'));
  await advance();
  const socket = NativeSocketFixture.instances[0];
  act(() => socket.open());
  await advance();
  const retired = state.client!.getChannels()[0];
  await advance(60_000);
  expect(mounted.result.current.state).toBe('error');
  expect(retired.state).toBe('closed');
  expect(state.client!.getChannels()).toEqual([]);
  act(() => window.dispatchEvent(new Event('online')));
  await advance();
  expect(state.client!.getChannels()).toHaveLength(1);
  expect(state.client!.getChannels()[0]).not.toBe(retired);
  expect(NativeSocketFixture.instances).toHaveLength(1);
  const joins = socket.sent.filter((message) => message.event === 'phx_join');
  expect(joins).toHaveLength(2);
  expect(joins[1].ref).not.toBe(joins[0].ref);
  const current = joins[1];
  act(() =>
    socket.onmessage?.({
      data: JSON.stringify({
        topic: current.topic,
        event: 'phx_reply',
        ref: current.ref,
        payload: {
          status: 'ok',
          response: {
            postgres_changes: current.payload.config.postgres_changes.map((filter: unknown) => ({
              ...(filter as object),
              id: 1,
            })),
          },
        },
      }),
    })
  );
  await advance();
  expect(mounted.result.current.state).toBe('live');
  expect(mounted.result.current.reconciliationRevision).toBe(1);
});

it('reconciles again after a real channel error retires a previously live binding', async () => {
  const mounted = renderHook(() => useUserThemeRealtime('fixture-user'));
  await advance();
  const socket = NativeSocketFixture.instances[0];
  act(() => socket.open());
  await advance();
  act(() => acknowledge(socket));
  await advance();
  expect(mounted.result.current.reconciliationRevision).toBe(1);
  const retired = state.client!.getChannels()[0];
  act(() =>
    socket.onmessage?.({
      data: JSON.stringify({ topic: retired.topic, event: 'phx_error', payload: {} }),
    })
  );
  await advance();
  expect(mounted.result.current.state).toBe('error');
  expect(retired.state).toBe('closed');
  act(() => window.dispatchEvent(new Event('online')));
  await advance();
  const join = socket.sent.filter((message) => message.event === 'phx_join').at(-1)!;
  act(() =>
    socket.onmessage?.({
      data: JSON.stringify({
        topic: join.topic,
        event: 'phx_reply',
        ref: join.ref,
        payload: {
          status: 'ok',
          response: {
            postgres_changes: join.payload.config.postgres_changes.map((filter: unknown) => ({
              ...(filter as object),
              id: 1,
            })),
          },
        },
      }),
    })
  );
  await advance();
  expect(mounted.result.current.state).toBe('live');
  expect(mounted.result.current.reconciliationRevision).toBe(2);
  expect(NativeSocketFixture.instances).toHaveLength(1);
});
