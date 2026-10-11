// Synthetic transport identities explicitly retain a live durable session.
vi.mock('../services/PlayerSessionAccess.js', () => ({
  playerSessionVerdict: vi.fn(async () => 'alive'),
}));
/**
 * A PONG OR RESYNC IS PROOF OF LIFE (2026-10-05).
 *
 * Only the HTTP /heartbeat and the socket's connect edge fed presence, so a
 * player whose HTTP beats were being lost while their socket answered every
 * PING was concluded gone after thirty seconds of HTTP silence. A PONG or a
 * RESYNC on an admitted table socket now reaches the engine as a heartbeat.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
const rpc = vi.hoisted(() => vi.fn());

// Unit test: no network, no error reporting. The supabase client module initializes
// @error-reporting/node at import time; mock it before importing the server class.
vi.mock('../services/supabase.js', () => ({
  supabase: {
    rpc,
    auth: {
      getUser: vi.fn(async () => ({ data: { user: null }, error: null })),
    },
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
    authorizeConnection: async () => ({
      allowed: true,
      reason: 'club_member',
      clubId: 'club-1',
      banned: false,
      ipRestricted: false,
    }),
    ...overrides,
  } as never);
  (server as unknown as { logConnectionAudit: unknown }).logConnectionAudit = vi.fn();
  return { server, hub };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('a socket that answers is a player who is here', () => {
  it('single-table path: PONG and RESYNC each report the table and player', async () => {
    const onAlive = vi.fn();
    const { server } = makeServer({ onAlive });
    const ws = makeFakeWs();
    (server as unknown as { onUpgraded: Handler }).onUpgraded(ws, {}, 'user-1', T1, '1.2.3.4');
    expect(onAlive).not.toHaveBeenCalled();
    ws.emitMessage({ type: 'PONG', ts: 1 });
    expect(onAlive).toHaveBeenLastCalledWith(T1, 'user-1');
    ws.emitMessage({ type: 'RESYNC' });
    await flush();
    expect(onAlive).toHaveBeenCalledTimes(2);
  });

  it('mux path: a PONG reports every admitted subscription, a RESYNC its own table', async () => {
    const onAlive = vi.fn();
    const { server } = makeServer({ onAlive });
    const ws = makeFakeWs();
    (server as unknown as { onUpgradedMux: Handler }).onUpgradedMux(ws, 'user-1', '1.2.3.4');
    ws.emitMessage({ type: 'PONG', ts: 1 });
    expect(onAlive).not.toHaveBeenCalled(); // nothing subscribed yet
    ws.emitMessage({ type: 'SUBSCRIBE', tableId: T1 });
    ws.emitMessage({ type: 'SUBSCRIBE', tableId: T2 });
    await flush();
    ws.emitMessage({ type: 'PONG', ts: 2 });
    expect(onAlive.mock.calls.map((c) => c[0]).sort()).toEqual([T1, T2].sort());
    onAlive.mockClear();
    ws.emitMessage({ type: 'RESYNC', tableId: T2 });
    await flush();
    expect(onAlive.mock.calls).toEqual([[T2, 'user-1']]);
  });

  it('an engine that throws never takes the socket down', () => {
    const { server } = makeServer({
      onAlive: () => {
        throw new Error('boom');
      },
    });
    const ws = makeFakeWs();
    (server as unknown as { onUpgraded: Handler }).onUpgraded(ws, {}, 'user-1', T1, '1.2.3.4');
    expect(() => ws.emitMessage({ type: 'PONG', ts: 1 })).not.toThrow();
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('index.ts wires it to the engine heartbeat', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const index = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8');
    const i = index.indexOf('onAlive: (tableId, userId) => {');
    expect(i).toBeGreaterThan(-1);
    expect(index.slice(i, index.indexOf('},', i))).toContain(
      'gameServer.getTableEngine(tableId)?.heartbeat(userId)'
    );
  });
});
