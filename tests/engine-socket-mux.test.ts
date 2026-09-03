/**
 * EngineSocketMux — the client half of the /ws/multi beta (roadmap batch 6,
 * hardened in audit round 4).
 *
 * A fake global WebSocket lets these tests drive the physical socket's
 * lifecycle deterministically: subscribe-on-open, frame routing by tableId,
 * PING fan-out, per-table ERROR refusal, RESYNC rewriting, teardown on
 * physical close — and the round-4 fix: a superseded socket's late close
 * event must NOT kill the facades of its replacement.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Fake WebSocket ──────────────────────────────────────────────────────────

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  protocols: unknown;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: ((e: { code?: number; reason?: string }) => void) | null = null;

  constructor(url: string, protocols?: unknown) {
    this.url = url;
    this.protocols = protocols;
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code?: number, reason?: string) {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  // test drivers
  _open() {
    this.readyState = 1;
    this.onopen?.();
  }
  _frame(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  _serverClose(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code, reason: 'server' });
  }
}

const T1 = 'aaaaaaaa-1111-4111-8111-111111111111';
const T2 = 'bbbbbbbb-2222-4222-8222-222222222222';

let engineSocketMux: typeof import('../src/services/EngineSocketMux').engineSocketMux;

beforeEach(async () => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
  vi.useFakeTimers();
  // Fresh module state per test — the mux is a singleton.
  vi.resetModules();
  ({ engineSocketMux } = await import('../src/services/EngineSocketMux'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const lastSocket = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

describe('EngineSocketMux', () => {
  it('opens ONE physical socket for two tables and subscribes both on open', () => {
    const f1 = engineSocketMux.acquire('https://engine.example', T1, 'jwt');
    const f2 = engineSocketMux.acquire('https://engine.example', T2, 'jwt');
    expect(FakeWebSocket.instances.length).toBe(1);
    const ws = lastSocket();
    expect(ws.url).toBe('wss://engine.example/ws/multi');
    ws._open();
    const subs = ws.sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'SUBSCRIBE');
    expect(subs.map((m) => m.tableId).sort()).toEqual([T1, T2].sort());
    // Facades open only on their own SUBSCRIBED ack.
    expect(f1.readyState).toBe(0);
    ws._frame({ type: 'SUBSCRIBED', tableId: T1 });
    expect(f1.readyState).toBe(1);
    expect(f2.readyState).toBe(0);
  });

  it('routes frames by tableId and fans PING out to every facade', () => {
    const seen: Record<string, string[]> = { [T1]: [], [T2]: [] };
    const f1 = engineSocketMux.acquire('https://e', T1, 'jwt');
    const f2 = engineSocketMux.acquire('https://e', T2, 'jwt');
    f1.onmessage = (e) => seen[T1].push(JSON.parse(e.data).type);
    f2.onmessage = (e) => seen[T2].push(JSON.parse(e.data).type);
    const ws = lastSocket();
    ws._open();
    ws._frame({ type: 'SNAPSHOT', tableId: T1, seq: 1, state: {} });
    ws._frame({ type: 'DELTA', tableId: T2, seq: 2, prev: 1, patch: [] });
    ws._frame({ type: 'PING', ts: 123 });
    expect(seen[T1]).toEqual(['SNAPSHOT', 'PING']);
    expect(seen[T2]).toEqual(['DELTA', 'PING']);
  });

  it("rewrites a facade's plain RESYNC to carry its tableId", () => {
    const f1 = engineSocketMux.acquire('https://e', T1, 'jwt');
    const ws = lastSocket();
    ws._open();
    f1.send(JSON.stringify({ type: 'RESYNC' }));
    const resync = ws.sent.map((s) => JSON.parse(s)).find((m) => m.type === 'RESYNC');
    expect(resync).toEqual({ type: 'RESYNC', tableId: T1 });
  });

  it('a per-table ERROR closes only that facade', () => {
    const f1 = engineSocketMux.acquire('https://e', T1, 'jwt');
    const f2 = engineSocketMux.acquire('https://e', T2, 'jwt');
    const closed: string[] = [];
    f1.onclose = () => closed.push(T1);
    f2.onclose = () => closed.push(T2);
    const ws = lastSocket();
    ws._open();
    ws._frame({ type: 'SUBSCRIBED', tableId: T1 });
    ws._frame({ type: 'SUBSCRIBED', tableId: T2 });
    ws._frame({ type: 'ERROR', tableId: T2, code: 'BANNED', message: 'no' });
    expect(closed).toEqual([T2]);
    expect(f1.readyState).toBe(1);
  });

  it('physical close fails every facade; each reconnecting client gets a fresh socket', () => {
    const f1 = engineSocketMux.acquire('https://e', T1, 'jwt');
    const closes: number[] = [];
    f1.onclose = (e) => closes.push(e.code ?? -1);
    const ws = lastSocket();
    ws._open();
    ws._serverClose(1006);
    expect(closes).toEqual([1006]);
    // The client's backoff re-acquires - a NEW physical socket appears.
    engineSocketMux.acquire('https://e', T1, 'jwt2');
    expect(FakeWebSocket.instances.length).toBe(2);
  });

  it("AUDIT ROUND 4: a superseded socket's late close cannot kill the replacement's facades", () => {
    engineSocketMux.acquire('https://e', T1, 'jwt');
    const wsA = lastSocket();
    wsA._open();
    // The server starts closing A; readyState hits CLOSING before the close
    // event dispatches - exactly the window a reconnect lands in.
    wsA.readyState = 2;
    const f2 = engineSocketMux.acquire('https://e', T1, 'jwt');
    expect(FakeWebSocket.instances.length).toBe(2);
    const wsB = lastSocket();
    wsB._open();
    wsB._frame({ type: 'SUBSCRIBED', tableId: T1 });
    expect(f2.readyState).toBe(1);
    // A's close event finally arrives - it must be history, not news.
    wsA.onclose?.({ code: 1006, reason: 'late' });
    expect(f2.readyState).toBe(1);
  });

  it('releasing the last facade lingers, then closes the physical socket', () => {
    const f1 = engineSocketMux.acquire('https://e', T1, 'jwt');
    const ws = lastSocket();
    ws._open();
    f1.close();
    const unsub = ws.sent.map((s) => JSON.parse(s)).find((m) => m.type === 'UNSUBSCRIBE');
    expect(unsub).toEqual({ type: 'UNSUBSCRIBE', tableId: T1 });
    expect(ws.readyState).toBe(1); // lingering
    // 2026-08-24: linger raised 5s -> 60s. With the mux default-ON this socket
    // is the lobby connection; a player browsing between tables inside a
    // minute reuses it instead of paying a fresh TLS handshake.
    vi.advanceTimersByTime(59_000);
    expect(ws.readyState).toBe(1); // still lingering inside the window
    vi.advanceTimersByTime(1_100);
    expect(ws.readyState).toBe(3); // closed after the linger window
  });
});
