import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeClient } from '@supabase/realtime-js';
import { RealtimeAdmission } from '../../src/lib/realtimeAdmission';

/** Actual locked SDK; the only replacement is the native network transport. */
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
    this.sent.push(JSON.parse(encoded));
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
  return { admission, client, controller: new AbortController() };
}

beforeEach(() => {
  vi.useFakeTimers();
  NativeSocketFixture.instances = [];
});
afterEach(() => {
  for (const client of clients.splice(0)) client.disconnect();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('Realtime transport admission before the SDK join budget', () => {
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

it('transport-open observation resumes after the SDK handler and cancels queued or future opens', async () => {
  const { admission, client, controller } = setup();
  const states: boolean[] = [];
  const remove = admission.onReadinessChange(
    () => states.push(client.isConnected()),
    controller.signal
  );
  const pending = admission.ready(client, controller.signal);
  await vi.advanceTimersByTimeAsync(0);
  NativeSocketFixture.instances[0].open();
  await pending;
  expect(states).toEqual([true]);
  NativeSocketFixture.instances[0].open();
  remove();
  await vi.advanceTimersByTimeAsync(0);
  expect(states).toEqual([true]);
  const observer = vi.fn();
  admission.onReadinessChange(observer, controller.signal);
  controller.abort();
  NativeSocketFixture.instances[0].open();
  await vi.advanceTimersByTimeAsync(0);
  expect(observer).not.toHaveBeenCalled();
});
