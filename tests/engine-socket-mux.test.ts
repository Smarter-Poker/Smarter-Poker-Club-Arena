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
/** Read from the module rather than hard-coded, so bumping it is one edit. */
let PROTOCOL_VERSION: number;

beforeEach(async () => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
  vi.useFakeTimers();
  // Fresh module state per test — the mux is a singleton.
  vi.resetModules();
  ({ engineSocketMux, PROTOCOL_VERSION } = await import('../src/services/EngineSocketMux'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const lastSocket = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

describe('the warm subscription is adopted, not paid for twice', () => {
  /* Dan 2026-09-07: "TABLES ... SHOULD BE RUNNING AT ALL TIMES, AND PRE
     LOADED." The lobby warm-up gets SUBSCRIBE out while the player reads the
     buy-in sheet. Before this, the real join superseded that facade and waited
     out a SECOND SUBSCRIBE->SUBSCRIBED round-trip, so the client sat in
     'connecting' through a window the warm-up had already paid for. */

  it('a join behind an already-subscribed warm facade opens without a second ack', async () => {
    const warm = engineSocketMux.acquire('https://engine.example', T1, 'jwt');
    const ws = lastSocket();
    ws._open();
    ws._frame({ type: 'SUBSCRIBED', tableId: T1 });
    expect(warm.readyState).toBe(1);

    const live = engineSocketMux.acquire('https://engine.example', T1, 'jwt');
    expect(live.readyState).toBe(0); // never synchronous, like a real WebSocket
    await Promise.resolve(); // let the queued microtask run
    expect(live.readyState).toBe(1);
    expect(FakeWebSocket.instances.length).toBe(1); // still one physical socket
  });

  it('adoption does NOT skip the SUBSCRIBE - the server stays authoritative', async () => {
    engineSocketMux.acquire('https://engine.example', T1, 'jwt');
    const ws = lastSocket();
    ws._open();
    ws._frame({ type: 'SUBSCRIBED', tableId: T1 });
    const before = ws.sent.filter((s) => JSON.parse(s).type === 'SUBSCRIBE').length;

    engineSocketMux.acquire('https://engine.example', T1, 'jwt');
    await Promise.resolve();
    const after = ws.sent.filter((s) => JSON.parse(s).type === 'SUBSCRIBE').length;
    // Idempotent server-side, so re-sending costs nothing and a subscription
    // that has quietly gone away is re-established rather than assumed.
    expect(after).toBe(before + 1);
  });

  it('a cold acquire is unaffected and still waits for its own ack', () => {
    const cold = engineSocketMux.acquire('https://engine.example', T2, 'jwt');
    lastSocket()._open();
    expect(cold.readyState).toBe(0);
  });
});

describe('EngineSocketMux', () => {
  it('opens ONE physical socket for two tables and subscribes both on open', () => {
    const f1 = engineSocketMux.acquire('https://engine.example', T1, 'jwt');
    const f2 = engineSocketMux.acquire('https://engine.example', T2, 'jwt');
    expect(FakeWebSocket.instances.length).toBe(1);
    const ws = lastSocket();
    /* The protocol version joined this URL in Realtime Phase 4 (2026-09-05):
       the origin keeps old assets, so the engine has to be able to refuse a
       bundle it will not serve, and the URL is the one place all three sockets
       share. Asserted whole rather than loosened to a prefix - what this pin
       is for is that there is ONE socket and it goes to the right place, and
       that is still exactly what it says. */
    expect(ws.url).toBe(`wss://engine.example/ws/multi?v=${PROTOCOL_VERSION}`);
    ws._open();
    const subs = ws.sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'SUBSCRIBE');
    expect(subs.map((m) => m.tableId).sort()).toEqual([T1, T2].sort());
    // Facades open only on their own SUBSCRIBED ack.
    expect(f1.readyState).toBe(0);
    ws._frame({ type: 'SUBSCRIBED', tableId: T1 });
    expect(f1.readyState).toBe(1);
    expect(f2.readyState).toBe(0);
  });

  it('isSubscribed is true while a facade is live and false once closed', () => {
    // The lobby warm-up (services/tableWarmup) asks this before acquiring a
    // placeholder so it never supersedes a table a player is already at.
    expect(engineSocketMux.isSubscribed(T1)).toBe(false);
    const f1 = engineSocketMux.acquire('https://e', T1, 'jwt');
    expect(engineSocketMux.isSubscribed(T1)).toBe(true); // CONNECTING counts
    lastSocket()._open();
    engineSocketMux.acquire('https://e', T1, 'jwt'); // supersede - still owned
    expect(engineSocketMux.isSubscribed(T1)).toBe(true);
    f1.close();
    // The superseded facade was already closed; the live one still owns it.
    expect(engineSocketMux.isSubscribed(T1)).toBe(true);
    expect(engineSocketMux.isSubscribed(T2)).toBe(false);
  });

  it('late cleanup of a superseded facade cannot unsubscribe its replacement', () => {
    const old = engineSocketMux.acquire('https://e', T1, 'jwt');
    const ws = lastSocket();
    ws._open();
    ws._frame({ type: 'SUBSCRIBED', tableId: T1 });
    const current = engineSocketMux.acquire('https://e', T1, 'jwt');
    ws._frame({ type: 'SUBSCRIBED', tableId: T1 });
    const closed = vi.fn();
    const message = vi.fn();
    current.onclose = closed;
    current.onmessage = message;
    ws.sent = [];

    old.close();
    old.send(JSON.stringify({ type: 'RESYNC' }));
    ws._frame({ type: 'SNAPSHOT', tableId: T1, seq: 2, state: {} });

    expect(current.readyState).toBe(1);
    expect(engineSocketMux.isSubscribed(T1)).toBe(true);
    expect(closed).not.toHaveBeenCalled();
    expect(message).toHaveBeenCalledOnce();
    expect(ws.sent).toEqual([]);
    current.close();
    expect(engineSocketMux.isSubscribed(T1)).toBe(false);
    expect(ws.sent.map((s) => JSON.parse(s))).toEqual([{ type: 'UNSUBSCRIBE', tableId: T1 }]);
  });

  it.each([false, true])(
    'acquiring after browser sleep preserves the new facade (prior table: %s)',
    async (hadTable) => {
      engineSocketMux.prewarm('https://e', 'jwt');
      const stale = lastSocket();
      stale._open();
      if (hadTable) {
        engineSocketMux.acquire('https://e', T1, 'jwt');
        stale._frame({ type: 'SUBSCRIBED', tableId: T1 });
      }
      // A sleeping browser advances wall time without running watchdog timers.
      vi.setSystemTime(Date.now() + 61_000);
      const current = engineSocketMux.acquire('https://e', T1, 'jwt');
      const opened = vi.fn();
      current.onopen = opened;
      const fresh = lastSocket();
      expect(fresh).not.toBe(stale);
      await Promise.resolve();
      // A prior ack on the dead physical socket cannot authorize this one.
      expect(current.readyState).toBe(0);
      fresh._open();
      expect(fresh.sent.map((s) => JSON.parse(s))).toContainEqual({
        type: 'SUBSCRIBE',
        tableId: T1,
      });
      fresh._frame({ type: 'SUBSCRIBED', tableId: T1 });
      expect(current.readyState).toBe(1);
      expect(opened).toHaveBeenCalledOnce();
    }
  );

  it('reports constructor failure after acquire returns so the reconnect owner can hear it', async () => {
    vi.stubGlobal(
      'WebSocket',
      class extends FakeWebSocket {
        constructor(url: string, protocols?: unknown) {
          super(url, protocols);
          throw new Error('invalid WebSocket construction');
        }
      }
    );
    const facade = engineSocketMux.acquire('https://e', T1, 'jwt');
    const closed = vi.fn();
    facade.onclose = closed;
    await Promise.resolve();
    expect(closed).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledWith({
      code: 4500,
      reason: 'mux socket construction failed',
    });
    expect(facade.readyState).toBe(3);
  });

  it('a deferred construction failure cannot close a subsequent successful acquire', async () => {
    vi.stubGlobal(
      'WebSocket',
      class extends FakeWebSocket {
        constructor(url: string, protocols?: unknown) {
          super(url, protocols);
          throw new Error('first construction fails');
        }
      }
    );
    const failed = engineSocketMux.acquire('https://e', T1, 'jwt');
    const failedClose = vi.fn();
    failed.onclose = failedClose;
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const current = engineSocketMux.acquire('https://e', T1, 'jwt');
    const ws = lastSocket();
    ws._open();
    ws._frame({ type: 'SUBSCRIBED', tableId: T1 });
    await Promise.resolve();
    expect(failedClose).toHaveBeenCalledOnce();
    expect(current.readyState).toBe(1);
    expect(engineSocketMux.isSubscribed(T1)).toBe(true);
    failed.close();
    expect(current.readyState).toBe(1);
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
    // 2026-09-04: 60s -> 10 minutes, now that the socket can outlive 60s at
    // all (it answers its own PINGs; see the next case).
    // The server pings every 25s; feed those in, or the mux's own 60s
    // staleness watchdog (correctly) tears down a socket that has gone silent.
    for (let t = 0; t < 9.5 * 60_000; t += 25_000) {
      vi.advanceTimersByTime(25_000);
      ws._frame({ type: 'PING', ts: t });
    }
    expect(ws.readyState).toBe(1); // still lingering inside the window (9.5 min)
    vi.advanceTimersByTime(40_000);
    expect(ws.readyState).toBe(3); // closed after the linger window
  });

  /* ═══ THE SOCKET ANSWERS ITS OWN PINGS (2026-09-04) ══════════════════════
     The server closes any connection silent for 60s (heartbeatSweep, 1001).
     PONGs used to come only from facades' clients, so a pre-warmed socket
     with no facade - the lobby socket, which exists to be warm for the next
     table - was killed 60s after boot, and if a table had been opened on it
     in the meantime, that table went "Reconnecting To The Table" twenty
     seconds in. Measured in Dan's browser against production. */
  it('answers a PING itself, with no facade attached (the pre-warmed lobby socket)', () => {
    engineSocketMux.prewarm('https://e', 'jwt');
    const ws = lastSocket();
    ws._open();
    ws._frame({ type: 'PING', ts: 555 });
    const pongs = ws.sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'PONG');
    expect(pongs).toEqual([{ type: 'PONG', ts: 555 }]);
  });

  it('answers a PING exactly once however many facades are attached, and drops their duplicates', () => {
    const f1 = engineSocketMux.acquire('https://e', T1, 'jwt');
    const f2 = engineSocketMux.acquire('https://e', T2, 'jwt');
    // Each facade's client answers PING with PONG, as EngineStateClient does.
    f1.onmessage = (e) => {
      if (JSON.parse(e.data).type === 'PING') f1.send(JSON.stringify({ type: 'PONG', ts: 1 }));
    };
    f2.onmessage = (e) => {
      if (JSON.parse(e.data).type === 'PING') f2.send(JSON.stringify({ type: 'PONG', ts: 1 }));
    };
    const ws = lastSocket();
    ws._open();
    ws._frame({ type: 'PING', ts: 1 });
    const pongs = ws.sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'PONG');
    expect(pongs).toHaveLength(1);
    // and the facades still saw the PING (their staleness watchdogs stamp it)
  });
});

