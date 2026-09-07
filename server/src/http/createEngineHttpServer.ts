import { createServer, type RequestListener } from 'node:http';

/** Keep backend sockets alive beyond Caddy's 120-second upstream idle pool. */
export function createEngineHttpServer(listener: RequestListener) {
  return createServer({ keepAliveTimeout: 130_000 }, listener);
}
