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

  constructor(
    url: string,
    public protocols?: string | string[]
  ) {
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

describe('EngineStateClient — heartbeats cannot acknowledge missing game state', () => {
  async function openTable() {
    const snapshots = vi.fn();
    const result = client({ onSnapshot: snapshots });
    result.c.connect();
    await flush();
    const ws = live();
    ws._open();
    ws._frame({ type: 'SUBSCRIBED', tableId: TABLE });
    await flush();
    return { ...result, ws, snapshots };
  }

  async function heartbeats(ws: FakeWebSocket, seconds: number) {
    for (let elapsed = 0; elapsed < seconds; elapsed += 5) {
      ws._frame({ type: 'PING', ts: Date.now() });
      await vi.advanceTimersByTimeAsync(5_000);
    }
  }

  const resyncs = (ws: FakeWebSocket) =>
    ws.sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'RESYNC');

  it('requests the missing first snapshot and reconnects despite continuing pings', async () => {
    const { c, ws, statuses } = await openTable();
    try {
      await heartbeats(ws, 40);
      expect(resyncs(ws).length).toBeGreaterThan(0);
      await heartbeats(ws, 25);
      expect(statuses).toContain('reconnecting');
    } finally {
      c.disconnect();
    }
  });

  it('bounds a resync after a sequence gap even when more unusable deltas arrive', async () => {
    const { c, ws, statuses } = await openTable();
    try {
      ws._frame({ type: 'SNAPSHOT', tableId: TABLE, seq: 1, state: { pot: 10 } });
      for (let i = 0; i < 13; i++) {
        ws._frame({ type: 'DELTA', tableId: TABLE, prev: 99, seq: 100, patch: [] });
        await heartbeats(ws, 5);
      }
      expect(resyncs(ws).length).toBeGreaterThan(0);
      expect(statuses).toContain('reconnecting');
    } finally {
      c.disconnect();
    }
  });

  it('accepts a resync snapshot at the same sequence and keeps an idle table connected', async () => {
    const { c, ws, statuses, snapshots } = await openTable();
    try {
      ws._frame({ type: 'SNAPSHOT', tableId: TABLE, seq: 1, state: { pot: 10 } });
      ws._frame({ type: 'DELTA', tableId: TABLE, prev: 99, seq: 100, patch: [] });
      await heartbeats(ws, 40);
      ws._frame({ type: 'SNAPSHOT', tableId: TABLE, seq: 1, state: { pot: 10 } });
      await heartbeats(ws, 90);
      expect(snapshots).toHaveBeenCalledTimes(2);
      expect(statuses).not.toContain('reconnecting');
    } finally {
      c.disconnect();
    }
  });

  it('does not let rejected stale snapshots acknowledge a resync', async () => {
    const { c, ws, statuses } = await openTable();
    try {
      ws._frame({ type: 'SNAPSHOT', tableId: TABLE, seq: 10, state: { pot: 10 } });
      ws._frame({ type: 'DELTA', tableId: TABLE, prev: 99, seq: 100, patch: [] });
      for (let i = 0; i < 13; i++) {
        ws._frame({ type: 'SNAPSHOT', tableId: TABLE, seq: 9, state: { pot: 0 } });
        await heartbeats(ws, 5);
      }
      expect(statuses).toContain('reconnecting');
    } finally {
      c.disconnect();
    }
  });

  it('waits for a replacement snapshot after an engine rebuild on the same socket', async () => {
    const { c, ws, statuses } = await openTable();
    try {
      ws._frame({ type: 'SNAPSHOT', tableId: TABLE, seq: 10, state: { pot: 10 } });
      ws._frame({ type: 'EVENT', tableId: TABLE, payload: { type: 'engine_restarting' } });
      await heartbeats(ws, 65);
      expect(statuses).toContain('reconnecting');
    } finally {
      c.disconnect();
    }
  });

  it('gives a backgrounded table time to answer its wake resync', async () => {
    const { c, ws, statuses } = await openTable();
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    try {
      visibility.mockReturnValue('hidden');
      await heartbeats(ws, 120);
      visibility.mockReturnValue('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      await heartbeats(ws, 5);
      expect(statuses).not.toContain('reconnecting');
      ws._frame({ type: 'SNAPSHOT', tableId: TABLE, seq: 1, state: { pot: 0 } });
      await heartbeats(ws, 90);
      expect(statuses).not.toContain('reconnecting');
    } finally {
      visibility.mockRestore();
      c.disconnect();
    }
  });

  it('cannot postpone a missing snapshot forever by repeatedly returning to the tab', async () => {
    const { c, ws, statuses } = await openTable();
    try {
      await heartbeats(ws, 35);
      for (let i = 0; i < 7; i++) {
        document.dispatchEvent(new Event('visibilitychange'));
        await heartbeats(ws, 5);
      }
      expect(statuses).toContain('reconnecting');
    } finally {
      c.disconnect();
    }
  });
});

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

  it('sends each desired JOIN once on the first connect', async () => {
    const c = new EngineChannelClient({
      baseUrl: 'https://engine.example',
      getToken: async () => 'tok',
    });
    // Offline state is replayed once, without a duplicate queued JOIN.
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

describe('EngineChannelClient subscription coalescing', () => {
  it('collapses repeated offline joins instead of flooding the server on open', async () => {
    const c = new EngineChannelClient({
      baseUrl: 'https://engine.example',
      getToken: async () => 'tok',
    });
    for (let i = 0; i < 100; i++) c.send({ type: 'JOIN_LOBBY' });
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = live();
    ws._open();
    expect(ws.sent.map((s) => JSON.parse(s))).toEqual([{ type: 'JOIN_LOBBY' }]);
    c.disconnect();
  });

  it('does not subscribe to rooms left before the first connection opened', async () => {
    const c = new EngineChannelClient({
      baseUrl: 'https://engine.example',
      getToken: async () => 'tok',
    });
    c.send({ type: 'JOIN_CLUB', clubId: 'gone' });
    c.send({ type: 'LEAVE_CLUB', clubId: 'gone' });
    c.send({ type: 'REQUEST_HAND_REPLAY', handId: 'hand-1' });
    await flush();
    const ws = live();
    ws._open();
    expect(ws.sent.map((s) => JSON.parse(s))).toEqual([
      { type: 'REQUEST_HAND_REPLAY', handId: 'hand-1' },
    ]);
    c.disconnect();
  });

  it('replays each desired join once after offline changes during a reconnect', async () => {
    const c = new EngineChannelClient({
      baseUrl: 'https://engine.example',
      getToken: async () => 'tok',
    });
    await c.connect();
    live()._open();
    live()._serverClose(1001);
    for (let i = 0; i < 40; i++) c.send({ type: 'JOIN_TOURNAMENT', tournamentId: 't1' });
    c.send({ type: 'REQUEST_HAND_REPLAY', handId: 'hand-2' });
    await flush();
    const ws = live();
    ws._open();
    expect(ws.sent.map((s) => JSON.parse(s))).toEqual([
      { type: 'JOIN_TOURNAMENT', tournamentId: 't1' },
      { type: 'REQUEST_HAND_REPLAY', handId: 'hand-2' },
    ]);
    c.disconnect();
  });
});

it('sends only the latest offline presence after its club join', async () => {
  const c = new EngineChannelClient({
    baseUrl: 'https://engine.example',
    getToken: async () => 'tok',
  });
  c.send({ type: 'UPDATE_PRESENCE', clubId: 'c1', status: 'online' });
  c.send({ type: 'UPDATE_PRESENCE', clubId: 'c1', status: 'away' });
  c.send({ type: 'UPDATE_PRESENCE', clubId: 'c1', status: 'at_table', currentTableId: TABLE });
  await flush();
  const ws = live();
  ws._open();
  expect(ws.sent.map((s) => JSON.parse(s))).toEqual([
    { type: 'JOIN_CLUB', clubId: 'c1' },
    { type: 'UPDATE_PRESENCE', clubId: 'c1', status: 'at_table', currentTableId: TABLE },
  ]);
  c.disconnect();
});

it('paints warmed engine state on entry before a second server snapshot', async () => {
  const { engineSocketMux } = await import('../src/services/EngineSocketMux');
  engineSocketMux.acquireWarm('https://engine.example', TABLE, 'tok');
  const ws = live();
  ws._open();
  ws._frame({ type: 'SUBSCRIBED', tableId: TABLE });
  ws._frame({ type: 'SNAPSHOT', tableId: TABLE, seq: 10, state: { pot: 20 } });
  ws._frame({
    type: 'DELTA',
    tableId: TABLE,
    prev: 10,
    seq: 11,
    patch: [{ op: 'replace', path: '/pot', value: 30 }],
  });
  const paint = vi.fn();
  const { c } = client({ onSnapshot: paint });
  await c.connect();
  await flush();
  expect(paint).toHaveBeenLastCalledWith({ pot: 30 }, 11);
  expect(FakeWebSocket.instances).toHaveLength(1);
  c.disconnect();
});

describe('EngineChannelClient handshake recovery', () => {
  function channel() {
    return new EngineChannelClient({
      baseUrl: 'https://engine.example',
      getToken: async () => 'tok',
      initialDelay: 100,
      maxDelay: 100,
    });
  }

  it('retries a blackholed handshake even when close never emits an event', async () => {
    const c = channel();
    c.send({ type: 'JOIN_LOBBY' });
    await flush();
    const stuck = live();
    // Browsers may defer close indefinitely during a failed network handshake.
    stuck.close = vi.fn();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(stuck.close).toHaveBeenCalled();
    expect(live()).not.toBe(stuck);
    const replacement = live();
    replacement._open();
    stuck.onclose?.({ code: 1006 });
    expect(c.getStatus()).toBe('connected');
    expect(replacement.sent.map((raw) => JSON.parse(raw).type)).toEqual(['JOIN_LOBBY']);
    c.disconnect();
  });

  it('cancels the handshake deadline after a successful open', async () => {
    const c = channel();
    await c.connect();
    const ws = live();
    ws._open();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(ws.closedWith).toEqual([]);
    expect(FakeWebSocket.instances).toHaveLength(1);
    c.disconnect();
  });

  it('does not reopen after disconnecting an unfinished handshake', async () => {
    const c = channel();
    await c.connect();
    const ws = live();
    c.disconnect();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(ws.closedWith).toHaveLength(1);
    expect(c.getStatus()).toBe('idle');
  });
});

describe.each(['table', 'channel'] as const)('%s connection auth ownership', (kind) => {
  function pendingToken() {
    let resolve!: (token: string) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<string>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  }

  function make(getToken: () => Promise<string>, onStatus = (_status: string) => {}) {
    return kind === 'table'
      ? client({ getToken, onStatus }).c
      : new EngineChannelClient({ baseUrl: 'https://engine.example', getToken, onStatus });
  }

  it('opens with fresh auth after reconnect while the old token is pending', async () => {
    const old = pendingToken();
    const fresh = pendingToken();
    const getToken = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const c = make(getToken);
    try {
      const first = c.connect();
      c.disconnect();
      const second = c.connect();
      expect(getToken).toHaveBeenCalledTimes(2);
      old.resolve('old-token');
      await first;
      expect(FakeWebSocket.instances).toHaveLength(0);
      // The obsolete attempt must not clear the new attempt's single-flight guard.
      await c.connect();
      expect(getToken).toHaveBeenCalledTimes(2);
      fresh.resolve('fresh-token');
      await second;
      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(live().protocols).toContain('fresh-token');
    } finally {
      old.resolve('old-token');
      fresh.resolve('fresh-token');
      c.disconnect();
    }
  });

  it('ignores a rejected token request from a disconnected lifecycle', async () => {
    const old = pendingToken();
    const getToken = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue('fresh-token');
    const statuses: string[] = [];
    const c = make(getToken, (status) => statuses.push(status));
    try {
      const first = c.connect();
      c.disconnect();
      await c.connect();
      const ws = live();
      expect(ws).toBeDefined();
      ws._open();
      if (kind === 'table') ws._frame({ type: 'SUBSCRIBED', tableId: TABLE });
      expect(statuses.at(-1)).toBe('connected');
      old.reject(new Error('obsolete token lookup'));
      await first;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(statuses.at(-1)).toBe('connected');
      expect(getToken).toHaveBeenCalledTimes(2);
      expect(FakeWebSocket.instances).toHaveLength(1);
    } finally {
      old.resolve('old-token');
      c.disconnect();
    }
  });
});

it('ignores a detached table socket close while replacement auth is pending', async () => {
  localStorage.setItem('ca_ws_mux', '0');
  let finish!: (token: string) => void;
  const pending = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const getToken = vi.fn().mockResolvedValueOnce('first-token').mockReturnValueOnce(pending);
  const { c, statuses } = client({ getToken });
  try {
    await c.connect();
    const old = live();
    old._open();
    c.disconnect();
    const next = c.connect();
    expect(statuses.at(-1)).toBe('connecting');
    // Browser close events may arrive well after close() was requested.
    old._serverClose(1006);
    expect(statuses.at(-1)).toBe('connecting');
    finish('replacement-token');
    await next;
    expect(live()).not.toBe(old);
    live()._open();
    expect(statuses.at(-1)).toBe('connected');
  } finally {
    finish('replacement-token');
    c.disconnect();
    localStorage.removeItem('ca_ws_mux');
  }
});

describe('token acquisition cannot strand either connection type', () => {
  it.each(['table', 'channel'])(
    '%s retries a hung token request and ignores its late result',
    async (kind) => {
      localStorage.setItem('ca_ws_mux', '0');
      let finishFirst!: (token: string) => void;
      const first = new Promise<string>((resolve) => {
        finishFirst = resolve;
      });
      const getToken = vi.fn().mockReturnValueOnce(first).mockResolvedValue('fresh-token');
      const onStatus = vi.fn();
      const c =
        kind === 'table'
          ? client({ getToken, onStatus, initialDelay: 1, maxDelay: 1 }).c
          : new EngineChannelClient({
              baseUrl: 'https://engine.example',
              getToken,
              onStatus,
              initialDelay: 1,
              maxDelay: 1,
            });
      try {
        void c.connect();
        await vi.advanceTimersByTimeAsync(16_000);
        expect(getToken).toHaveBeenCalledTimes(2);
        expect(FakeWebSocket.instances).toHaveLength(1);
        const ws = live();
        expect(ws.protocols).toEqual(['bearer', 'fresh-token']);
        ws._open();
        finishFirst('stale-token');
        await vi.advanceTimersByTimeAsync(1);
        expect(FakeWebSocket.instances).toHaveLength(1);
        expect(onStatus).toHaveBeenLastCalledWith('connected');
      } finally {
        c.disconnect();
        localStorage.removeItem('ca_ws_mux');
      }
    }
  );

  it.each(['table', 'channel'])(
    '%s cancels the token wait on disconnect without retrying',
    async (kind) => {
      const getToken = vi.fn(() => new Promise<string>(() => {}));
      const onStatus = vi.fn();
      const c =
        kind === 'table'
          ? client({ getToken, onStatus }).c
          : new EngineChannelClient({ baseUrl: 'https://engine.example', getToken, onStatus });
      const connected = c.connect();
      await vi.advanceTimersByTimeAsync(1);
      c.disconnect();
      await connected;
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(getToken).toHaveBeenCalledTimes(1);
      expect(FakeWebSocket.instances).toHaveLength(0);
      expect(onStatus).toHaveBeenLastCalledWith('idle');
    }
  );
});
