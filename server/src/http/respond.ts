/**
 * Shared HTTP response helpers for the Hetzner game server.
 *
 * Extracted from `server/src/index.ts` in Phase U3.1 (2026-04-23) as the first
 * step of the index-monolith split. Every handler under `server/src/handlers/`
 * and the router in `server/src/index.ts` uses `sendJSON` / `CORS_HEADERS` from
 * here. Preserves byte-identical response behavior — same headers, same body
 * encoding, same status code semantics.
 */

import type { ServerResponse } from 'http';

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

export function sendJSON(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json', ...CORS_HEADERS });
  res.end(JSON.stringify(data));
}
