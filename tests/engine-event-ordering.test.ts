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
 * The fix: a state frame arriving while events are pending requeues itself
 * behind them. These tests pin BOTH guarantees: server emit order end to end,
 * and one dispatch per event.
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
});
