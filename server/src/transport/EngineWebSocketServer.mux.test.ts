/**
 * Roadmap batch 6 (2026-08-21) — /ws/multi multiplexed transport.
 *
 * Unit-level: drives the mux connection lifecycle against a fake hub and
 * fake sockets (no network). Covers subscribe gating (exists / ban / cap),
 * idempotent re-subscribe, per-table resync, unsubscribe, and close
 * tearing every subscription down.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit test: no network, no Sentry. The supabase client module initializes
// @sentry/node at import time; mock it before importing the server class.
vi.mock('../services/supabase.js', () => ({
  supabase: {
    auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: null })) },
    from: vi.fn(() => ({ insert: vi.fn(async () => ({ error: null })) })),
  },
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

import { EngineWebSocketServer } from './EngineWebSocketServer.js';

type Handler = (...args: unknown[]) => void;

function makeFakeWs() {
  const handlers = new Map<string, Handler>();
  const sent: string[] = [];
  return {
    readyState: 1,
    bufferedAmount: 0,
    sent,
    send(data: string) {
      sent.push(data);
    },
    close: vi.fn(),
    on(event: string, cb: Handler) {
      handlers.set(event, cb);
    },
    emitMessage(obj: unknown) {
      handlers.get('message')?.(Buffer.from(JSON.stringify(obj)));
    },
    emitClose() {
      handlers.get('close')?.();
    },
  };
}

function makeHub() {
  return {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    resync: vi.fn(),
  };
}

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';

function makeServer(overrides: Partial<Record<string, unknown>> = {}) {
  const hub = makeHub();
  const server = new EngineWebSocketServer({
    hub: hub as never,
    tableExists: (id: string) => id === T1 || id === T2,
    verifyToken: async () => ({ userId: 'user-1' }),
    authorizeViewer: async () => ({ allowed: true, reason: 'club_member', clubId: 'club-1' }),
    ...overrides,
  } as never);
  // Per-table async gates: default to "not banned / no conflict" so tests
  // exercise the happy path unless they override.
  (server as unknown as { isBannedFromTable: unknown }).isBannedFromTable = vi
    .fn()
    .mockResolvedValue(false);
  (server as unknown as { isIpConflict: unknown }).isIpConflict = vi.fn().mockResolvedValue(false);
  (server as unknown as { logConnectionAudit: unknown }).logConnectionAudit = vi.fn();
  return { server, hub };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('EngineWebSocketServer /ws/multi', () => {
  let server: EngineWebSocketServer;
  let hub: ReturnType<typeof makeHub>;
  let ws: ReturnType<typeof makeFakeWs>;

  beforeEach(() => {
    ({ server, hub } = makeServer());
    ws = makeFakeWs();
    (server as unknown as { onUpgradedMux: Handler }).onUpgradedMux(ws, 'user-1', '1.2.3.4');
  });

  it('SUBSCRIBE acks, subscribes the hub, and requests a hole-card resync', async () => {
    ws.emitMessage({ type: 'SUBSCRIBE', tableId: T1 });
    await flush();
    expect(hub.subscribe).toHaveBeenCalledTimes(1);
    expect(hub.subscribe.mock.calls[0][0]).toBe(T1);
    const acks = ws.sent.map((s) => JSON.parse(s));
    expect(acks.some((m) => m.type === 'SUBSCRIBED' && m.tableId === T1)).toBe(true);
  });

  it('re-SUBSCRIBE to the same table is idempotent: one hub.subscribe, ack + resync instead', async () => {
    ws.emitMessage({ type: 'SUBSCRIBE', tableId: T1 });
    await flush();
    ws.emitMessage({ type: 'SUBSCRIBE', tableId: T1 });
    await flush();
    expect(hub.subscribe).toHaveBeenCalledTimes(1);
    expect(hub.resync).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown table with TABLE_NOT_FOUND and no hub call', async () => {
    ws.emitMessage({ type: 'SUBSCRIBE', tableId: '33333333-3333-4333-8333-333333333333' });
    await flush();
    expect(hub.subscribe).not.toHaveBeenCalled();
    const errs = ws.sent.map((s) => JSON.parse(s));
    expect(errs.some((m) => m.type === 'ERROR' && m.code === 'TABLE_NOT_FOUND')).toBe(true);
  });

  it('wakes an authorized new empty table before subscribing', async () => {
    let running = false;
    const ensureTable = vi.fn(async (id: string) => {
      if (id !== T1) return false;
      running = true;
      return true;
    });
    const { server: wakeServer, hub: wakeHub } = makeServer({
      tableExists: () => running,
      ensureTable,
    });
    const wakeWs = makeFakeWs();
    (wakeServer as unknown as { onUpgradedMux: Handler }).onUpgradedMux(wakeWs, 'user-1', null);

    wakeWs.emitMessage({ type: 'SUBSCRIBE', tableId: T1 });
    await flush();

    expect(ensureTable).toHaveBeenCalledOnce();
    expect(ensureTable).toHaveBeenCalledWith(T1);
    expect(wakeHub.subscribe).toHaveBeenCalledOnce();
    expect(wakeWs.sent.map((s) => JSON.parse(s))).toContainEqual({
      type: 'SUBSCRIBED',
      tableId: T1,
    });
  });

  it('does not wake a table for a viewer who fails club access', async () => {
    const ensureTable = vi.fn(async () => true);
    const { server: deniedServer } = makeServer({
      tableExists: () => false,
      ensureTable,
      authorizeViewer: async () => ({
        allowed: false,
        reason: 'membership_required',
        clubId: 'club-1',
      }),
    });
    const deniedWs = makeFakeWs();
    (deniedServer as unknown as { onUpgradedMux: Handler }).onUpgradedMux(
      deniedWs,
      'outsider',
      null
    );

    deniedWs.emitMessage({ type: 'SUBSCRIBE', tableId: T1 });
    await flush();

    expect(ensureTable).not.toHaveBeenCalled();
  });

  it('rejects a non-member before any table state subscription', async () => {
    const { server: deniedServer, hub: deniedHub } = makeServer({
      authorizeViewer: async () => ({
        allowed: false,
        reason: 'membership_required',
        clubId: 'club-1',
      }),
    });
    const deniedWs = makeFakeWs();
    (deniedServer as unknown as { onUpgradedMux: Handler }).onUpgradedMux(
      deniedWs,
      'outsider',
      null
    );

    deniedWs.emitMessage({ type: 'SUBSCRIBE', tableId: T1 });
    await flush();

    expect(deniedHub.subscribe).not.toHaveBeenCalled();
    const errors = deniedWs.sent.map((message) => JSON.parse(message));
    expect(
      errors.some(
        (message) => message.type === 'ERROR' && message.code === 'CLUB_MEMBERSHIP_REQUIRED'
      )
    ).toBe(true);
  });

  it('rejects a banned user with BANNED and no hub call', async () => {
    (server as unknown as { isBannedFromTable: unknown }).isBannedFromTable = vi
      .fn()
      .mockResolvedValue(true);
    ws.emitMessage({ type: 'SUBSCRIBE', tableId: T1 });
    await flush();
    expect(hub.subscribe).not.toHaveBeenCalled();
    const errs = ws.sent.map((s) => JSON.parse(s));
    expect(errs.some((m) => m.type === 'ERROR' && m.code === 'BANNED')).toBe(true);
  });

  it('caps subscriptions at 4 with SUB_LIMIT', async () => {
    const ids = [
      T1,
      T2,
      '44444444-4444-4444-8444-444444444444',
      '55555555-5555-4555-8555-555555555555',
      '66666666-6666-4666-8666-666666666666',
    ];
    const { server: capServer, hub: capHub } = makeServer({
      tableExists: () => true,
    });
    const capWs = makeFakeWs();
    (capServer as unknown as { onUpgradedMux: Handler }).onUpgradedMux(capWs, 'user-1', null);
    for (const id of ids) {
      capWs.emitMessage({ type: 'SUBSCRIBE', tableId: id });
      await flush();
    }
    expect(capHub.subscribe).toHaveBeenCalledTimes(4);
    const errs = capWs.sent.map((s) => JSON.parse(s));
    expect(errs.some((m) => m.type === 'ERROR' && m.code === 'SUB_LIMIT')).toBe(true);
  });

  it('RESYNC is per-table and only for subscribed tables', async () => {
    ws.emitMessage({ type: 'SUBSCRIBE', tableId: T1 });
    await flush();
    hub.resync.mockClear();
    ws.emitMessage({ type: 'RESYNC', tableId: T1 });
    ws.emitMessage({ type: 'RESYNC', tableId: T2 }); // never subscribed
    expect(hub.resync).toHaveBeenCalledTimes(1);
    expect(hub.resync.mock.calls[0][0]).toBe(T1);
  });

  it('UNSUBSCRIBE removes exactly that table', async () => {
    ws.emitMessage({ type: 'SUBSCRIBE', tableId: T1 });
    await flush();
    ws.emitMessage({ type: 'SUBSCRIBE', tableId: T2 });
    await flush();
    ws.emitMessage({ type: 'UNSUBSCRIBE', tableId: T1 });
    expect(hub.unsubscribe).toHaveBeenCalledTimes(1);
    expect(hub.unsubscribe.mock.calls[0][0]).toBe(T1);
  });

  it('socket close tears down every subscription', async () => {
    ws.emitMessage({ type: 'SUBSCRIBE', tableId: T1 });
    await flush();
    ws.emitMessage({ type: 'SUBSCRIBE', tableId: T2 });
    await flush();
    ws.emitClose();
    expect(hub.unsubscribe).toHaveBeenCalledTimes(2);
    const tables = hub.unsubscribe.mock.calls.map((c) => c[0]).sort();
    expect(tables).toEqual([T1, T2]);
  });

  it('a BURST of subscribes cannot sail past the cap while pending (audit round 4)', async () => {
    const ids = [
      T1,
      T2,
      '44444444-4444-4444-8444-444444444444',
      '55555555-5555-4555-8555-555555555555',
      '66666666-6666-4666-8666-666666666666',
      '77777777-7777-4777-8777-777777777777',
    ];
    const { server: burstServer, hub: burstHub } = makeServer({ tableExists: () => true });
    const burstWs = makeFakeWs();
    (burstServer as unknown as { onUpgradedMux: Handler }).onUpgradedMux(burstWs, 'user-1', null);
    // No flush between sends - every gate is still in flight when the later
    // SUBSCRIBEs arrive, which is exactly the hole the settled-only count had.
    for (const id of ids) burstWs.emitMessage({ type: 'SUBSCRIBE', tableId: id });
    await flush();
    await flush();
    expect(burstHub.subscribe.mock.calls.length).toBeLessThanOrEqual(4);
    const errs = burstWs.sent.map((s) => JSON.parse(s));
    expect(errs.some((m) => m.type === 'ERROR' && m.code === 'SUB_LIMIT')).toBe(true);
  });

  it('action-like messages are ignored on the mux path (REST stays the only ingress)', async () => {
    ws.emitMessage({ type: 'SUBSCRIBE', tableId: T1 });
    await flush();
    const before = ws.sent.length;
    ws.emitMessage({ type: 'ACTION', tableId: T1, action: 'raise', amount: 999999 });
    await flush();
    expect(ws.sent.length).toBe(before);
    expect(hub.subscribe).toHaveBeenCalledTimes(1);
  });
});
