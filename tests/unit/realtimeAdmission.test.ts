import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeClient } from '@supabase/realtime-js';
import { RealtimeAdmission } from '../../src/lib/realtimeAdmission';
import { subscribeRealtime } from '../../src/lib/subscribeRealtime';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useMasterBusChannel } from '../../src/hooks/useMasterBusChannel';

const runtime = vi.hoisted(() => ({
  client: null as any,
  admission: null as any,
  factory: null as null | (() => void),
  channels: new Map<string, any>(),
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    getOrCreateChannel: (key: string) => {
      const channel = runtime.channels.get(key) ?? runtime.client.channel(key);
      runtime.channels.set(key, channel);
      return channel;
    },
    registerChannelFactory: (_key: string, factory: () => void) => {
      runtime.factory = factory;
    },
    removeChannelFactory: () => {
      runtime.factory = null;
    },
    removeRegisteredChannel: (key: string, expected?: unknown) => {
      const channel = runtime.channels.get(key);
      if (channel && (!expected || expected === channel)) {
        runtime.channels.delete(key);
        void runtime.client.removeChannel(channel);
      }
    },
  },
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    get realtime() {
      return runtime.client;
    },
  },
}));
vi.mock('../../src/lib/realtimeAdmission', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/realtimeAdmission')>()),
  realtimeAdmission: {
    ready: (client: any, signal: AbortSignal) => runtime.admission.ready(client, signal),
  },
}));

/** Actual locked SDK; the only replacement is the native network transport. */
class NativeSocketFixture extends EventTarget {
  static instances: NativeSocketFixture[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = NativeSocketFixture.CONNECTING;
  sent: Array<Record<string, any>> = [];
  replyHeartbeats = false;
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
    if (this.replyHeartbeats && message.event === 'heartbeat') this.reply(message);
  }

  reply(message: Record<string, any>) {
    const filters = message.payload?.config?.postgres_changes;
    this.onmessage?.({
      data: JSON.stringify({
        join_ref: message.join_ref,
        ref: message.ref,
        topic: message.topic,
        event: 'phx_reply',
        payload: {
          status: 'ok',
          response: filters?.length
            ? {
                postgres_changes: filters.map((filter: unknown, id: number) => ({
                  ...(filter as object),
                  id,
                })),
              }
            : {},
        },
      }),
    });
  }

  serverError(message: Record<string, any>) {
    this.onmessage?.({
      data: JSON.stringify({
        join_ref: message.join_ref,
        ref: null,
        topic: message.topic,
        event: 'phx_error',
        payload: {},
      }),
    });
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

const clients: RealtimeClient[] = [];
const syntheticToken = 'synthetic-fixture-token-not-a-credential';
function setup(accessToken = async () => syntheticToken) {
  const admission = new RealtimeAdmission(NativeSocketFixture as unknown as typeof WebSocket);
  const client = new RealtimeClient('wss://fixture.invalid/realtime/v1', {
    params: { apikey: 'synthetic-publishable-fixture' },
    transport: admission.transport,
    accessToken,
  });
  clients.push(client);
  runtime.client = client;
  runtime.admission = admission;
  return { admission, client, controller: new AbortController() };
}

beforeEach(() => {
  vi.useFakeTimers();
  NativeSocketFixture.instances = [];
  runtime.channels.clear();
  runtime.factory = null;
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.disconnect();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('Realtime transport admission before the SDK join budget', () => {
  it('keeps the actual hook recovery factory wired to a fresh delayed-acknowledgment owner', async () => {
    const { client } = setup();
    const statuses = vi.fn();
    const errors = vi.fn();
    const hook = renderHook(() =>
      useMasterBusChannel({
        channelName: 'club-data-delayed-owner',
        table: 'tables',
        filter: 'club_id=eq.fixture',
        event: '*',
        onPayload: vi.fn(),
        onSubscriptionStatus: statuses,
        onSubscriptionError: errors,
      })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const socket = NativeSocketFixture.instances[0];
    socket.replyHeartbeats = true;
    await act(async () => {
      socket.open();
      await vi.advanceTimersByTimeAsync(0);
    });
    const first = socket.sent.find((message) => message.event === 'phx_join')!;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_430);
      socket.reply(first);
    });
    expect(statuses).toHaveBeenLastCalledWith('SUBSCRIBED');
    act(() => socket.serverError(first));
    expect(errors).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(socket.sent.filter((message) => message.event === 'phx_join')).toHaveLength(1);
    expect(runtime.factory).toBeTypeOf('function');
    // Invoke the factory registered by the real hook, as its existing registry owner does.
    await act(async () => {
      runtime.factory!();
      await vi.advanceTimersByTimeAsync(0);
    });
    const second = socket.sent.filter((message) => message.event === 'phx_join')[1];
    expect(second.ref).not.toBe(first.ref);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_430);
      socket.reply(second);
    });
    expect(statuses.mock.calls.filter(([status]) => status === 'SUBSCRIBED')).toHaveLength(2);
    expect(errors).toHaveBeenCalledOnce();
    expect(client.timeout).toBe(10_000);
    hook.unmount();
    expect(runtime.factory).toBeNull();
  });

