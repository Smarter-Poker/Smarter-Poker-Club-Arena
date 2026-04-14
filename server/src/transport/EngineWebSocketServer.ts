/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * EngineWebSocketServer — native WebSocket transport for authoritative state
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Attaches a ws.WebSocketServer to the existing node http.Server. Handles
 * upgrade requests on `/ws/table/:tableId` only, authenticates the connecting
 * client via the `bearer` subprotocol (Supabase JWT), and wires the socket
 * into the TableStateHub for state delivery.
 *
 * Client protocol (binding — see Phase 1.1 spec §4)
 * -------------------------------------------------
 * URL:     wss://engine.smarter.poker/ws/table/:tableId
 * Auth:    Sec-WebSocket-Protocol: bearer, <jwt>
 * S→C:     SNAPSHOT { type, tableId, seq, state }
 * S→C:     DELTA    { type, tableId, seq, prev, patch }  (RFC-6902 JSON Patch)
 * S→C:     PING     { type, ts }
 * S→C:     ERROR    { type, code, message }
 * C→S:     RESYNC   { type }
 * C→S:     PONG     { type, ts }
 *
 * Close codes (custom)
 *   4400 bad request (malformed upgrade)
 *   4401 auth failed
 *   4404 table not found in engine
 *   4429 rate-limited
 *   4500 internal server error
 *
 * Heartbeat: server pings every 25s; closes after 60s without a pong.
 */

import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { IncomingMessage } from 'http';
import type { Server as HttpServer } from 'http';
import { randomUUID } from 'crypto';
import { supabase } from '../services/supabase.js';
import type { TableStateHub, HubSubscriber } from './TableStateHub.js';
import { parseTableIdFromPath, extractBearerToken } from './wsHelpers.js';

// Re-export helpers so existing imports keep working. Tests pull them from
// wsHelpers.js directly to avoid the Supabase-at-import-time side effect.
export { parseTableIdFromPath, extractBearerToken };

// ─── Constants ────────────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_TIMEOUT_MS = 60_000;
const INBOUND_RATE_LIMIT = 30; // messages per second per connection
const INBOUND_RATE_WINDOW_MS = 1_000;
const MAX_INBOUND_MESSAGE_BYTES = 4 * 1024;

// Close codes (must be in the 4000–4999 application-defined range per RFC 6455)
export const CLOSE_AUTH_FAILED = 4401;
export const CLOSE_TABLE_NOT_FOUND = 4404;
export const CLOSE_RATE_LIMITED = 4429;
export const CLOSE_SERVER_ERROR = 4500;
export const CLOSE_BAD_REQUEST = 4400;

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Callback the WS server uses to check a table exists before accepting the
 * upgrade. Kept as a dependency so the transport layer stays decoupled from
 * ServerTableEngine / GameServer classes.
 */
export type TableExistsCheck = (tableId: string) => boolean;

export interface EngineWebSocketServerOptions {
  hub: TableStateHub;
  tableExists: TableExistsCheck;
  /** Optional override for auth, used by tests to inject fake tokens. */
  verifyToken?: (token: string) => Promise<{ userId: string } | null>;
}

interface ConnectionState {
  id: string;
  userId: string;
  tableId: string;
  ws: WebSocket;
  lastPongAt: number;
  inboundCount: number;
  inboundWindowStart: number;
}

// ─── Default JWT verification (Supabase) ──────────────────────────────────────

async function defaultVerifyToken(token: string): Promise<{ userId: string } | null> {
  if (!token) return null;
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return null;
    return { userId: data.user.id };
  } catch {
    return null;
  }
}

// ─── EngineWebSocketServer ────────────────────────────────────────────────────

export class EngineWebSocketServer {
  private wss: WebSocketServer;
  private connections: Map<WebSocket, ConnectionState> = new Map();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly hub: TableStateHub;
  private readonly tableExists: TableExistsCheck;
  private readonly verifyToken: (token: string) => Promise<{ userId: string } | null>;

  constructor(opts: EngineWebSocketServerOptions) {
    this.hub = opts.hub;
    this.tableExists = opts.tableExists;
    this.verifyToken = opts.verifyToken ?? defaultVerifyToken;
    this.wss = new WebSocketServer({ noServer: true });
  }

