import { describe, expect, it, vi } from 'vitest';
vi.mock('../services/supabase.js', () => ({ supabase: {} }));
vi.mock('../services/PlayerSessionAccess.js', () => ({ playerSessionVerdict: vi.fn() }));
import { playerSessionVerdict } from '../services/PlayerSessionAccess.js';
import { EngineWebSocketServer } from './EngineWebSocketServer.js';
import { ChannelWebSocketServer } from './ChannelWebSocketServer.js';
describe.each([EngineWebSocketServer, ChannelWebSocketServer])(
  'targeted socket session invalidation',
  (Server) => {
    it('closes only revoked target sessions, preserving new sign-ins and outage ambiguity', async () => {
      vi.mocked(playerSessionVerdict).mockImplementation(async (_user, token) =>
        token === 'old' ? 'revoked' : token === 'new' ? 'alive' : 'unknown'
      );
      const sockets = ['old', 'new', 'offline', 'other'].map(() => ({ close: vi.fn() }));
      const server = Object.create(Server.prototype);
      server.connections = new Map(
        sockets.map((ws, index) => [
          ws,
          {
            userId: index === 3 ? 'other-user' : 'target',
            token: ['old', 'new', 'offline', 'old'][index],
          },
        ])
      );
      await server.revokePlayerSessions('target');
      expect(sockets[0].close).toHaveBeenCalledWith(4401, 'auth:session_not_found');
      for (const socket of sockets.slice(1)) expect(socket.close).not.toHaveBeenCalled();
    });
  }
);

describe.each([EngineWebSocketServer, ChannelWebSocketServer])(
  'recovery grant fencing',
  (Server) => {
    it('recovers missed definitive revocation without closing unknown/new grants', async () => {
      vi.mocked(playerSessionVerdict).mockImplementation(async (_user, token) =>
        token === 'old' ? 'revoked' : token === 'new' ? 'alive' : 'unknown'
      );
      const server = Object.create(Server.prototype);
      const sockets = ['old', 'new', 'offline'].map(() => ({ close: vi.fn() }));
      server.connections = new Map(
        sockets.map((ws, index) => [
          ws,
          { ws, userId: 'target', token: ['old', 'new', 'offline'][index] },
        ])
      );
      await server.revalidatePlayerSessions();
      expect(sockets[0].close).toHaveBeenCalledWith(4401, 'auth:session_not_found');
      expect(sockets[1].close).not.toHaveBeenCalled();
      expect(sockets[2].close).not.toHaveBeenCalled();
    });
    it.each(['generation', 'replacement', 'shutdown'])(
      'rejects a late recovery verdict after %s',
      async (mode) => {
        let finish!: (value: 'revoked') => void;
        vi.mocked(playerSessionVerdict).mockImplementation(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            })
        );
        const server = Object.create(Server.prototype),
          ws = { close: vi.fn() };
        const conn = { ws, userId: 'target', token: 'old' };
        server.connections = new Map([[ws, conn]]);
        let current = true;
        const pending = server.revalidatePlayerSessions(() => current);
        if (mode === 'generation') current = false;
        if (mode === 'replacement') server.connections.set(ws, { ...conn, token: 'new' });
        if (mode === 'shutdown') server.closing = true;
        finish('revoked');
        await pending;
        expect(ws.close).not.toHaveBeenCalled();
      }
    );
    it('coalesces private admission reads and refuses unknown without signing out', async () => {
      let finish!: (value: 'unknown') => void;
      vi.mocked(playerSessionVerdict).mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      );
      const server = Object.create(Server.prototype),
        ws = { close: vi.fn() };
      const conn = { ws, userId: 'target', token: 'old' };
      server.connections = new Map([[ws, conn]]);
      const first = server.sessionCanReceive(conn),
        second = server.sessionCanReceive(conn);
      finish('unknown');
      expect(await first).toBe(false);
      expect(await second).toBe(false);
      expect(ws.close).not.toHaveBeenCalled();
      vi.mocked(playerSessionVerdict).mockResolvedValue('alive');
      expect(await server.sessionCanReceive(conn)).toBe(true);
    });
  }
);

describe.each([false, true])('explicit RESYNC private grant (mux=%s)', (isMux) => {
  it.each(['revoked', 'unknown', 'alive'] as const)(
    'uses current durable %s verdict before delivering private state',
    async (verdict) => {
      vi.mocked(playerSessionVerdict).mockResolvedValue(verdict);
      const server = Object.create(EngineWebSocketServer.prototype),
        ws = { readyState: 1, close: vi.fn() };
      const subscriber = {},
        conn = {
          ws,
          userId: 'target',
          token: 'old',
          tableId: 'table',
          isMux,
          subs: new Map([['table', subscriber]]),
          inboundWindowStart: Date.now(),
          inboundCount: 0,
        };
      (ws as any).__sub = subscriber;
      server.connections = new Map([[ws, conn]]);
      server.hub = { resync: vi.fn() };
      server.resyncPlayer = vi.fn();
      server.notifyAlive = vi.fn();
      server.onMessage(conn, Buffer.from(JSON.stringify({ type: 'RESYNC', tableId: 'table' })));
      await new Promise((resolve) => setImmediate(resolve));
      expect(server.resyncPlayer).toHaveBeenCalledTimes(verdict === 'alive' ? 1 : 0);
      expect(server.hub.resync).toHaveBeenCalledTimes(verdict === 'alive' ? 1 : 0);
      expect(ws.close).toHaveBeenCalledTimes(verdict === 'revoked' ? 1 : 0);
    }
  );
});
