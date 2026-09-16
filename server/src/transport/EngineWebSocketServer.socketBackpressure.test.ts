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
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
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

describe('the physical socket owns its hard backpressure fence', () => {
  it('refuses repeated overloaded subscriptions before authorization or control frames', async () => {
    const f = fixture();
    const ws = f.add();
    ws.bufferedAmount = HARD + 1;
    for (let i = 0; i < 30; i++) {
      subscribe(ws);
      await flush();
    }
    expect(f.authorize).not.toHaveBeenCalled();
    expect(ws.sent).toEqual([]);
    expect(ws.close).toHaveBeenCalledTimes(1);
    expect(ws.close).toHaveBeenCalledWith(4429, 'backpressure evict - reconnect');
    expect(f.server.connectionCount()).toBe(0);
    expect(f.hub.subscriberCount(TABLE_A)).toBe(0);
    expect(vi.getTimerCount()).toBe(1);
  });
  it('removes every table on the overloaded socket while retaining a healthy device', async () => {
    const f = fixture();
    const slow = f.add();
    const healthy = f.add();
    subscribe(slow, TABLE_A);
    subscribe(slow, TABLE_B);
    subscribe(healthy, TABLE_A);
    await flush();
    expect(f.hub.subscriberCount(TABLE_A)).toBe(2);
    expect(f.hub.subscriberCount(TABLE_B)).toBe(1);
    slow.bufferedAmount = HARD + 1;
    subscribe(slow);
    await flush();
    expect(f.server.connectionCount()).toBe(1);
    expect(f.hub.subscriberCount(TABLE_A)).toBe(1);
    expect(f.hub.subscriberCount(TABLE_B)).toBe(0);
    expect(f.onDisconnect.mock.calls).toEqual([[TABLE_B, 'hero']]);
    expect(healthy.close).not.toHaveBeenCalled();
    const before = healthy.sent.length;
    f.hub.publish(TABLE_A, { pot: 2 });
    expect(healthy.sent.length).toBe(before + 1);
  });
  it.each(['allow', 'deny', 'reject'])(
    'a late %s cannot revive an admission after physical retirement',
    async (kind) => {
      const pending = deferred<typeof allowed>();
      const authorize = vi.fn(() => pending.promise);
      const f = fixture({ authorizeConnection: authorize });
      const ws = f.add();
      subscribe(ws);
      await flush();
      ws.bufferedAmount = HARD + 1;
      subscribe(ws);
      await flush();
      if (kind === 'reject') pending.reject(new Error('read unavailable'));
      else pending.resolve(kind === 'allow' ? allowed : { ...allowed, allowed: false });
      await flush();
      expect(authorize).toHaveBeenCalledTimes(1);
      expect(ws.sent).toEqual([]);
      expect(f.hub.subscriberCount(TABLE_A)).toBe(0);
      expect(f.onConnect).not.toHaveBeenCalled();
      expect(f.server.connectionCount()).toBe(0);
    }
  );
  it('rechecks pressure after authorization before starting table wake work', async () => {
    const pending = deferred<typeof allowed>();
    const wake = vi.fn(async () => true);
    const f = fixture({
      authorizeConnection: () => pending.promise,
      tableExists: () => false,
      ensureTable: wake,
    });
    const ws = f.add();
    subscribe(ws);
    await flush();
    ws.bufferedAmount = HARD + 1;
    pending.resolve(allowed);
    await flush();
    expect(wake).not.toHaveBeenCalled();
    expect(ws.sent).toEqual([]);
    expect(ws.close).toHaveBeenCalledTimes(1);
  });
  it('rechecks pressure after table wake before acknowledging or subscribing', async () => {
    const wake = deferred<boolean>();
    const f = fixture({ tableExists: () => false, ensureTable: () => wake.promise });
    const ws = f.add();
    subscribe(ws);
    await flush();
    ws.bufferedAmount = HARD + 1;
    wake.resolve(true);
    await flush();
    expect(ws.sent).toEqual([]);
    expect(f.hub.subscriberCount(TABLE_A)).toBe(0);
    expect(f.onConnect).not.toHaveBeenCalled();
    expect(ws.close).toHaveBeenCalledTimes(1);
  });
  it('stops after an acknowledgement itself crosses the hard limit', async () => {
    const f = fixture();
    const ws = f.add();
    ws.bufferedAmount = HARD - 1;
    subscribe(ws);
    await flush();
    expect(ws.sent.map((raw) => JSON.parse(raw).type)).toEqual(['SUBSCRIBED']);
    expect(ws.close).toHaveBeenCalledTimes(1);
    expect(f.hub.subscriberCount(TABLE_A)).toBe(0);
    expect(f.onConnect).not.toHaveBeenCalled();
    expect(f.server.connectionCount()).toBe(0);
  });
  it('heartbeat retires an overloaded quiet socket without queuing another ping', () => {
    const f = fixture();
    const ws = f.add();
    ws.bufferedAmount = HARD + 1;
    f.inner.heartbeatSweep();
    expect(ws.sent).toEqual([]);
    expect(ws.close).toHaveBeenCalledTimes(1);
    expect(f.server.connectionCount()).toBe(0);
  });
  it('gives one close frame 250 ms to flush, then terminates a nonresponsive peer exactly once', async () => {
    const f = fixture();
    const ws = f.add();
    ws.bufferedAmount = HARD + 1;
    subscribe(ws);
    await flush();
    expect(ws.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(249);
    expect(ws.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ws.terminate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    subscribe(ws);
    f.inner.heartbeatSweep();
    expect(ws.close).toHaveBeenCalledTimes(1);
    expect(f.authorize).not.toHaveBeenCalled();
  });
  it('does not terminate a peer whose graceful close already completed', async () => {
    const f = fixture();
    const ws = f.add();
    ws.bufferedAmount = HARD + 1;
    subscribe(ws);
    await flush();
    ws.readyState = 3;
    ws.handlers.get('close')?.();
    await vi.advanceTimersByTimeAsync(250);
    expect(ws.terminate).not.toHaveBeenCalled();
    expect(f.server.connectionCount()).toBe(0);
  });
  it('terminates immediately when writing the close frame throws', async () => {
    const f = fixture();
    const ws = f.add();
    ws.close.mockImplementation(() => {
      throw new Error('broken socket');
    });
    ws.bufferedAmount = HARD + 1;
    subscribe(ws);
    await flush();
    expect(ws.terminate).toHaveBeenCalledTimes(1);
    expect(f.server.connectionCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('retires the connection if writing a control acknowledgement throws', async () => {
    const f = fixture();
    const ws = f.add();
    ws.send = () => {
      throw new Error('transport unavailable');
    };
    subscribe(ws);
    await flush();
    expect(ws.close).toHaveBeenCalledWith(1001, 'transport send failed');
    expect(f.server.connectionCount()).toBe(0);
    expect(f.hub.subscriberCount(TABLE_A)).toBe(0);
    expect(f.onConnect).not.toHaveBeenCalled();
  });
  it.each(['mux', 'single'])(
    'a private replay that crosses the physical limit cannot mark %s transport connected',
    async (mode) => {
      let ws: FakeWs;
      const f = fixture({
        onResync: () => {
          ws.bufferedAmount = HARD + 1;
        },
      });
      if (mode === 'mux') {
        ws = f.add();
        subscribe(ws);
        await flush();
      } else {
        ws = new FakeWs();
        sockets.push(ws);
        f.inner.onUpgraded(ws, {}, 'hero', TABLE_A, '192.0.2.1');
      }
      expect(f.onConnect).not.toHaveBeenCalled();
      expect(f.server.connectionCount()).toBe(0);
      expect(ws.close).toHaveBeenCalledTimes(1);
    }
  );
  it('a fresh physical connection can subscribe after its predecessor was retired', async () => {
    const f = fixture();
    const slow = f.add();
    slow.bufferedAmount = HARD + 1;
    subscribe(slow);
    await flush();
    const fresh = f.add();
    subscribe(fresh);
    await flush();
    expect(f.hub.subscriberCount(TABLE_A)).toBe(1);
    expect(f.authorize).toHaveBeenCalledTimes(1);
    expect(fresh.close).not.toHaveBeenCalled();
    expect(fresh.sent.map((raw) => JSON.parse(raw).type)).toEqual(['SUBSCRIBED', 'SNAPSHOT']);
  });
  it('uses the same physical cleanup when a single-table hub adapter is evicted', () => {
    const f = fixture();
    const ws = new FakeWs();
    sockets.push(ws);
    f.inner.onUpgraded(ws, {}, 'hero', TABLE_A, '192.0.2.1');
    ws.bufferedAmount = HARD + 1;
    f.hub.publish(TABLE_A, { pot: 2 });
    expect(f.server.connectionCount()).toBe(0);
    expect(f.hub.subscriberCount(TABLE_A)).toBe(0);
    expect(ws.close).toHaveBeenCalledTimes(1);
    expect(f.onDisconnect).toHaveBeenCalledWith(TABLE_A, 'hero');
  });
  it('does not publish callbacks or controls for a socket already closing during an admission', async () => {
    const pending = deferred<typeof allowed>();
    const f = fixture({ authorizeConnection: () => pending.promise });
    const ws = f.add();
    subscribe(ws);
    await flush();
    ws.readyState = 2;
    pending.resolve(allowed);
    await flush();
    expect(ws.sent).toEqual([]);
    expect(f.onConnect).not.toHaveBeenCalled();
    expect(f.hub.subscriberCount(TABLE_A)).toBe(0);
  });
  it('reclaims an actual paused WebSocket after observing its real over-limit send queue', async () => {
    vi.useRealTimers();
    const http = createServer();
    const hub = new TableStateHub();
    const engine = new EngineWebSocketServer({
      hub,
      tableExists: () => true,
      verifyToken: async () => ({ userId: 'loopback-user' }),
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
    try {
      await once(client, 'open');
      peer = [...(engine as unknown as Internals).connections.keys()][0];
      const socket = (client as unknown as { _socket: { pause(): void; resume(): void } })._socket;
      socket.pause();
      const payload = Buffer.alloc(1024 * 1024, 120);
      for (let i = 0; i < 16 && peer.bufferedAmount <= HARD; i++) peer.send(payload);
      expect(peer.bufferedAmount).toBeGreaterThan(HARD);
      const queuedBytes = peer.bufferedAmount;
      const started = performance.now();
      const closed = once(peer, 'close');
      (engine as unknown as Internals).heartbeatSweep();
      await Promise.race([
        closed,
        new Promise((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error('physical peer survived the close budget')),
            2000
          );
          timer.unref();
          closed.then(
            () => clearTimeout(timer),
            () => clearTimeout(timer)
          );
        }),
      ]);
      expect(peer.readyState).toBe(WebSocket.CLOSED);
      expect(engine.connectionCount()).toBe(0);
      console.log(
        'LOOPBACK_SOCKET_PRESSURE_PROOF',
        JSON.stringify({
          queuedBytes,
          closedAfterMs: Math.round(performance.now() - started),
          peerClosed: true,
          registeredConnections: engine.connectionCount(),
        })
      );
      socket.resume();
    } finally {
      peer?.terminate();
      client.terminate();
      await engine.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  });
});
