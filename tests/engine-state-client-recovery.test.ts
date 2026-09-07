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
let shouldRecoverMissedHandStartPresentation: typeof import('../src/services/EngineStateClient').shouldRecoverMissedHandStartPresentation;
let HAND_START_GAP_RECOVERY_WINDOW_MS: number;
let CLOSE_MUX_SUPERSEDED: number;

beforeEach(async () => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
  vi.useFakeTimers({ shouldAdvanceTime: true });
  // 2026-08-24: RESET THE MODULE GRAPH BETWEEN TESTS.
  //
  // `engineSocketMux` is a module-level singleton, and the mux deliberately
  // LINGERS its physical socket after the last table is released so a player
  // switching tables reuses a warm connection instead of paying a fresh TLS
  // handshake. That linger is correct in production and poison across tests:
  // the socket survived into the next test, `ensureSocket()` saw an already-OPEN
  // connection and created nothing, and `live()` - which reads the most recent
  // FakeWebSocket, an array this hook has just emptied - returned undefined.
  //
  // It surfaced when the linger went from 5s to 60s: tests here advance the
  // clock 40s, which used to be long enough to expire the old socket by
  // accident. That made the isolation bug invisible rather than absent, and it
  // failed in CI while passing locally because `shouldAdvanceTime: true` lets
  // real elapsed time move the fake clock too, so the outcome depended on how
  // fast the machine was.
  //
  // resetModules gives each test its own EngineStateClient AND its own mux.
  // Both imports below happen after it, so they still share one module graph
  // and CLOSE_MUX_SUPERSEDED remains the identity the client actually compares.
  vi.resetModules();
  const mod = await import('../src/services/EngineStateClient');
  EngineStateClient = mod.EngineStateClient;
  EngineChannelClient = mod.EngineChannelClient;
  shouldRecoverMissedHandStartPresentation = mod.shouldRecoverMissedHandStartPresentation;
  HAND_START_GAP_RECOVERY_WINDOW_MS = mod.HAND_START_GAP_RECOVERY_WINDOW_MS;
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

  it('and says IDLE, not RECONNECTING, the whole time the table is missing (2026-09-04)', async () => {
    // Measured on production: a table the engine had closed sat under
    // "Reconnecting To The Table" for as long as the tab was open. The 4404
    // handler set 'idle' and scheduleReconnect() overwrote it one line later
    // with 'reconnecting', on every retry, forever.
    const { c, statuses } = client();
    c.connect();
    await flush();
    live()._open();
    await flush();
    statuses.length = 0;

    live()._serverClose(4404);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(statuses).toContain('idle');
    expect(statuses).not.toContain('reconnecting');
    expect(statuses).not.toContain('failed');

    // The table comes back: the flag clears and a normal connection reports.
    // Walk forward to the next attempt's fresh CONNECTING socket (the ladder
    // is on 30s+jitter steps and each attempt's handshake times out at 15s).
    for (let i = 0; i < 60 && live().readyState !== 0; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(live().readyState).toBe(0);
    live()._open();
    await flush();
    // Through the mux, the facade opens on the server's SUBSCRIBED.
    live()._frame({ type: 'SUBSCRIBED', tableId: TABLE });
    await flush();
    expect(statuses[statuses.length - 1]).toBe('connected');
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

describe('EngineStateClient — transient event continuity', () => {
  it('reports an EVENT sequence gap, resyncs, then delivers the real event separately', async () => {
    const events: Array<Record<string, unknown>> = [];
    const { c } = client({ onEvent: (event: Record<string, unknown>) => events.push(event) });
    void c.connect();
    await flush();
    const ws = live();
    ws._open();
    await flush();
    ws._frame({ type: 'SUBSCRIBED', tableId: TABLE });
    await flush();

    ws._frame({
      type: 'EVENT',
      tableId: TABLE,
      seq: 1,
      payload: { type: 'first_event' },
    });
    await vi.advanceTimersByTimeAsync(1);
    ws._frame({
      type: 'EVENT',
      tableId: TABLE,
      seq: 3,
      payload: { type: 'third_event' },
    });
    await vi.advanceTimersByTimeAsync(2);

    expect(events.map((event) => event.type)).toEqual([
      'first_event',
      'engine_event_gap',
      'third_event',
    ]);
    expect(events[1]).toMatchObject({
      reason: 'event_sequence_gap',
      expected_event_seq: 2,
      received_event_seq: 3,
    });
    expect(ws.sent.map((message) => JSON.parse(message))).toContainEqual({
      type: 'RESYNC',
      tableId: TABLE,
    });
    c.disconnect();
  });

  it('reports a reconnect boundary only after a table had authoritative state', async () => {
    const events: Array<Record<string, unknown>> = [];
    const { c } = client({ onEvent: (event: Record<string, unknown>) => events.push(event) });
    void c.connect();
    await flush();
    const first = live();
    first._open();
    await flush();
    first._frame({ type: 'SUBSCRIBED', tableId: TABLE });
    first._frame({
      type: 'SNAPSHOT',
      tableId: TABLE,
      seq: 7,
      state: { handNumber: 41 },
    });
    await flush();

    // First-connect hydration never emits a continuity notice.
    expect(events).toEqual([]);
    first._serverClose(1001);
    await vi.advanceTimersByTimeAsync(5_000);
    const second = live();
    expect(second).not.toBe(first);
    second._open();
    await flush();
    second._frame({ type: 'SUBSCRIBED', tableId: TABLE });
    await flush();

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'engine_event_gap', reason: 'reconnect' })
    );
    expect(second.sent.map((message) => JSON.parse(message))).toContainEqual({
      type: 'RESYNC',
      tableId: TABLE,
    });
    c.disconnect();
  });
});

describe('missed HAND_STARTED presentation recovery', () => {
  type RecoveryEvidence =
    import('../src/services/EngineStateClient').MissedHandStartPresentationEvidence;
  const openingSnapshot = (overrides: Partial<RecoveryEvidence> = {}): RecoveryEvidence => ({
    previousHandNumber: 40,
    handNumber: 41,
    continuityReportedAt: 1_000,
    transitionObservedAt: 1_050,
    now: 1_100,
    engineStage: 'preflop',
    communityCards: [],
    communityCards2: [],
    communityCards3: [],
    lastActions: [null, null, null],
    ...overrides,
  });

  it('permits only a fresh in-session opening snapshot with no action yet', () => {
    expect(shouldRecoverMissedHandStartPresentation(openingSnapshot())).toBe(true);
  });

  it('never rewinds a reconnect that lands mid-flop into the deal animation', () => {
    expect(
      shouldRecoverMissedHandStartPresentation(
        openingSnapshot({
          engineStage: 'flop',
          communityCards: [
            { rank: 'A', suit: 's' },
            { rank: 'K', suit: 'h' },
            { rank: '2', suit: 'd' },
          ],
        })
      )
    ).toBe(false);
  });

  it('never starts a late deal after preflop action has already happened', () => {
    expect(
      shouldRecoverMissedHandStartPresentation(openingSnapshot({ lastActions: ['call', null] }))
    ).toBe(false);
  });

  it('keeps first hydration still even when it looks like an untouched preflop', () => {
    expect(
      shouldRecoverMissedHandStartPresentation(openingSnapshot({ previousHandNumber: 0 }))
    ).toBe(false);
  });

  it('expires either side of a stale continuity boundary', () => {
    expect(
      shouldRecoverMissedHandStartPresentation(
        openingSnapshot({ now: 1_000 + HAND_START_GAP_RECOVERY_WINDOW_MS + 1 })
      )
    ).toBe(false);
    expect(
      shouldRecoverMissedHandStartPresentation(
        openingSnapshot({
          transitionObservedAt: 1_050,
          now: 1_050 + HAND_START_GAP_RECOVERY_WINDOW_MS + 1,
          continuityReportedAt: 1_049,
        })
      )
    ).toBe(false);
  });
});

describe('EngineChannelClient — heartbeat dialects (2026-08-24)', () => {
  it('answers CHANNEL_PING with CHANNEL_PONG (the server sweep only counted that)', async () => {
    const c = new EngineChannelClient({
      baseUrl: 'https://engine.example',
      getToken: async () => 'tok',
    });
    void c.connect();
    await flush();
    const ws = live();
    ws._open();
    await flush();
    ws._frame({ type: 'CHANNEL_PING', ts: 1 });
    const pongs = ws.sent
      .map((s) => JSON.parse(s) as { type: string })
      .filter((m) => m.type === 'CHANNEL_PONG');
    expect(pongs).toHaveLength(1);
    c.disconnect();
  });

  it('still answers plain PING with PONG', async () => {
    const c = new EngineChannelClient({
      baseUrl: 'https://engine.example',
      getToken: async () => 'tok',
    });
    void c.connect();
    await flush();
    const ws = live();
    ws._open();
    await flush();
    ws._frame({ type: 'PING', ts: 7 });
    const pongs = ws.sent
      .map((s) => JSON.parse(s) as { type: string; ts?: number })
      .filter((m) => m.type === 'PONG');
    expect(pongs).toHaveLength(1);
    expect(pongs[0]?.ts).toBe(7);
    c.disconnect();
  });
});

describe('EngineChannelClient — resubscribe on reconnect (2026-08-24)', () => {
  it('replays JOIN_CLUB / UPDATE_PRESENCE / JOIN_TOURNAMENT / JOIN_LOBBY on the new socket', async () => {
    const c = new EngineChannelClient({
      baseUrl: 'https://engine.example',
      getToken: async () => 'tok',
    });
    void c.connect();
    await flush();
    const first = live();
    first._open();
    await flush();

    c.send({ type: 'JOIN_CLUB', clubId: 'club-1' });
    c.send({ type: 'UPDATE_PRESENCE', clubId: 'club-1', status: 'at_table', currentTableId: 't1' });
    c.send({ type: 'JOIN_TOURNAMENT', tournamentId: 'tourney-1' });
    c.send({ type: 'JOIN_LOBBY' });
    // A club joined and then left must NOT be replayed.
    c.send({ type: 'JOIN_CLUB', clubId: 'club-2' });
    c.send({ type: 'LEAVE_CLUB', clubId: 'club-2' });

    // Server restarts: the socket dies, the client reconnects on backoff.
    first._serverClose(1001);
    await vi.advanceTimersByTimeAsync(5_000);
    const second = live();
    expect(second).not.toBe(first);
    second._open();
    await flush();

    const replayed = second.sent.map((s) => JSON.parse(s) as { type: string; clubId?: string });
    const types = replayed.map((m) => `${m.type}${m.clubId ? ':' + m.clubId : ''}`);
    expect(types).toContain('JOIN_CLUB:club-1');
    expect(types).toContain('UPDATE_PRESENCE:club-1');
    expect(types).toContain('JOIN_TOURNAMENT');
    expect(types).toContain('JOIN_LOBBY');
    expect(types).not.toContain('JOIN_CLUB:club-2');
    c.disconnect();
  });

  it('does NOT replay on the FIRST connect (the original JOINs are queued already)', async () => {
    const c = new EngineChannelClient({
      baseUrl: 'https://engine.example',
      getToken: async () => 'tok',
    });
    // Queued while offline — flushed on open. A replay on first connect would
    // send each JOIN twice.
    c.send({ type: 'JOIN_LOBBY' });
    await flush();
    const ws = live();
    ws._open();
    await flush();
    const joins = ws.sent
      .map((s) => JSON.parse(s) as { type: string })
      .filter((m) => m.type === 'JOIN_LOBBY');
    expect(joins).toHaveLength(1);
    c.disconnect();
  });

  it('onStatusChange reports the reconnect so surfaces can refetch missed state', async () => {
    const c = new EngineChannelClient({
      baseUrl: 'https://engine.example',
      getToken: async () => 'tok',
    });
    const seen: string[] = [];
    const unsub = c.onStatusChange((s) => seen.push(s));
    void c.connect();
    await flush();
    live()._open();
    await flush();
    live()._serverClose(1001);
    await vi.advanceTimersByTimeAsync(5_000);
    live()._open();
    await flush();
    expect(seen).toContain('reconnecting');
    expect(seen.filter((s) => s === 'connected').length).toBeGreaterThanOrEqual(2);
    unsub();
    c.disconnect();
  });
});

describe('EngineChannelClient — periodic subscription re-assert (2026-08-24)', () => {
  it('re-sends desired JOINs on a live socket every REASSERT interval', async () => {
    const c = new EngineChannelClient({
      baseUrl: 'https://engine.example',
      getToken: async () => 'tok',
    });
    void c.connect();
    await flush();
    const ws = live();
    ws._open();
    await flush();
    c.send({ type: 'JOIN_LOBBY' });
    c.send({ type: 'JOIN_TOURNAMENT', tournamentId: 'tt' });
    const countJoins = () =>
      ws.sent.map((s) => JSON.parse(s) as { type: string }).filter((m) => m.type === 'JOIN_LOBBY')
        .length;
    expect(countJoins()).toBe(1);

    // Keep the link "alive" so the watchdog never tears it down, and advance
    // past the re-assert interval: the JOIN must be sent again, unprompted.
    for (let i = 0; i < 20; i++) {
      ws._frame({ type: 'PING', ts: i });
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(countJoins()).toBeGreaterThanOrEqual(2);
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
