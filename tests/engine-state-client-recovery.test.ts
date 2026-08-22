/**
 * EngineStateClient — the recovery paths that shipped with no tests.
 *
 * The 2026-08-22 connectivity rounds rewrote how this client survives a bad
 * link, and the handoff recorded the gap honestly: "no dedicated client unit
 * tests were added for the new EngineStateClient logic... this logic is pinned
 * only by review." Every case below is a real frozen-table path that reached
 * production once.
 *
 * The channel client's wake grace is here too, because it is the same bug seen
 * from the other side: the game socket learned that a full clock reset on wake
 * lets a half-open socket live forever, and the channel socket had the opposite
 * half — no reset at all, so a backgrounded tab tore down a healthy link.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState = 0;
  sent: string[] = [];
  closedWith: Array<{ code?: number; reason?: string }> = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: ((e: { code?: number; reason?: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.closedWith.push({ code, reason });
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  _open() {
    this.readyState = 1;
    this.onopen?.();
  }
  _frame(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  _serverClose(code: number) {
    this.readyState = 3;
    this.onclose?.({ code, reason: 'server' });
  }
}

const TABLE = 'aaaaaaaa-2222-4222-8222-222222222222';
const flush = () => new Promise((r) => setTimeout(r, 0));

let EngineStateClient: typeof import('../src/services/EngineStateClient').EngineStateClient;
let EngineChannelClient: typeof import('../src/services/EngineStateClient').EngineChannelClient;
let CLOSE_MUX_SUPERSEDED: number;

beforeEach(async () => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const mod = await import('../src/services/EngineStateClient');
  EngineStateClient = mod.EngineStateClient;
  EngineChannelClient = mod.EngineChannelClient;
  // 4901 is owned by EngineSocketMux; EngineStateClient imports it rather
  // than re-exporting it, so read it from its actual home.
  CLOSE_MUX_SUPERSEDED = (await import('../src/services/EngineSocketMux')).CLOSE_MUX_SUPERSEDED;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function client(over: Partial<Record<string, unknown>> = {}) {
  const statuses: string[] = [];
  const errors: Array<{ code?: number; reason?: string }> = [];
  const c = new EngineStateClient({
    baseUrl: 'https://engine.example',
    tableId: TABLE,
    getToken: async () => 'tok',
    onSnapshot: () => undefined,
    onStatus: (s: string) => statuses.push(s),
    onError: (e: { code?: number; reason?: string }) => errors.push(e),
    ...(over as Record<string, never>),
  });
  return { c, statuses, errors };
}

const live = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

describe('EngineStateClient — a socket that never finishes connecting', () => {
  it('tears down a handshake stuck in CONNECTING instead of waiting forever', async () => {
    const { c } = client();
    c.connect();
    await flush();
    const ws = live();
    expect(ws.readyState).toBe(FakeWebSocket.CONNECTING);

    // Never call _open(). Before the handshake timer, this socket sat in
    // CONNECTING for the life of the page and the table never recovered.
    await vi.advanceTimersByTimeAsync(16_000);

    expect(ws.closedWith.length).toBeGreaterThan(0);
    c.disconnect();
  });
});

describe('EngineStateClient — close codes that are not all the same', () => {
  it('stands down on 4901 rather than fighting the mux for the socket', async () => {
    const { c } = client();
    c.connect();
    await flush();
    live()._open();
    await flush();

    const before = FakeWebSocket.instances.length;
    live()._serverClose(CLOSE_MUX_SUPERSEDED);
    expect(CLOSE_MUX_SUPERSEDED).toBe(4901);
    await vi.advanceTimersByTimeAsync(40_000);

    // A reconnect here is the mutual-eviction ping-pong: both halves keep
    // evicting each other and neither ever holds a usable socket.
    expect(FakeWebSocket.instances.length).toBe(before);
    c.disconnect();
  });

  it('keeps retrying after 4404 — the engine returns it while rehydrating', async () => {
    const { c } = client();
    c.connect();
    await flush();
    live()._open();
    await flush();

    const before = FakeWebSocket.instances.length;
    // 4404 for ~2 minutes after every engine restart is normal, and treating
    // it as terminal left the table dead until a manual refresh.
    live()._serverClose(4404);
    await vi.advanceTimersByTimeAsync(40_000);

    expect(FakeWebSocket.instances.length).toBeGreaterThan(before);
    c.disconnect();
  });
});

describe('EngineStateClient — a token that will not load', () => {
  it('retries a getToken() rejection instead of dying silently in connecting', async () => {
    let calls = 0;
    const { c, statuses } = client({
      getToken: async () => {
        calls++;
        if (calls === 1) throw new Error('session read failed');
        return 'tok';
      },
    });

    c.connect();
    await flush();
    // This was the worst frozen-table path of them all: the ladder ended, the
    // status stayed 'connecting', and the auto-reload failsafe never fired.
    await vi.advanceTimersByTimeAsync(40_000);

    expect(calls).toBeGreaterThan(1);
    expect(statuses).not.toEqual(['connecting']);
    c.disconnect();
  });
});

describe('EngineChannelClient — waking a backgrounded tab', () => {
  it('forgives a bounded debt on wake, not the whole clock', async () => {
    const c = new EngineChannelClient({
      baseUrl: 'https://engine.example',
      getToken: async () => 'tok',
    }) as unknown as {
      lastInboundAt: number;
      onVisibility: (() => void) | null;
      connect: () => void;
      disconnect: () => void;
    };
    c.connect();
    await flush();
    live()._open();
    await flush();

    // Simulate an hour in the background with the watchdog skipping its check.
    const longAgo = Date.now() - 60 * 60_000;
    c.lastInboundAt = longAgo;
    expect(c.onVisibility).not.toBeNull();
    c.onVisibility?.();

    const debt = Date.now() - c.lastInboundAt;
    // Forgiven: not an hour of silence, so the socket is not torn down on the
    // first tick back.
    expect(debt).toBeLessThan(60_000);
    // But NOT reset to zero — that is the hole that let a half-open socket
    // survive forever on the game side under frequent tab switching.
    expect(debt).toBeGreaterThan(0);
    (c as { disconnect: () => void }).disconnect();
  });
});
