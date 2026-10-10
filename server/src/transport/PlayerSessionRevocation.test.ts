import { describe, expect, it, vi } from 'vitest';
vi.mock('../services/supabase.js', () => ({ supabase: {} }));
vi.mock('../services/PlayerSessionAccess.js', () => ({ playerSessionVerdict: vi.fn() }));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
import { reportError } from '../services/errorReporter.js';
import { playerSessionVerdict } from '../services/PlayerSessionAccess.js';
import { EngineWebSocketServer } from './EngineWebSocketServer.js';
import { ChannelWebSocketServer } from './ChannelWebSocketServer.js';
describe('initial single-table private admission', () => {
  function admission() {
    const server = Object.create(EngineWebSocketServer.prototype);
    const handlers = new Map<string, (...args: any[]) => void>();
    const ws = {
      readyState: 1,
      bufferedAmount: 0,
      close: vi.fn(),
      send: vi.fn(),
      on: vi.fn((event: string, handler: (...args: any[]) => void) => handlers.set(event, handler)),
    };
    server.connections = new Map();
    server.refuseIfOverSocketCap = vi.fn(() => false);
    server.hub = { subscribe: vi.fn() };
    server.resyncPlayer = vi.fn();
    server.notifyConnect = vi.fn();
    return { server, ws, handlers };
  }
  it.each(['revoked', 'unknown', 'alive'] as const)(
    'rechecks the durable %s grant after upgrade authorization before initial replay',
    async (verdict) => {
      let finish!: (value: typeof verdict) => void;
      vi.mocked(playerSessionVerdict).mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      );
      const { server, ws, handlers } = admission();
      server.onUpgraded(ws, {}, 'target', 'table', null, 'old');
      expect([...handlers.keys()]).toEqual(['message', 'close', 'error']);
      expect(server.resyncPlayer).not.toHaveBeenCalled();
      expect(server.notifyConnect).not.toHaveBeenCalled();
      finish(verdict);
      await new Promise((resolve) => setImmediate(resolve));
      expect(playerSessionVerdict).toHaveBeenCalledWith('target', 'old');
      expect(server.resyncPlayer).toHaveBeenCalledTimes(verdict === 'alive' ? 1 : 0);
      expect(server.notifyConnect).toHaveBeenCalledTimes(verdict === 'alive' ? 1 : 0);
      expect(ws.close).toHaveBeenCalledTimes(verdict === 'revoked' ? 1 : 0);
    }
  );
  it.each(['disconnect', 'replacement', 'shutdown'])(
    'discards a late initial alive verdict after %s',
    async (mode) => {
      let finish!: (value: 'alive') => void;
      vi.mocked(playerSessionVerdict).mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      );
      const { server, ws } = admission();
      server.onUpgraded(ws, {}, 'target', 'table', null, 'old');
      if (mode === 'disconnect') server.connections.delete(ws);
      if (mode === 'replacement')
        server.connections.set(ws, { ...server.connections.get(ws), token: 'new' });
      if (mode === 'shutdown') server.closing = true;
      finish('alive');
      await new Promise((resolve) => setImmediate(resolve));
      expect(server.resyncPlayer).not.toHaveBeenCalled();
      expect(server.notifyConnect).not.toHaveBeenCalled();
    }
  );
  it('reports an initial delivery callback failure without an unhandled rejection', async () => {
    vi.mocked(reportError).mockClear();
    vi.mocked(playerSessionVerdict).mockResolvedValue('alive');
    const { server, ws } = admission();
    const failure = new Error('initial replay failed');
    server.resyncPlayer.mockImplementation(() => {
      throw failure;
    });
    server.onUpgraded(ws, {}, 'target', 'table', null, 'old');
    await new Promise((resolve) => setImmediate(resolve));
    expect(reportError).toHaveBeenCalledWith(failure, 'EngineWS.initial_private_replay', {
      tableId: 'table',
    });
    expect(server.notifyConnect).not.toHaveBeenCalled();
  });
});
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
  it('reports a rejected authorized delivery and permits a later explicit resync', async () => {
    vi.mocked(reportError).mockClear();
    vi.mocked(playerSessionVerdict).mockResolvedValue('alive');
    const server = Object.create(EngineWebSocketServer.prototype);
    const ws = { readyState: 1, close: vi.fn() };
    const subscriber = {};
    const conn = {
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
    const failure = new Error('hub delivery failed');
    server.hub = {
      resync: vi.fn().mockImplementationOnce(() => {
        throw failure;
      }),
    };
    server.resyncPlayer = vi.fn();
    server.notifyAlive = vi.fn();
    const message = Buffer.from(JSON.stringify({ type: 'RESYNC', tableId: 'table' }));
    server.onMessage(conn, message);
    await new Promise((resolve) => setImmediate(resolve));
    expect(reportError).toHaveBeenCalledWith(failure, 'EngineWS.authorized_resync', {
      tableId: 'table',
    });
    expect(server.resyncPlayer).not.toHaveBeenCalled();
    expect(ws.close).not.toHaveBeenCalled();
    server.onMessage(conn, message);
    await new Promise((resolve) => setImmediate(resolve));
    expect(server.hub.resync).toHaveBeenCalledTimes(2);
    expect(server.resyncPlayer).toHaveBeenCalledOnce();
  });
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