  it('accepts delayed acknowledgments before and after the existing owner replaces a failed binding', async () => {
    const { client, controller } = setup();
    const channel = client.channel('delayed-acknowledgment');
    const statuses: string[] = [];
    const pending = subscribeRealtime(
      channel,
      (status) => statuses.push(status),
      controller.signal
    );
    await vi.advanceTimersByTimeAsync(0);
    const socket = NativeSocketFixture.instances[0];
    socket.replyHeartbeats = true;
    socket.open();
    await pending;
    expect(client.timeout).toBe(10_000);
    expect(channel.timeout).toBe(60_000);
    const first = socket.sent.find((message) => message.event === 'phx_join')!;
    await vi.advanceTimersByTimeAsync(20_430);
    expect(statuses).toEqual([]);
    socket.reply(first);
    expect(statuses).toEqual(['SUBSCRIBED']);
    socket.serverError(first);
    expect(statuses).toEqual(['SUBSCRIBED', 'CHANNEL_ERROR']);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(socket.sent.filter((message) => message.event === 'phx_join')).toHaveLength(1);
    const replacement = client.channel('delayed-acknowledgment');
    expect(replacement).not.toBe(channel);
    await subscribeRealtime(replacement, (status) => statuses.push(status), controller.signal);
    const second = socket.sent.filter((message) => message.event === 'phx_join')[1];
    expect(second.ref).not.toBe(first.ref);
    await vi.advanceTimersByTimeAsync(20_430);
    expect(statuses).not.toContain('TIMED_OUT');
    socket.reply(second);
    expect(statuses.filter((status) => status === 'SUBSCRIBED')).toHaveLength(2);
    expect(client.timeout).toBe(10_000);
    expect(replacement.timeout).toBe(60_000);
  });

  it('still reports a missing channel acknowledgment at its finite calibrated deadline', async () => {
    const { client, controller } = setup();
    const statuses: string[] = [];
    const pending = subscribeRealtime(
      client.channel('missing-acknowledgment'),
      (status) => statuses.push(status),
      controller.signal
    );
    await vi.advanceTimersByTimeAsync(0);
    const socket = NativeSocketFixture.instances[0];
    socket.replyHeartbeats = true;
    socket.open();
    await pending;
    await vi.advanceTimersByTimeAsync(59_999);
    expect(statuses).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(statuses).toContain('TIMED_OUT');
    expect(statuses).not.toContain('SUBSCRIBED');
    expect(client.timeout).toBe(10_000);
  });

