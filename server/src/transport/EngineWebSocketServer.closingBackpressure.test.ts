import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import {
  EngineWebSocketServer,
  type EngineWebSocketServerOptions,
} from './EngineWebSocketServer.js';
import { TableStateHub } from './TableStateHub.js';

const HARD = 4 * 1024 * 1024;
const TABLE_A = '11111111-1111-4111-8111-111111111111';
const TABLE_B = '22222222-2222-4222-8222-222222222222';
const allowed = {
  allowed: true,
  reason: 'club_member' as const,
  clubId: 'club',
  banned: false,
  ipRestricted: false,
};
class FakeWs {
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  handlers = new Map<string, (...args: unknown[]) => void>();
  close = vi.fn((_code?: number, _reason?: string) => {
    this.readyState = 2;
  });
  terminate = vi.fn(() => {
    this.readyState = 3;
    this.handlers.get('close')?.();
  });
  on(event: string, handler: (...args: unknown[]) => void) {
    this.handlers.set(event, handler);
  }
  send(data: string) {
    this.sent.push(data);
    this.bufferedAmount += Buffer.byteLength(data);
  }
  receive(message: unknown) {
    this.handlers.get('message')?.(Buffer.from(JSON.stringify(message)));
  }
}
interface Internals {
  onUpgradedMux(ws: unknown, userId: string, ip: string | null): void;
  onUpgraded(ws: unknown, req: unknown, userId: string, tableId: string, ip: string | null): void;
  heartbeatSweep(): void;
  connections: Map<WebSocket, unknown>;
}
let sockets: FakeWs[];
function fixture(overrides: Partial<EngineWebSocketServerOptions> = {}) {
  const hub = new TableStateHub();
  hub.publish(TABLE_A, { pot: 1 });
  hub.publish(TABLE_B, { pot: 1 });
  const authorize = vi.fn(async () => allowed);
  const onConnect = vi.fn(),
    onDisconnect = vi.fn(),
    onResync = vi.fn();
  const server = new EngineWebSocketServer({
    hub,
    tableExists: () => true,
    authorizeConnection: authorize,
    onConnect,
    onDisconnect,
    onResync,
    ...overrides,
  });
  const inner = server as unknown as Internals;
  const add = (user = 'hero') => {
    const ws = new FakeWs();
    sockets.push(ws);
    inner.onUpgradedMux(ws, user, '192.0.2.1');
    return ws;
  };
  return { server, inner, hub, authorize, onConnect, onDisconnect, onResync, add };
}
const subscribe = (ws: FakeWs, tableId = TABLE_A) => ws.receive({ type: 'SUBSCRIBE', tableId });
const flush = () => vi.advanceTimersByTimeAsync(0);
beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
});
afterEach(() => {
  for (const ws of sockets) ws.terminate();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('independent closing-before-pressure lifecycle', () => {
  it('physically terminates an overloaded already-closing registered socket within 250 ms', async () => {
    const f = fixture();
    const ws = f.add();
    subscribe(ws);
    await flush();
    expect(f.hub.subscriberCount(TABLE_A)).toBe(1);
    ws.bufferedAmount = HARD + 1;
    ws.close(1001, 'controlled prior graceful close');
    f.inner.heartbeatSweep();
    expect(f.server.connectionCount()).toBe(0);
    expect(f.hub.subscriberCount(TABLE_A)).toBe(0);
    await vi.advanceTimersByTimeAsync(250);
    console.log(
      'CLOSING_GUARD_CONTROL',
      JSON.stringify({
        registeredConnections: f.server.connectionCount(),
        bufferedAmount: ws.bufferedAmount,
        readyState: ws.readyState,
        terminated: ws.terminate.mock.calls.length,
      })
    );
    expect(ws.terminate).toHaveBeenCalledTimes(1);
  });
  it('does not repeat retirement when a closing socket receives another sweep', async () => {
    const f = fixture();
    const ws = f.add();
    ws.close(1001, 'controlled close');
    f.inner.heartbeatSweep();
    f.inner.heartbeatSweep();
    await vi.advanceTimersByTimeAsync(250);
    expect(ws.terminate).toHaveBeenCalledTimes(1);
    expect(f.server.connectionCount()).toBe(0);
  });
  it('does not schedule termination for an already closed socket', async () => {
    const f = fixture();
    const ws = f.add();
    ws.readyState = WebSocket.CLOSED;
    f.inner.heartbeatSweep();
    await vi.advanceTimersByTimeAsync(250);
    expect(ws.terminate).not.toHaveBeenCalled();
    expect(ws.close).not.toHaveBeenCalled();
    expect(f.server.connectionCount()).toBe(0);
  });
  it('closes an actual paused over-limit peer even when graceful close predates the guard', async () => {
    vi.useRealTimers();
    const http = createServer();
    const hub = new TableStateHub();
    const engine = new EngineWebSocketServer({
      hub,
      tableExists: () => true,
      verifyToken: async () => ({ userId: 'review-loopback-user' }),
      authorizeConnection: async () => allowed,
    });
    engine.attach(http);
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('missing loopback port');
    const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/multi`, [
      'bearer',
      'test.payload.signature',
    ]);
    let peer: WebSocket | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await once(client, 'open');
      peer = [...(engine as unknown as Internals).connections.keys()][0];
      const socket = (client as unknown as { _socket: { pause(): void; resume(): void } })._socket;
      socket.pause();
      const payload = Buffer.alloc(1024 * 1024, 120);
      for (let i = 0; i < 16 && peer.bufferedAmount <= HARD; i++) peer.send(payload);
      expect(peer.bufferedAmount).toBeGreaterThan(HARD);
      const queuedBytes = peer.bufferedAmount;
      peer.close(1001, 'controlled prior graceful close');
      expect(peer.readyState).toBe(WebSocket.CLOSING);
      const started = performance.now();
      const closed = once(peer, 'close');
      (engine as unknown as Internals).heartbeatSweep();
      const result = await Promise.race([
        closed.then(() => 'closed'),
        new Promise<string>((resolve) => {
          timeout = setTimeout(() => resolve('survived'), 2000);
          timeout.unref();
        }),
      ]);
      clearTimeout(timeout);
      console.log(
        'CLOSING_LOOPBACK_PROOF',
        JSON.stringify({
          queuedBytes,
          afterMs: Math.round(performance.now() - started),
          result,
          readyState: peer.readyState,
          retainedBufferedAmount: peer.bufferedAmount,
          registeredConnections: engine.connectionCount(),
        })
      );
      expect(result).toBe('closed');
      expect(peer.readyState).toBe(WebSocket.CLOSED);
      expect(engine.connectionCount()).toBe(0);
      socket.resume();
    } finally {
      clearTimeout(timeout);
      peer?.terminate();
      client.terminate();
      await engine.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      console.log(
        'CLOSING_LOOPBACK_CLEANUP',
        JSON.stringify({
          serverListening: http.listening,
          registeredConnections: engine.connectionCount(),
        })
      );
    }
  });
});
