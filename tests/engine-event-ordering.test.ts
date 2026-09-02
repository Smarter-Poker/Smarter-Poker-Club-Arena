/**
 * SHOWDOWN POLISH 2026-08-25 — EVENT/SNAPSHOT ordering is deterministic.
 *
 * The engine deliberately emits the `showdown` event BEFORE the revealing
 * snapshot so the client latches the reveal-order stagger before any card
 * turns face up. But event dispatch is deferred one macrotask (the Task-56
 * one-render-per-event fix), while state frames used to apply synchronously —
 * so whenever both frames landed in one tick the snapshot overtook the event
 * and the sequenced reveal silently degraded to a simultaneous flip.
 *
 * The fix (review revision 2026-08-25): ONE unified inbound FIFO. Every frame
 * that arrives while anything is queued joins the queue; a state frame with an
 * empty queue keeps the zero-latency synchronous fast path. The drain applies
 * contiguous state frames synchronously and dispatches at most one EVENT per
 * macrotask (the Task-56 one-render-per-event guarantee), and the hub's
 * per-table event `seq` is consumed for same-connection de-duplication. These
 * tests pin all of it: arrival order = observation order in BOTH directions,
 * one dispatch per event, dedupe, and a reconnect clearing the queue.
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
  close() {
    this.readyState = 3;
    this.onclose?.({});
  }
  _open() {
    this.readyState = 1;
    this.onopen?.();
  }
  _frame(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

const TABLE = 'bbbbbbbb-2222-4222-8222-333333333333';
const flush = () => new Promise((r) => setTimeout(r, 0));

let EngineStateClient: typeof import('../src/services/EngineStateClient').EngineStateClient;

beforeEach(async () => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
  // Force the direct-socket path so _frame drives handleMessage without the
  // mux facade in between (the ordering logic is identical on both).
  window.localStorage.setItem('ca_ws_mux', '0');
  vi.resetModules();
  const mod = await import('../src/services/EngineStateClient');
  EngineStateClient = mod.EngineStateClient;
});

afterEach(() => {
  window.localStorage.removeItem('ca_ws_mux');
  vi.unstubAllGlobals();
});

const live = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

async function connectedClient() {
  const observed: string[] = [];
  const c = new EngineStateClient({
    baseUrl: 'https://engine.example',
    tableId: TABLE,
    getToken: async () => 'tok',
    onSnapshot: (s: Record<string, unknown>) => {
      observed.push(`snapshot:${(s as { hand_number?: number }).hand_number ?? '?'}`);
    },
    onEvent: (p: Record<string, unknown>) => {
      observed.push(`event:${String(p.type)}`);
    },
    onStatus: () => undefined,
    onError: () => undefined,
  } as never);
  c.connect();
  await flush();
  live()._open();
  await flush();
  return { c, observed };
}

describe('EngineStateClient — server emit order is client observation order', () => {
  it('an event emitted before a snapshot is observed before it, same-tick arrival included', async () => {
    const { c, observed } = await connectedClient();
    // Same JS tick: the exact race the showdown reveal lost.
    live()._frame({ type: 'EVENT', tableId: TABLE, seq: 1, payload: { type: 'showdown' } });
    live()._frame({ type: 'SNAPSHOT', tableId: TABLE, seq: 10, state: { hand_number: 7 } });
    await flush();
    await flush();
    expect(observed).toEqual(['event:showdown', 'snapshot:7']);
    c.disconnect();
  });

  it('multiple pending events all precede the snapshot, in order, one dispatch each', async () => {
    const { c, observed } = await connectedClient();
    live()._frame({ type: 'EVENT', tableId: TABLE, seq: 1, payload: { type: 'pot_win' } });
    live()._frame({ type: 'EVENT', tableId: TABLE, seq: 2, payload: { type: 'hand_complete' } });
    live()._frame({ type: 'SNAPSHOT', tableId: TABLE, seq: 11, state: { hand_number: 8 } });
    await flush();
    await flush();
    await flush();
    expect(observed).toEqual(['event:pot_win', 'event:hand_complete', 'snapshot:8']);
    c.disconnect();
  });

  it('a snapshot with nothing pending still applies immediately', async () => {
    const { c, observed } = await connectedClient();
    live()._frame({ type: 'SNAPSHOT', tableId: TABLE, seq: 12, state: { hand_number: 9 } });
    // No flush needed — synchronous apply is the fast path.
    expect(observed).toEqual(['snapshot:9']);
    c.disconnect();
  });

  it('a snapshot arriving BEFORE an event is observed before it (fast path does not reorder)', async () => {
    const { c, observed } = await connectedClient();
    live()._frame({ type: 'SNAPSHOT', tableId: TABLE, seq: 13, state: { hand_number: 10 } });
    live()._frame({ type: 'EVENT', tableId: TABLE, seq: 1, payload: { type: 'showdown' } });
    await flush();
    await flush();
    expect(observed).toEqual(['snapshot:10', 'event:showdown']);
    c.disconnect();
  });

  it('interleaved E1/S1/E2 arrival order is preserved exactly', async () => {
    const { c, observed } = await connectedClient();
    live()._frame({ type: 'EVENT', tableId: TABLE, seq: 1, payload: { type: 'showdown' } });
    live()._frame({ type: 'SNAPSHOT', tableId: TABLE, seq: 14, state: { hand_number: 11 } });
    live()._frame({ type: 'EVENT', tableId: TABLE, seq: 2, payload: { type: 'pot_win' } });
    await flush();
    await flush();
    await flush();
    expect(observed).toEqual(['event:showdown', 'snapshot:11', 'event:pot_win']);
    c.disconnect();
  });

  it('a duplicated event seq is dispatched once (hub seq de-duplication)', async () => {
    const { c, observed } = await connectedClient();
    live()._frame({ type: 'EVENT', tableId: TABLE, seq: 5, payload: { type: 'showdown' } });
    live()._frame({ type: 'EVENT', tableId: TABLE, seq: 5, payload: { type: 'showdown' } });
    live()._frame({ type: 'EVENT', tableId: TABLE, seq: 6, payload: { type: 'pot_win' } });
    await flush();
    await flush();
    await flush();
    expect(observed).toEqual(['event:showdown', 'event:pot_win']);
    c.disconnect();
  });

  it('legacy events without seq are never de-duplicated', async () => {
    const { c, observed } = await connectedClient();
    live()._frame({ type: 'EVENT', tableId: TABLE, payload: { type: 'player_action' } });
    live()._frame({ type: 'EVENT', tableId: TABLE, payload: { type: 'player_action' } });
    await flush();
    await flush();
    expect(observed).toEqual(['event:player_action', 'event:player_action']);
    c.disconnect();
  });

  it('disconnect clears the queue — a queued event never fires after teardown', async () => {
    const { c, observed } = await connectedClient();
    live()._frame({ type: 'EVENT', tableId: TABLE, seq: 1, payload: { type: 'showdown' } });
    live()._frame({ type: 'EVENT', tableId: TABLE, seq: 2, payload: { type: 'pot_win' } });
    await flush(); // first event dispatches…
    c.disconnect(); // …then the client tears down with one still queued
    await flush();
    await flush();
    expect(observed).toEqual(['event:showdown']);
  });
});
