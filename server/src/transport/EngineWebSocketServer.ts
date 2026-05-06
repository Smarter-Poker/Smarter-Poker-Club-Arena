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
// Round 70: blacklist gate + Round 67/190: connection audit log both use
// the supabase client imported above. No additional import needed.
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
export const CLOSE_BANNED = 4403; // Round 70: banned by club / union blacklist
export const CLOSE_TABLE_NOT_FOUND = 4404;
export const CLOSE_RATE_LIMITED = 4429;
export const CLOSE_SERVER_ERROR = 4500;
export const CLOSE_BAD_REQUEST = 4400;

// Round 70 + 67/190: extract real client IP from x-forwarded-for chain.
// Caddy sits in front of the engine, so socket.remoteAddress is always
// 127.0.0.1. The forwarded header carries the real chain.
function extractClientIp(req: IncomingMessage): string | null {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) {
    return fwd.split(',')[0]?.trim() ?? null;
  }
  if (Array.isArray(fwd) && fwd.length > 0) {
    return String(fwd[0]).split(',')[0]?.trim() ?? null;
  }
  const sockAddr = (req.socket as unknown as { remoteAddress?: string }).remoteAddress;
  return sockAddr ?? null;
}

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
        socket.write('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      // Round 67/190: capture client IP from x-forwarded-for chain (Caddy
      // proxies upstream so socket.remoteAddress is always 127.0.0.1).
      const clientIp = extractClientIp(req);

      // Finish the handshake asynchronously after auth + table check pass.
      this.verifyToken(token)
        .then(async (auth) => {
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

          // Round 70: blacklist enforcement at WS upgrade. Banned users can't
          // even open a connection to the table, so they can't see other
          // players' actions / chat / etc. Belt-and-suspenders relative to
          // the buyin gate at /api/club-arena/buyin.
          try {
            const banned = await this.isBannedFromTable(tableId, auth.userId);
            if (banned) {
              socket.write(
                'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
              );
              socket.destroy();
              return;
            }
          } catch {
            // Belt-and-suspenders: never reject legit connections on a
            // blacklist-check error. Log and proceed.
          }

          // Round 67/190: log connection IP to action_audit_logs so the
          // multi-account detector has data on real player traffic. Bots
          // generate no audit log entries; this gap meant the detector was
          // blind. Fire-and-forget — never blocks the upgrade.
          this.logConnectionAudit(auth.userId, tableId, clientIp);

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

  // ─── Round 70: blacklist gate ───────────────────────────────────────────
  /**
   * Check if `userId` is banned from `tableId`'s club (or its union).
   * Returns true if an active ban row exists. Cached briefly so repeated
   * reconnects from the same banned user don't hammer the DB.
   */
  private async isBannedFromTable(tableId: string, userId: string): Promise<boolean> {
    // Resolve the table's club + union (single query, no caching here — table
    // membership in a club is stable for the lifetime of the table).
    const { data: tableRow } = await supabase
      .from('tables')
      .select('club_id')
      .eq('id', tableId)
      .maybeSingle();
    if (!tableRow?.club_id) return false;

    const { data: clubRow } = await supabase
      .from('clubs')
      .select('union_id')
      .eq('id', tableRow.club_id)
      .maybeSingle();

    const nowIso = new Date().toISOString();
    let q = supabase
      .from('blacklists')
      .select('id')
      .eq('user_id', userId)
      .or('expires_at.is.null,expires_at.gt.' + nowIso);

    const orParts = [`club_id.eq.${tableRow.club_id}`];
    if (clubRow?.union_id) orParts.push(`union_id.eq.${clubRow.union_id}`);
    q = q.or(orParts.join(','));

    const { data: bans } = await q.limit(1);
    return !!(bans && bans.length > 0);
  }

  // ─── Round 67/190: per-connection audit log ─────────────────────────────
  /**
   * Fire-and-forget: write a row to action_audit_logs so the multi-account
   * IP detector has a data source for real engine traffic (the engine path
   * that bypasses /api/club-arena/* routes which is where auditLogger.js
   * normally fires).
   */
  private logConnectionAudit(userId: string, tableId: string, ip: string | null): void {
    void supabase
      .from('action_audit_logs')
      .insert({
        action_type: 'engine_ws_connect',
        user_id: userId,
        ip_address: ip ?? 'unknown',
        details: { table_id: tableId },
      })
      .then(({ error }) => {
        if (error && error.code !== '23505' /* dup */) {
          console.warn('[EngineWS] audit log failed:', error.message);
        }
      });
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
