import { afterEach, describe, expect, it } from 'vitest';
import { connect, type Socket } from 'node:net';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { createEngineHttpServer } from './createEngineHttpServer.js';

let server: Server | undefined;
let socket: Socket | undefined;
afterEach(async () => {
  socket?.destroy();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
});

describe('engine HTTP connections behind Caddy', () => {
  it('serves a second POST on the same socket beyond the old idle deadline', async () => {
    let requests = 0;
    server = createEngineHttpServer((req, res) => {
      req.resume();
      req.on('end', () => {
        requests++;
        res.writeHead(200, { 'Content-Length': '2' });
        res.end('ok');
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test port');
    socket = connect(address.port, '127.0.0.1');
    await once(socket, 'connect');
    const post = async () => {
      const response = once(socket!, 'data');
      socket!.write(
        'POST /heartbeat HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n'
      );
      return String((await response)[0]);
    };
    const first = await post();
    expect(first).toContain('200 OK');
    const advertised = Number(/Keep-Alive: timeout=(\d+)/i.exec(first)?.[1]);
    expect(advertised).toBeGreaterThan(120);
    await new Promise((resolve) => setTimeout(resolve, 6_200));
    expect(socket.destroyed).toBe(false);
    expect(await post()).toContain('200 OK');
    expect(requests).toBe(2);
  }, 10_000);
});
