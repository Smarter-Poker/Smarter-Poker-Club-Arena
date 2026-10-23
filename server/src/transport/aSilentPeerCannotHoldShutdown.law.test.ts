import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import { EngineWebSocketServer, SHUTDOWN_CLOSE_GRACE_MS } from './EngineWebSocketServer.js';
import { TableStateHub } from './TableStateHub.js';

/**
 * A SILENT PEER CANNOT HOLD SHUTDOWN (2026-10-23).
 *
 * Production logged "Shutdown complete." 6.7 s after SIGTERM and then waited
 * to the 40 s hard deadline on 13 of 14 drains: a WebSocket peer that never
 * answers the close frame holds wss.close() for ws's 30 s close timeout, and
 * keep-alive HTTP sockets hold server.close(). Those idle seconds spent the
 * release transaction's 75 s cutover budget (runs 39728449445-1 and
 * 39902613436-1). Ownership is already released by then, so each transport now
 * gets a short grace and is then closed outright.
 */
const INDEX = readFileSync(resolve(process.cwd(), 'src/index.ts'), 'utf8');
const CHANNEL = readFileSync(
  resolve(process.cwd(), 'src/transport/ChannelWebSocketServer.ts'),
  'utf8'
);

let http: Server | null = null;
afterEach(async () => {
  if (http) await new Promise<void>((r) => http!.close(() => r()));
  http = null;
});

describe('a silent WebSocket peer cannot hold engine shutdown', () => {
  it('terminates a peer that never answers the close frame after the grace', async () => {
    const server = new EngineWebSocketServer({ hub: new TableStateHub(), tableExists: () => true });
    const inner = server as unknown as { wss: WebSocketServer };
    http = createServer();
    http.on('upgrade', (req, socket, head) => {
      inner.wss.handleUpgrade(req, socket, head, (ws) => inner.wss.emit('connection', ws, req));
    });
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    const { port } = http.address() as { port: number };

    const client = new WebSocket(`ws://127.0.0.1:${port}/`);
    await once(client, 'open');
    // A peer that never completes the close handshake: pause its reads so the
    // close frame is never processed or answered.
    (client as unknown as { _socket: { pause(): void } })._socket.pause();
    await vi.waitFor(() => expect(inner.wss.clients.size).toBe(1));

    const started = Date.now();
    await server.close();
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(SHUTDOWN_CLOSE_GRACE_MS + 2_000);
    expect(inner.wss.clients.size).toBe(0);
    client.terminate();
  }, 20_000);

  it('the channel server shares the same bounded close', () => {
    const close = CHANNEL.slice(CHANNEL.indexOf('  async close(): Promise<void> {'));
    expect(close).toContain('SHUTDOWN_CLOSE_GRACE_MS');
    expect(close).toContain('ws.terminate()');
    expect(close.indexOf('ws.terminate()')).toBeLessThan(close.indexOf('this.wss.close('));
  });

  it('the HTTP server drops idle keep-alive sockets and closes the rest after a grace', () => {
    const fn = INDEX.slice(
      INDEX.indexOf('function closeHttpServer()'),
      INDEX.indexOf('async function performShutdown()')
    );
    expect(fn).toContain('httpServer.closeIdleConnections()');
    expect(fn).toContain('httpServer.closeAllConnections()');
    expect(fn).toContain('LOCAL_TRANSPORT_GRACE_MS');
    // The grace plus the ownership drain must fit well inside the 40 s deadline.
    expect(INDEX).toMatch(/const LOCAL_TRANSPORT_GRACE_MS = 3_000;/);
    expect(INDEX).toMatch(/const SHUTDOWN_DEADLINE_MS = 40_000;/);
  });
});
