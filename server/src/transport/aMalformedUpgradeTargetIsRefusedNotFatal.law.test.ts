/**
 * LAW: A MALFORMED UPGRADE TARGET IS REFUSED, NEVER FATAL
 *
 * Launch audit, 2026-10-05. Both WebSocket servers parsed the upgrade's
 * request target with `new URL(req.url, 'http://localhost')` inside the
 * `upgrade` listener: before authentication, synchronously, with no
 * try/catch. `new URL()` THROWS on `//`, `///` and `//:80`. An exception in
 * an upgrade listener is an uncaughtException, and index.ts treats that as
 * fatal - the engine drains and restarts, and every hand in flight on every
 * table is voided. One request from a stranger with no account could do
 * that, and repeat it at will.
 *
 * THE PINS
 *   1. The three targets that throw are answered `400` on the wire, by one
 *      listener, and nothing is thrown out of either listener.
 *   2. The same server still upgrades an ordinary socket afterwards.
 *   3. Neither server calls `new URL(req.url ...)` itself any more.
 *   4. Both servers bound a message while it is still arriving
 *      (`maxPayload`); the application-level size check only runs on a whole
 *      message, and `ws` defaults to 100 MiB.
 *
 * IF THIS FILE GOES RED, YOUR CHANGE IS THE BUG. Do not "simplify" the parse
 * back into the listener.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket } from 'ws';

vi.mock('../services/supabase.js', () => ({
  supabase: {
    auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: null })) },
    from: vi.fn(() => ({ insert: vi.fn(async () => ({ error: null })) })),
  },
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
vi.mock('../hub/ChannelHub.js', () => ({
  channelHub: {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    unsubscribeAll: vi.fn(),
    join: vi.fn(),
    leave: vi.fn(),
    leaveAll: vi.fn(),
    handleMessage: vi.fn(),
    removeConnection: vi.fn(),
  },
}));

import { EngineWebSocketServer } from './EngineWebSocketServer.js';
import { ChannelWebSocketServer } from './ChannelWebSocketServer.js';
import { parseUpgradeTarget } from './upgradeTarget.js';

const TABLE = '11111111-1111-4111-8111-111111111111';
const JWT = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2ln';
const THROWING_TARGETS = ['//', '///', '//:80'];

let http: Server;
let port: number;
let engineWs: EngineWebSocketServer;
let channelWs: ChannelWebSocketServer;
const uncaught: unknown[] = [];
const onUncaught = (err: unknown) => uncaught.push(err);

beforeAll(async () => {
  process.on('uncaughtException', onUncaught);
  engineWs = new EngineWebSocketServer({
    hub: { subscribe: vi.fn(), unsubscribe: vi.fn(), resync: vi.fn() } as never,
    tableExists: (id: string) => id === TABLE,
    verifyToken: async () => ({ ok: true, userId: 'u1' }),
    authorizeConnection: async () => ({
      allowed: true,
      reason: 'club_member',
      clubId: 'c1',
      banned: false,
      ipRestricted: false,
    }),
  } as never);
  (engineWs as unknown as { logConnectionAudit: unknown }).logConnectionAudit = vi.fn();
  channelWs = new ChannelWebSocketServer();
  http = createServer((_req, res) => {
    res.writeHead(200);
    res.end('ok');
  });
  // The production order (index.ts): the table server first, then the channel server.
  engineWs.attach(http);
  channelWs.attach(http);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  port = (http.address() as AddressInfo).port;
});

afterAll(async () => {
  process.off('uncaughtException', onUncaught);
  await new Promise<void>((resolve) => http.close(() => resolve()));
});

/** Send a raw upgrade with an arbitrary request target and return the bytes answered. */
function rawUpgrade(target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let answered = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`no answer to upgrade target ${JSON.stringify(target)}`));
    }, 4_000);
    socket.on('connect', () => {
      socket.write(
        `GET ${target} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          'Connection: Upgrade\r\n' +
          'Upgrade: websocket\r\n' +
          'Sec-WebSocket-Version: 13\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'
      );
    });
    socket.on('data', (chunk) => {
      answered += chunk.toString('latin1');
    });
    socket.on('close', () => {
      clearTimeout(timer);
      resolve(answered);
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('LAW 1 - the request targets that make new URL() throw are refused on the wire', () => {
  it('these targets really do throw, which is why they are parsed apart', () => {
    for (const target of THROWING_TARGETS) {
      expect(() => new URL(target, 'http://localhost')).toThrow();
      expect(parseUpgradeTarget(target)).toBeNull();
    }
    expect(parseUpgradeTarget(`/ws/table/${TABLE}?x=1`)?.pathname).toBe(`/ws/table/${TABLE}`);
    expect(parseUpgradeTarget(undefined)?.pathname).toBe('/');
  });

  it.each(THROWING_TARGETS)('an upgrade for %s is answered 400, once', async (target) => {
    const answered = await rawUpgrade(target);
    expect(answered.startsWith('HTTP/1.1 400 Bad Request\r\n')).toBe(true);
    expect(answered.match(/HTTP\/1\.1 /g)?.length).toBe(1);
  });

  it('nothing escaped either listener as an uncaught exception', () => {
    expect(uncaught).toEqual([]);
  });
});

describe('LAW 2 - the server is still serving afterwards', () => {
  it('an ordinary table socket still completes its handshake', async () => {
    for (const target of THROWING_TARGETS) await rawUpgrade(target);
    const opened = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/table/${TABLE}`, ['bearer', JWT]);
      const timer = setTimeout(() => {
        ws.terminate();
        resolve(false);
      }, 4_000);
      ws.on('open', () => {
        clearTimeout(timer);
        ws.close();
        resolve(true);
      });
      ws.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    expect(opened).toBe(true);
    expect(uncaught).toEqual([]);
  });
});

describe('LAW 3 and 4 - the source keeps both protections', () => {
  const source = (file: string) => readFileSync(join(__dirname, file), 'utf8');

  it.each(['EngineWebSocketServer.ts', 'ChannelWebSocketServer.ts'])(
    '%s parses the upgrade target through parseUpgradeTarget only',
    (file) => {
      const text = source(file);
      expect(text).toContain('parseUpgradeTarget(req.url)');
      expect(text).not.toMatch(/new URL\(\s*req\.url/);
    }
  );

  it.each([
    ['table', () => engineWs],
    ['channel', () => channelWs],
  ] as const)('the %s server bounds a message while it is still arriving', (_name, get) => {
    const options = (get() as unknown as { wss: { options: { maxPayload?: number } } }).wss.options;
    expect(options.maxPayload).toBe(64 * 1024);
  });
});
