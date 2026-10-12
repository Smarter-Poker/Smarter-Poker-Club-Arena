// Synthetic transport identities explicitly retain a live durable session.
vi.mock('../services/PlayerSessionAccess.js', () => ({
  playerSessionVerdict: vi.fn(async () => 'alive'),
}));
/**
 * Lightning Phase 6 remediation (2026-10-01): closeRoom(tableId, reason)
 * closes every socket on an ended Lightning room. A single-table socket is
 * retired with 4404; a mux socket keeps its other tables and is unsubscribed
 * from this one with TABLE_NOT_FOUND. Presence hears each close.
 */
import { describe, expect, it, vi } from 'vitest';
vi.mock('../services/supabase.js', () => ({
  supabase: {
    rpc: vi.fn(),
    auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: null })) },
    from: vi.fn(() => ({ insert: vi.fn(async () => ({ error: null })) })),
  },
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
import { CLOSE_TABLE_NOT_FOUND, EngineWebSocketServer } from './EngineWebSocketServer.js';

type Handler = (...args: unknown[]) => void;
function fakeWs() {
  const handlers = new Map<string, Handler>();
  const sent: string[] = [];
  return {
    readyState: 1,
    bufferedAmount: 0,
    sent,
    send(data: string) {
      sent.push(data);
    },
    close: vi.fn(function (this: { readyState: number }) {
      this.readyState = 3;
    }),
    terminate: vi.fn(),
    on(event: string, cb: Handler) {
      handlers.set(event, cb);
    },
    emitMessage(obj: unknown) {
      handlers.get('message')?.(Buffer.from(JSON.stringify(obj)));
    },
  };
}

const ROOM = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('EngineWebSocketServer.closeRoom', () => {
  it('retires single-table sockets on the room with 4404 and unsubscribes mux sockets from it alone', async () => {
    const hub = { subscribe: vi.fn(), unsubscribe: vi.fn(), resync: vi.fn() };
    const onDisconnect = vi.fn();
    const server = new EngineWebSocketServer({
      hub: hub as never,
      tableExists: () => true,
      verifyToken: async () => ({ userId: 'user-1' }),
      authorizeConnection: async () => ({
        allowed: true,
        reason: 'seated',
        clubId: null,
        banned: false,
        ipRestricted: false,
      }),
      onDisconnect,
    } as never);
    (server as unknown as { logConnectionAudit: unknown }).logConnectionAudit = vi.fn();
    const single = fakeWs();
    const elsewhere = fakeWs();
    const mux = fakeWs();
    const s = server as unknown as {
      onUpgraded: (...a: unknown[]) => void;
      onUpgradedMux: (...a: unknown[]) => void;
    };
    s.onUpgraded(single, {}, 'user-1', ROOM);
    s.onUpgraded(elsewhere, {}, 'user-2', OTHER);
    s.onUpgradedMux(mux, 'user-1', '1.2.3.4');
    mux.emitMessage({ type: 'SUBSCRIBE', tableId: ROOM });
    mux.emitMessage({ type: 'SUBSCRIBE', tableId: OTHER });
    await flush();
    expect(server.connectionCount()).toBe(3);

    expect(server.closeRoom(ROOM, 'Your Lightning Session Has Ended')).toBe(2);
    expect(single.close).toHaveBeenCalledWith(
      CLOSE_TABLE_NOT_FOUND,
      'Your Lightning Session Has Ended'
    );
    expect(elsewhere.close).not.toHaveBeenCalled();
    expect(mux.close).not.toHaveBeenCalled();
    const errors = mux.sent.map((m) => JSON.parse(m)).filter((m) => m.type === 'ERROR');
    expect(errors).toEqual([
      {
        type: 'ERROR',
        tableId: ROOM,
        code: 'TABLE_NOT_FOUND',
        message: 'Your Lightning Session Has Ended',
      },
    ]);
    expect(hub.unsubscribe.mock.calls.filter((c) => c[0] === ROOM)).toHaveLength(2);
    expect(hub.unsubscribe.mock.calls.filter((c) => c[0] === OTHER)).toHaveLength(0);
    expect(onDisconnect).toHaveBeenCalledWith(ROOM, 'user-1');
    expect(server.connectionCount()).toBe(2);
    // Nothing left on the room: a second close touches nothing.
    expect(server.closeRoom(ROOM)).toBe(0);
  });
});
