/**
 * A PAUSED TABLE SAYS SO - the client half (2026-10-15).
 *
 * The engine answers a tournament table its manager cannot admit with
 * TABLE_NOT_FOUND and the message 'tournament_table_paused'. The mux keeps the
 * 4404 (so the ladder keeps polling and rejoins when the table deals) and
 * closes the facade with its own reason, which the felt reads to say the table
 * is paused instead of "This Table Is No Longer Running". Every other refusal
 * keeps the reason it had. Server half: server/src/aPausedTableSaysSo.law.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: ((e: { code?: number; reason?: string }) => void) | null = null;
  constructor(
    public url: string,
    public protocols?: string | string[]
  ) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
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
}

const TABLE = 'bbbbbbbb-2222-4222-8222-222222222222';
const live = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
/** Every SUBSCRIBE for the table, on every physical socket: one per attempt. */
const subscribes = () =>
  FakeWebSocket.instances
    .flatMap((ws) => ws.sent)
    .map((s) => JSON.parse(s) as { type?: string; tableId?: string })
    .filter((m) => m.type === 'SUBSCRIBE' && m.tableId === TABLE).length;
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
/** The server pings every 25s; without it the mux rightly replaces a silent socket. */
async function tickWithPings(ms: number) {
  for (let done = 0; done < ms; done += 5_000) {
    if (live().readyState === 1) live()._frame({ type: 'PING', ts: Date.now() });
    await tick(Math.min(5_000, ms - done));
  }
}

let mod: typeof import('../src/services/EngineStateClient');

beforeEach(async () => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
  vi.useFakeTimers();
  // No jitter: the ladder's steps are then exact and the pins can be too.
  vi.spyOn(Math, 'random').mockReturnValue(0);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  // The mux is a module singleton that lingers its socket; see the note in
  // tests/engine-state-client-recovery.test.ts.
  vi.resetModules();
  mod = await import('../src/services/EngineStateClient');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function client() {
  const statuses: string[] = [];
  const errors: Array<{ code?: number; reason?: string }> = [];
  const c = new mod.EngineStateClient({
    baseUrl: 'https://engine.example',
    tableId: TABLE,
    getToken: async () => 'tok',
    onSnapshot: () => undefined,
    onStatus: (s) => statuses.push(s),
    onError: (e) => errors.push(e),
  });
  return { c, statuses, errors };
}

/** Connect and open the PHYSICAL socket; the table's facade is still unanswered. */
async function connectUnanswered() {
  const made = client();
  void made.c.connect();
  await tick(0);
  live()._open();
  await tick(0);
  expect(subscribes()).toBe(1);
  return made;
}
const refuse = async (code: string, message: string) => {
  live()._frame({ type: 'ERROR', tableId: TABLE, code, message });
  await tick(0);
};

describe('a paused tournament table is a 4404 that names the pause', () => {
  it('maps the paused message to its own reason, keeps polling, and says idle', async () => {
    const { c, statuses, errors } = await connectUnanswered();
    try {
      await refuse('TABLE_NOT_FOUND', 'tournament_table_paused');
      expect(errors.at(-1)).toEqual({
        code: 4404,
        reason: 'subscription refused: TOURNAMENT_TABLE_PAUSED',
      });
      expect(mod.isTournamentTablePausedClose(errors.at(-1)?.code, errors.at(-1)?.reason)).toBe(
        true
      );
      // Same ladder as any missing table: polled again, and rejoins when answered.
      await tick(1_000);
      expect(subscribes()).toBe(2);
      live()._frame({ type: 'SUBSCRIBED', tableId: TABLE });
      await tick(0);
      expect(statuses.at(-1)).toBe('connected');
      expect(statuses).not.toContain('failed');
    } finally {
      c.disconnect();
    }
  });

  it('an ordinary missing table keeps its old reason and is never read as paused', async () => {
    const { c, errors } = await connectUnanswered();
    try {
      await refuse('TABLE_NOT_FOUND', 'Table not found in engine');
      expect(errors.at(-1)).toEqual({
        code: 4404,
        reason: 'subscription refused: TABLE_NOT_FOUND',
      });
      expect(mod.isTournamentTablePausedClose(errors.at(-1)?.code, errors.at(-1)?.reason)).toBe(
        false
      );
    } finally {
      c.disconnect();
    }
  });

  it('only a 4404 can be a pause', () => {
    expect(
      mod.isTournamentTablePausedClose(4400, 'subscription refused: TOURNAMENT_TABLE_PAUSED')
    ).toBe(false);
    expect(mod.isTournamentTablePausedClose(4404, undefined)).toBe(false);
  });
});