  it('reproduces the old immediate-subscribe timeout before a 15.164-second socket opens', async () => {
    const { client } = setup();
    const statuses: string[] = [];
    client.channel('before-admission-control').subscribe((status) => statuses.push(status));
    const socket = NativeSocketFixture.instances[0];
    await vi.advanceTimersByTimeAsync(10_001);
    expect(statuses).toContain('TIMED_OUT');
    expect(socket.readyState).toBe(NativeSocketFixture.CONNECTING);
    expect(socket.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(5_163);
    socket.open();
    expect(client.isConnected()).toBe(true);
  });

  it('admits a measured 15.164-second cold transport before starting an unchanged 10-second join', async () => {
    const { admission, client, controller } = setup();
    let ready = false;
    const pending = admission.ready(client, controller.signal).then(() => {
      ready = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    const socket = NativeSocketFixture.instances[0];
    expect(socket).toBeDefined();
    await vi.advanceTimersByTimeAsync(10_001);
    expect(ready).toBe(false);
    expect(socket.sent).toEqual([]);
    expect(client.getChannels()).toEqual([]);
    await vi.advanceTimersByTimeAsync(5_163);
    socket.open();
    await pending;
    expect(client.timeout).toBe(10_000);
    const statuses: string[] = [];
    client.channel('admitted-cold-join').subscribe((status) => statuses.push(status));
    expect(socket.sent[0].event).toBe('phx_join');
    expect(socket.sent[0].payload.access_token === syntheticToken).toBe(true);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(statuses).not.toContain('TIMED_OUT');
    await vi.advanceTimersByTimeAsync(1);
    expect(statuses).toContain('TIMED_OUT');
  });

  it('waits for authentication even when the shared transport opens first', async () => {
    let release!: (value: string) => void;
    const token = new Promise<string>((resolve) => {
      release = resolve;
    });
    const { admission, client, controller } = setup(() => token);
    let ready = false;
    const pending = admission.ready(client, controller.signal).then(() => {
      ready = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    NativeSocketFixture.instances[0].open();
    await vi.advanceTimersByTimeAsync(0);
    expect(ready).toBe(false);
    expect(client.getChannels()).toEqual([]);
    release(syntheticToken);
    await vi.advanceTimersByTimeAsync(0);
    await pending;
    expect(client.isConnected()).toBe(true);
  });

  it('retires a cancelled waiter without admitting a late open', async () => {
    const { admission, client, controller } = setup();
    const result = admission.ready(client, controller.signal).catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect((await result).name).toBe('AbortError');
    NativeSocketFixture.instances[0].open();
    await vi.advanceTimersByTimeAsync(20_001);
    expect(client.getChannels()).toEqual([]);
  });

  it('never opens a transport for an already-cancelled owner', async () => {
    const { admission, client, controller } = setup();
    controller.abort();
    await expect(admission.ready(client, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(NativeSocketFixture.instances).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains the authentication failure and removes its admission deadline', async () => {
    const { admission, controller } = setup();
    const error = new Error('Synthetic authentication unavailable');
    const client = {
      connect: vi.fn(),
      isConnected: () => false,
      setAuth: () => Promise.reject(error),
    };
    await expect(admission.ready(client, controller.signal)).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
    controller.abort();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['close', 'fail'] as const)(
    'settles a transport %s before opening',
    async (operation) => {
      const { admission, client, controller } = setup();
      const result = admission.ready(client, controller.signal).catch((error) => error);
      await vi.advanceTimersByTimeAsync(0);
      NativeSocketFixture.instances[0][operation]();
      expect(await result).toBeInstanceOf(Error);
      expect(client.getChannels()).toEqual([]);
    }
  );

  it('bounds an unopened transport at 20 seconds independently of the SDK join timeout', async () => {
    const { admission, client, controller } = setup();
    let settled = false;
    const result = admission.ready(client, controller.signal).catch((error) => {
      settled = true;
      return error;
    });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBeInstanceOf(Error);
    expect(client.timeout).toBe(10_000);
    expect(client.getChannels()).toEqual([]);
  });
});