  /**
   * Attach to a node http.Server. Routes upgrade requests whose path begins
   * with `/ws/table/` to this WS server, leaves all other paths untouched so
   * the http request handler handles them normally.
   */
  attach(httpServer: HttpServer): void {
    httpServer.on('upgrade', (req, socket, head) => {
      // Parse URL relative to a dummy host — `req.url` is path+query only.
      const url = new URL(req.url || '/', 'http://localhost');
      if (!url.pathname.startsWith('/ws/table/')) return; // not ours

      const tableId = parseTableIdFromPath(url.pathname);
      if (!tableId) {
        // Always write a proper HTTP status before destroying so the client
        // sees 400 instead of Caddy's 502 upstream-down response.
        socket.write('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        return;
      }

      const token = extractBearerToken(req.headers['sec-websocket-protocol']);
      if (!token) {
        socket.write(
          'HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
        );
        socket.destroy();
        return;
      }

      // Finish the handshake asynchronously after auth + table check pass.
      this.verifyToken(token)
        .then((auth) => {
          if (!auth) {
            // Pre-handshake failure — cannot use WS close codes yet.
            // Return 401 by writing a short HTTP/1.1 response. Browsers
            // surface this as a handshake error; client wrapper retries
            // after refreshing the token.
            socket.write(
              'HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
            );
            socket.destroy();
            return;
          }
          if (!this.tableExists(tableId)) {
            socket.write(
              'HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
            );
            socket.destroy();
            return;
          }

          this.wss.handleUpgrade(req, socket, head, (ws) => {
            this.onUpgraded(ws, req, auth.userId, tableId);
          });
        })
        .catch(() => {
          socket.write(
            'HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
          );
          socket.destroy();
        });
    });

    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => this.heartbeatSweep(), HEARTBEAT_INTERVAL_MS);
    }
  }

  /**
   * Call on server shutdown. Closes every connection cleanly and stops the
   * heartbeat interval.
   */
  async close(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const [ws] of this.connections) {
      try {
        ws.close(1001, 'server shutting down');
      } catch {
        /* ignore */
      }
    }
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  // Metrics
  connectionCount(): number {
    return this.connections.size;
  }

  // ─── Upgrade aftermath ─────────────────────────────────────────────────────

  private onUpgraded(ws: WebSocket, _req: IncomingMessage, userId: string, tableId: string): void {
    const conn: ConnectionState = {
      id: randomUUID(),
      userId,
      tableId,
      ws,
      lastPongAt: Date.now(),
      inboundCount: 0,
      inboundWindowStart: Date.now(),
    };
    this.connections.set(ws, conn);

    // HubSubscriber adapter: ws already matches the shape almost exactly,
    // but we need a stable .id field and a numeric readyState.
    const subscriber: HubSubscriber = {
      id: conn.id,
      get readyState() {
        return ws.readyState;
      },
      send(data: string) {
        ws.send(data);
      },
    };
    (ws as unknown as { __sub: HubSubscriber }).__sub = subscriber;
    this.hub.subscribe(tableId, subscriber);

    ws.on('message', (raw) => this.onMessage(conn, raw));
    ws.on('close', () => this.onClose(ws));
    ws.on('error', () => this.onClose(ws));
  }

  private onMessage(conn: ConnectionState, raw: RawData): void {
    // Rate limit by sliding-window count.
    const now = Date.now();
    if (now - conn.inboundWindowStart >= INBOUND_RATE_WINDOW_MS) {
      conn.inboundWindowStart = now;
      conn.inboundCount = 0;
    }
    conn.inboundCount++;
    if (conn.inboundCount > INBOUND_RATE_LIMIT) {
      try {
        conn.ws.close(CLOSE_RATE_LIMITED, 'rate-limited');
      } catch {
        /* ignore */
      }
      return;
    }

    // Payload size guard. RawData is Buffer | ArrayBuffer | Buffer[] from ws.
    const size = Array.isArray(raw)
      ? raw.reduce((n, b) => n + b.length, 0)
      : raw instanceof ArrayBuffer
      ? raw.byteLength
      : (raw as Buffer).length;
    if (size > MAX_INBOUND_MESSAGE_BYTES) {
      try {
        conn.ws.close(CLOSE_BAD_REQUEST, 'payload too large');
      } catch {
        /* ignore */
      }
      return;
    }

    let msg: { type?: string; ts?: number } | null = null;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignore malformed
    }
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'PONG':
        conn.lastPongAt = Date.now();
        return;
      case 'RESYNC': {
        const sub = (conn.ws as unknown as { __sub: HubSubscriber }).__sub;
        this.hub.resync(conn.tableId, sub);
        return;
      }
      default:
        // Client→server messages other than PONG / RESYNC are ignored. We
        // deliberately do NOT accept action submissions over WS — the REST
        // POST /action endpoint is the only action ingress.
        return;
    }
  }

  private onClose(ws: WebSocket): void {
    const conn = this.connections.get(ws);
    if (!conn) return;
    const sub = (ws as unknown as { __sub?: HubSubscriber }).__sub;
    if (sub) this.hub.unsubscribe(conn.tableId, sub);
    this.connections.delete(ws);
  }

  private heartbeatSweep(): void {
    const now = Date.now();
    for (const [ws, conn] of this.connections) {
      if (now - conn.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
        try {
          ws.close(1001, 'heartbeat timeout');
        } catch {
          /* ignore */
        }
        this.onClose(ws);
        continue;
      }
      try {
        ws.send(JSON.stringify({ type: 'PING', ts: now }));
      } catch {
        /* next sweep will collect */
      }
    }
  }
}