describe('warm table state survives entry', () => {
  it('delivers the warmed snapshot and ordered deltas before another server reply', async () => {
    const warm = engineSocketMux.acquire('https://engine.example', T1, 'jwt');
    warm.retainWarmState();
    const ws = lastSocket();
    ws._open();
    ws._frame({ type: 'SUBSCRIBED', tableId: T1 });
    const snapshot = { type: 'SNAPSHOT', tableId: T1, seq: 10, state: { pot: 20 } };
    const delta = { type: 'DELTA', tableId: T1, prev: 10, seq: 11, patch: [] };
    ws._frame(snapshot);
    ws._frame(delta);
    ws._frame({ type: 'USER_EVENT', tableId: T1, payload: { cards: ['As'] } });
    ws._frame({ type: 'EVENT', tableId: T1, payload: { type: 'throwable' } });
    const live = engineSocketMux.acquire('https://engine.example', T1, 'jwt');
    const delivered: unknown[] = [];
    live.onopen = () => delivered.push('open');
    live.onmessage = (event) => delivered.push(JSON.parse(event.data));
    await Promise.resolve();
    expect(delivered).toEqual(['open', snapshot, delta]);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it.each(['gap', 'restart', 'stale', 'overflow'])(
    'never adopts an invalid %s warm state',
    async (failure) => {
      const warm = engineSocketMux.acquire('https://engine.example', T1, 'jwt');
      warm.retainWarmState();
      const ws = lastSocket();
      ws._open();
      ws._frame({ type: 'SUBSCRIBED', tableId: T1 });
      ws._frame({ type: 'SNAPSHOT', tableId: T1, seq: 10, state: { pot: 20 } });
      if (failure === 'gap')
        ws._frame({ type: 'DELTA', tableId: T1, prev: 12, seq: 13, patch: [] });
      if (failure === 'restart')
        ws._frame({ type: 'EVENT', tableId: T1, payload: { type: 'engine_restarting' } });
      if (failure === 'stale') vi.advanceTimersByTime(15_001);
      if (failure === 'overflow')
        for (let seq = 11; seq < 150; seq++) {
          ws._frame({ type: 'DELTA', tableId: T1, prev: seq - 1, seq, patch: [] });
        }
      const live = engineSocketMux.acquire('https://engine.example', T1, 'jwt');
      const receive = vi.fn();
      live.onmessage = receive;
      await Promise.resolve();
      expect(receive).not.toHaveBeenCalled();
    }
  );
});

describe('speculative tables yield to real table entry', () => {
  it('releases speculative slots before subscribing a real table', () => {
    for (const id of ['warm1', 'warm2', 'warm3', 'warm4']) {
      expect(engineSocketMux.acquireWarm('https://engine.example', id, 'jwt')).not.toBeNull();
    }
    const ws = lastSocket();
    ws._open();
    ws.sent = [];
    const playing = engineSocketMux.acquire('https://engine.example', T1, 'jwt');
    expect(ws.sent.map((raw) => JSON.parse(raw).type)).toEqual([
      'UNSUBSCRIBE',
      'UNSUBSCRIBE',
      'UNSUBSCRIBE',
      'UNSUBSCRIBE',
      'SUBSCRIBE',
    ]);
    expect(playing.readyState).toBe(0);
    expect(engineSocketMux.isSubscribed(T1)).toBe(true);
  });

  it('never evicts one of four active tables for speculative loading', () => {
    for (const id of ['live1', 'live2', 'live3', 'live4']) {
      engineSocketMux.acquire('https://engine.example', id, 'jwt');
    }
    expect(engineSocketMux.acquireWarm('https://engine.example', T1, 'jwt')).toBeNull();
    for (const id of ['live1', 'live2', 'live3', 'live4'])
      expect(engineSocketMux.isSubscribed(id)).toBe(true);
  });

  it('never transfers cached state across authentication tokens', async () => {
    engineSocketMux.acquireWarm('https://engine.example', T1, 'jwt-first');
    const ws = lastSocket();
    ws._open();
    ws._frame({ type: 'SUBSCRIBED', tableId: T1 });
    ws._frame({ type: 'SNAPSHOT', tableId: T1, seq: 1, state: {} });
    const next = engineSocketMux.acquire('https://engine.example', T1, 'jwt-second');
    const receive = vi.fn();
    next.onmessage = receive;
    await Promise.resolve();
    expect(receive).not.toHaveBeenCalled();
  });
});

describe('physical transport identity', () => {
  it('reauthenticates an acquire instead of subscribing under the previous token', async () => {
    engineSocketMux.acquireWarm('https://engine.example', T1, 'jwt-first');
    const old = lastSocket();
    old._open();
    old._frame({ type: 'SUBSCRIBED', tableId: T1 });
    const next = engineSocketMux.acquire('https://engine.example', T1, 'jwt-second');
    await Promise.resolve();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(old.readyState).toBe(FakeWebSocket.CLOSED);
    expect(lastSocket().protocols).toEqual(['bearer', 'jwt-second']);
    expect(next.readyState).toBe(FakeWebSocket.CONNECTING);
    lastSocket()._open();
    lastSocket()._frame({ type: 'SUBSCRIBED', tableId: T1 });
    expect(next.readyState).toBe(FakeWebSocket.OPEN);
  });

  it('replaces a prewarm that is still connecting with a different token', () => {
    engineSocketMux.prewarm('https://engine.example', 'jwt-first');
    const old = lastSocket();
    engineSocketMux.prewarm('https://engine.example', 'jwt-second');
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(old.readyState).toBe(FakeWebSocket.CLOSED);
    expect(lastSocket().protocols).toEqual(['bearer', 'jwt-second']);
  });

  it('does not carry a subscription to a different engine origin', async () => {
    engineSocketMux.acquire('https://engine.example', T1, 'jwt');
    const old = lastSocket();
    old._open();
    old._frame({ type: 'SUBSCRIBED', tableId: T1 });
    const next = engineSocketMux.acquire('https://replacement.example', T1, 'jwt');
    await Promise.resolve();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(lastSocket().url).toContain('replacement.example');
    expect(next.readyState).toBe(FakeWebSocket.CONNECTING);
    old._frame({ type: 'SUBSCRIBED', tableId: T1 });
    expect(next.readyState).toBe(FakeWebSocket.CONNECTING);
  });
});

describe('foreground recovery belongs to the current table facade', () => {
  it('cannot close the replacement transport through a superseded facade', async () => {
    const old = engineSocketMux.acquire('https://engine.example', T1, 'jwt');
    const ws = lastSocket();
    ws._open();
    ws._frame({ type: 'SUBSCRIBED', tableId: T1 });
    const replacement = engineSocketMux.acquire('https://engine.example', T1, 'jwt');
    await Promise.resolve();
    old.recoverAfterUnansweredProbe(Date.now());
    expect(ws.readyState).toBe(FakeWebSocket.OPEN);
    expect(replacement.readyState).toBe(FakeWebSocket.OPEN);
  });

  it('keeps another table live when traffic proves the physical socket is responsive', async () => {
    const first = engineSocketMux.acquire('https://engine.example', T1, 'jwt');
    const second = engineSocketMux.acquire('https://engine.example', T2, 'jwt');
    const ws = lastSocket();
    ws._open();
    ws._frame({ type: 'SUBSCRIBED', tableId: T1 });
    ws._frame({ type: 'SUBSCRIBED', tableId: T2 });
    const startedAt = Date.now();
    await vi.advanceTimersByTimeAsync(1);
    ws._frame({ type: 'PING', ts: Date.now() });
    first.recoverAfterUnansweredProbe(startedAt);
    expect(first.readyState).toBe(FakeWebSocket.CLOSED);
    expect(second.readyState).toBe(FakeWebSocket.OPEN);
    expect(ws.readyState).toBe(FakeWebSocket.OPEN);
  });
});
