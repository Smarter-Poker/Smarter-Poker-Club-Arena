/**
 * A SILENT LINK IS ASKED TO PROVE ITSELF (2026-10-04)
 *
 * A link that dies without closing - Wi-Fi to cellular, a NAT that forgot the
 * flow - leaves the table socket reading OPEN. The socket's own watchdog asks
 * its first question after 35 seconds of silence and gives up at about 50,
 * and for all of that the felt looks live and is frozen. The heartbeat is a
 * second path to the same engine and notices in ten seconds, so two beats
 * with no answer now ask the socket to prove itself through the bounded wake
 * probe: one RESYNC, five seconds, then the ordinary reconnect ladder.
 *
 * The same change stops the page heartbeating a table it has already declared
 * no longer running (3,141 such 404s from two players in two days).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

const TABLE = 'aaaaaaaa-3333-4333-8333-333333333333';
const flush = () => new Promise((r) => setTimeout(r, 0));
const live = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
const resyncs = (ws: FakeWebSocket) =>
  ws.sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'RESYNC');

let EngineStateClient: typeof import('../src/services/EngineStateClient').EngineStateClient;

beforeEach(async () => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.resetModules();
  EngineStateClient = (await import('../src/services/EngineStateClient')).EngineStateClient;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function openTable() {
  const statuses: string[] = [];
  const c = new EngineStateClient({
    baseUrl: 'https://engine.example',
    tableId: TABLE,
    getToken: async () => 'tok',
    onSnapshot: () => undefined,
    onStatus: (s: string) => statuses.push(s),
  });
  void c.connect();
  await flush();
  const ws = live();
  ws._open();
  ws._frame({ type: 'SUBSCRIBED', tableId: TABLE });
  ws._frame({ type: 'SNAPSHOT', tableId: TABLE, seq: 1, state: { pot: 0 } });
  await flush();
  return { c, ws, statuses };
}

describe('EngineStateClient.probeLink', () => {
  it('a dead link is found in five seconds, not fifty', async () => {
    const { c, ws, statuses } = await openTable();
    try {
      const before = resyncs(ws).length;
      c.probeLink();
      expect(resyncs(ws)).toHaveLength(before + 1);
      await vi.advanceTimersByTimeAsync(4_900);
      expect(statuses).not.toContain('reconnecting');
      await vi.advanceTimersByTimeAsync(200);
      expect(statuses.at(-1)).toBe('reconnecting');
    } finally {
      c.disconnect();
    }
  });

  it('a link that answers is left exactly as it was', async () => {
    const { c, ws, statuses } = await openTable();
    try {
      const sockets = FakeWebSocket.instances.length;
      c.probeLink();
      await vi.advanceTimersByTimeAsync(1_000);
      ws._frame({ type: 'SNAPSHOT', tableId: TABLE, seq: 1, state: { pot: 0 } });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(statuses).not.toContain('reconnecting');
      expect(FakeWebSocket.instances).toHaveLength(sockets);
    } finally {
      c.disconnect();
    }
  });

  it('asking twice is one question with one deadline', async () => {
    const { c, ws, statuses } = await openTable();
    try {
      const before = resyncs(ws).length;
      c.probeLink();
      await vi.advanceTimersByTimeAsync(3_000);
      c.probeLink();
      expect(resyncs(ws)).toHaveLength(before + 1);
      await vi.advanceTimersByTimeAsync(2_100);
      expect(statuses.at(-1)).toBe('reconnecting');
    } finally {
      c.disconnect();
    }
  });

  it('does nothing for a hidden page or a client that is not connected', async () => {
    const { c, ws } = await openTable();
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    try {
      visibility.mockReturnValue('hidden');
      const before = resyncs(ws).length;
      c.probeLink();
      expect(resyncs(ws)).toHaveLength(before);
      visibility.mockReturnValue('visible');
      c.disconnect();
      c.probeLink();
      expect(resyncs(ws)).toHaveLength(before);
    } finally {
      visibility.mockRestore();
      c.disconnect();
    }
  });
});

describe('the table page wires the heartbeat to the probe', () => {
  const strip = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const page = strip(readFileSync(resolve(__dirname, '../src/pages/TablePage.tsx'), 'utf8'));
  const hook = strip(
    readFileSync(resolve(__dirname, '../src/hooks/useEngineTableState.ts'), 'utf8')
  );
  const beat = page.slice(page.indexOf('const beat = async () => {'));
  const beatBody = beat.slice(0, beat.indexOf('setInterval(() => void beat(), 5000)'));

  it('the hook exposes probeLink and the page takes it', () => {
    expect(hook).toMatch(
      /probeLink = useCallback\(\(\) => clientRef\.current\?\.probeLink\(\), \[\]\)/
    );
    expect(page).toMatch(/probeLink: probeEngineLink,/);
  });

  it('the second unanswered beat in a row asks, once, and only when no answer came at all', () => {
    expect(beatBody).toMatch(
      /if \(consecutiveMisses === 2 && res\?\.code === HEARTBEAT_NOT_DELIVERED\) \{\s*probeEngineLinkRef\.current\?\.\(\);/
    );
    // A pre-start seat-first table's 404 is expected and returns first.
    expect(beatBody.indexOf('seatFirstOpenRef.current')).toBeLessThan(
      beatBody.indexOf('consecutiveMisses === 2')
    );
  });

  it('a table the page has declared no longer running is not heartbeated', () => {
    expect(beatBody).toMatch(/^\s*if \(tableClosedToastShownRef\.current\) return;/m);
    expect(beatBody.indexOf('tableClosedToastShownRef.current')).toBeLessThan(
      beatBody.indexOf('await sendHeartbeat(')
    );
    // The flag is released when the socket connects again, so a table that
    // comes back is beaten again.
    expect(page).toMatch(
      /if \(engineWsStatus === 'connected'\) \{\s*notFoundCountRef\.current = 0;\s*tableClosedToastShownRef\.current = false;/
    );
  });
});
