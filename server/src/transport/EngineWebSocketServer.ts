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
import { reportError } from '../services/errorReporter.js';
import {
  authorizeTableConnection,
  type TableConnectionAccess,
} from '../services/TableConnectionAccess.js';
import type { TableStateHub, HubSubscriber } from './TableStateHub.js';
// Round 70: blacklist gate + Round 67/190: connection audit log both use
// the supabase client imported above. No additional import needed.
import {
  parseTableIdFromPath,
  extractBearerToken,
  verifySupabaseToken,
  authRejectionReason,
  tokenDenial,
  recordWsAuthRefusal,
  recordWsProtocolRefusal,
  recordWsReauthClose,
  recordWsSocketCapRefusal,
  runReauthSweep,
  socketsHeldBy,
  staggeredReauthAt,
  type TokenVerdict,
  type TokenDenial,
} from './wsHelpers.js';

// Re-export helpers so existing imports keep working. Tests pull them from
// wsHelpers.js directly to avoid the Supabase-at-import-time side effect.
export { parseTableIdFromPath, extractBearerToken };

// ─── Constants ────────────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_TIMEOUT_MS = 60_000;
/**
 * Timer drift below this is ordinary scheduling noise. A larger overrun means
 * the engine's own event loop denied sockets a fair chance to have their PONG
 * processed before the timeout sweep ran.
 */
const HEARTBEAT_SCHEDULER_LATE_MS = 5_000;
/**
 * How long a closing socket is given to flush its close frame before the fd is
 * reclaimed. Without it the frame is written and discarded in the same tick and
 * the peer only ever sees 1006, so the reason never reaches a single client.
 */
const TERMINATE_GRACE_MS = 250;
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

/**
 * ═══ THE PROTOCOL VERSION GATE (Realtime Phase 4, 2026-09-05) ══════════════
 *
 * The lowest client protocol this engine will serve. A socket arrives with
 * `?v=<n>`; anything below this is refused with 4426 and the client fetches a
 * new bundle.
 *
 * ZERO TODAY, AND THAT IS THE POINT. Every client is accepted, including the
 * bundles that predate the parameter and send nothing - they read as 0. The
 * gate is installed now, while it is a no-op, so that the day a frame changes
 * shape there is somewhere to put the number. Without it the only options at
 * that moment are to break stale tabs silently or to carry both frame shapes
 * forever.
 *
 * WHY IT WILL BE NEEDED. Club Arena's origin keeps old assets deliberately
 * (CLAUDE.md 1.1), so a tab opened yesterday is running yesterday's bundle
 * against today's engine, mid-hand, right now. That is a feature - it stops
 * a deploy 404ing a player's chunks - and it is exactly why the engine has to
 * be able to say "not that old".
 *
 * RAISE IT IN THE SAME COMMIT AS THE FRAME CHANGE, never before: every tab
 * below the new number is reloaded the moment this deploys.
 */
export const MIN_CLIENT_PROTOCOL = 0;

/** Refused for speaking a protocol this engine no longer serves. */
export const CLOSE_UPGRADE_REQUIRED = 4426;

/**
 * ═══ TRUST HAS TO BE RENEWED (Realtime Phase 5, 2026-09-06) ════════════════
 *
 * A socket is authenticated ONCE, at the upgrade, and then trusted for as long
 * as it stays open. That was the whole story until today, and it is the
 * 2026-09-03 outage seen from the other side: the fix that day made a revoked
 * session unable to OPEN a socket, and said nothing about the sockets already
 * open. With a seven-day access token and a tab that stays open, a player who
 * signed out - or was signed out by an admin, or had their session revoked -
 * keeps playing at a real table with real chips until something else happens
 * to break the connection.
 *
 * So every live socket re-asks GoTrue on this period. Three properties matter
 * more than the number:
 *
 *   - ONLY A DEFINITIVE "no" CLOSES. `denied: 'unavailable'` - GoTrue down,
 *     5xx, a timeout - is never a refusal. That distinction is the whole point
 *     of `wsHelpers.tokenDenial`, and inverting it here would sign every
 *     player out the moment auth had a bad minute.
 *   - IT IS STAGGERED. Re-authing every socket in one sweep would be a few
 *     hundred GoTrue calls in the same second, on the period, forever.
 *   - IT IS BOUNDED PER SWEEP, so a backlog drains at a fixed rate rather than
 *     arriving all at once.
 */
export const REAUTH_INTERVAL_MS = 5 * 60_000;

/** At most this many sockets are re-checked in any one heartbeat sweep. */
export const REAUTH_MAX_PER_SWEEP = 20;

/**
 * How many sockets one account may hold at once.
 *
 * Generous on purpose. The multiplexed transport means a tab is ONE socket
 * however many tables it carries, so a player at four tables on a laptop and
 * two on a phone is two - and this still leaves room for the channel socket,
 * a reconnect that has not yet been reaped, and somebody who genuinely keeps
 * several tabs open. It is a bound on abuse and on a client stuck in a
 * connect loop, not a product limit anyone should ever meet.
 */
export const MAX_SOCKETS_PER_USER = 10;

/**
 * The protocol a socket claims, from `?v=`. Absent, malformed or negative all
 * read as 0 - the version of every bundle that shipped before the parameter
 * existed. Never NaN: a comparison against NaN is false, which would let a
 * garbage value through the one gate meant to catch it.
 */
export function clientProtocolVersion(url: URL): number {
  const raw = url.searchParams.get('v');
  if (raw === null) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

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

/**
 * Loopback and the 'unknown' placeholder are what we see when the proxy did not
 * forward a real client address. Two players must never be treated as sharing a
 * connection just because we failed to learn either of their addresses.
 */
const UNUSABLE_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'unknown', '']);

export function isUsableClientIp(ip: string | null | undefined): ip is string {
  return typeof ip === 'string' && !UNUSABLE_IPS.has(ip.trim().toLowerCase());
}

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Callback the WS server uses to check a table exists before accepting the
 * upgrade. Kept as a dependency so the transport layer stays decoupled from
 * ServerTableEngine / GameServer classes.
 */
export type TableExistsCheck = (tableId: string) => boolean;
export type EnsureTableCheck = (tableId: string) => Promise<boolean>;

export interface EngineWebSocketServerOptions {
  hub: TableStateHub;
  tableExists: TableExistsCheck;
  /**
   * Starts a valid cash-table engine on demand when the table exists in the
   * database but has not reached the occupied-table discovery feed yet.
   * Optional for isolated transport tests; production always wires it.
   */
  ensureTable?: EnsureTableCheck;
  /** Optional override for auth, used by tests to inject fake tokens. */
  verifyToken?: (token: string) => Promise<TokenVerdict | null>;
  /** Optional override for the complete durable connection verdict in tests. */
  authorizeConnection?: (tableId: string, userId: string) => Promise<TableConnectionAccess>;
  /**
   * FIX 2 (2026-07-24): invoked on (re)connect and on RESYNC so the engine can
   * re-deliver the requesting player's hole cards for the current hand. Public
   * state is re-sent by the hub, but hole cards ride a separate transport.
   */
  onResync?: (tableId: string, userId: string) => void;
  /**
   * CONNECTIVITY UPGRADE (2026-08-22): transport-level presence wiring.
   * Before this, the engine's DisconnectEngine learned about a dropped player
   * ONLY from the HTTP heartbeat going stale (30s of dead air) even though the
   * transport knew within milliseconds. onDisconnect fires when a player's
   * LAST live socket for a table goes away; onConnect fires the moment a
   * socket for that table is established, so a reconnect cancels the
   * disconnect countdown instantly instead of waiting for the next HTTP
   * heartbeat.
   */
  onConnect?: (tableId: string, userId: string) => void;
  onDisconnect?: (tableId: string, userId: string) => void;
}

interface ConnectionState {
  id: string;
  userId: string;
  /**
   * The bearer this socket opened with, kept so it can be re-checked while the
   * socket is alive (Phase 5). It is already in memory - it is a key in
   * `tokenCache` - and it is the only thing that lets the engine notice a
   * session revoked AFTER the upgrade.
   */
  token: string;
  /** Epoch ms of the next re-auth. Staggered at connect, see REAUTH_INTERVAL_MS. */
  nextReauthAt: number;
  /** Single-table path: the table from the upgrade URL. Mux path: ''. */
  tableId: string;
  ws: WebSocket;
  lastPongAt: number;
  /**
   * A late heartbeat sweep is server debt, not client silence. This adjusted
   * liveness anchor subtracts only time the server lost to scheduler stalls,
   * without lying about when its last PONG actually arrived.
   */
  heartbeatGraceAt: number;
  inboundCount: number;
  inboundWindowStart: number;
  /** Client address from the x-forwarded-for chain; null when unknown. */
  clientIp: string | null;
  /**
   * Roadmap batch 6 (2026-08-21) — multiplexed connection (/ws/multi).
   * One socket carries up to MUX_MAX_TABLES table subscriptions; every
   * per-table gate (exists / blacklist / ip-restriction / audit) runs at
   * SUBSCRIBE time instead of upgrade time. A unique symbol marks each
   * in-flight attempt so cancelled checks cannot mutate a replacement.
   */
  isMux?: boolean;
  subs?: Map<string, HubSubscriber | symbol>;
}

/** Mux cap — matches the client's 4-table device cap. */
const MUX_MAX_TABLES = 4;

// ─── Default JWT verification (Supabase) ──────────────────────────────────────

/**
 * B11 FIX (2026-08-20): cache successful token verifications briefly.
 *
 * Every (re)connect called supabase.auth.getUser over the network. A reconnect
 * storm — which is exactly what follows an engine restart or a client-side
 * network blip, i.e. the moment the platform is already under load — turned
 * into one auth round trip per socket per attempt.
 *
 * Only SUCCESSES are cached, and only for 30 seconds. Caching a failure would
 * lock a user out for the TTL after a transient auth outage, and a long TTL
 * would keep a revoked session alive; 30s bounds that to less than the time it
 * takes an admin to notice they revoked something, while collapsing a burst of
 * reconnects to a single call. The JWT's own expiry still applies underneath.
 */
const TOKEN_CACHE_TTL_MS = 30_000;
const TOKEN_CACHE_MAX = 5_000;
const tokenCache = new Map<string, { userId: string; verifiedAt: number }>();

function cacheToken(token: string, userId: string): void {
  // Bounded: drop the oldest insertion when full. Map preserves insertion order,
  // so the first key is the coldest. Without this a long-lived process with
  // rotating tokens grows this map without limit.
  if (tokenCache.size >= TOKEN_CACHE_MAX) {
    const oldest = tokenCache.keys().next().value;
    if (oldest !== undefined) tokenCache.delete(oldest);
  }
  tokenCache.set(token, { userId, verifiedAt: Date.now() });
}

async function defaultVerifyToken(token: string): Promise<TokenVerdict> {
  if (!token) return { denied: 'invalid', code: 'missing' };
  const hit = tokenCache.get(token);
  if (hit && Date.now() - hit.verifiedAt < TOKEN_CACHE_TTL_MS) {
    return { userId: hit.userId };
  }
  if (hit) tokenCache.delete(token);
  // 2026-09-04: the verdict says WHY (see wsHelpers). Only successes are
  // cached, as before - a 30s cache of "invalid" would lock a player out for
  // 30s after they sign back in.
  const verdict = await verifySupabaseToken(supabase.auth, token);
  if (verdict.userId) cacheToken(token, verdict.userId);
  return verdict;
}

/**
 * 2026-09-04: refuse an upgrade in the one way a browser can actually read.
 *
 * An HTTP status written before the handshake reaches JavaScript as close
 * code 1006 - indistinguishable from a dropped link - so a revoked session
 * looked like a network blip and the client retried it for 22 hours. An
 * INVALID token now completes the handshake and is closed with 4401 and an
 * `auth:<code>` reason; the client has handled 4401 as CLOSE_AUTH_FAILED
 * since it was written. A token we merely could not CHECK keeps the
 * pre-handshake 503: the client sees 1006 and keeps retrying, which is the
 * right response to an auth outage that is not the player's fault.
 */
function refuseUpgrade(
  wss: WebSocketServer,
  req: IncomingMessage,
  socket: import('stream').Duplex,
  head: Buffer,
  verdict: TokenDenial,
  path: 'table' | 'multi'
): void {
  recordWsAuthRefusal(path, verdict.denied);
  if (verdict.denied === 'unavailable') {
    socket.write(
      'HTTP/1.1 503 Service Unavailable\r\nRetry-After: 5\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
    );
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    try {
      ws.close(CLOSE_AUTH_FAILED, authRejectionReason(verdict.code));
    } catch {
      ws.terminate();
    }
  });
}

/**
 * Refuse a bundle older than this engine serves (Phase 4, 2026-09-05).
 *
 * Completes the handshake and closes 4426 for the same reason `refuseUpgrade`
 * does it for auth: a pre-handshake status is close 1006 to the browser, and
 * 1006 means "try again", which is the one thing a stale bundle must not do.
 * The reason carries the number it needs to reach, so the close is readable in
 * a console and in a log without cross-referencing anything.
 *
 * EXPORTED, and the counter is inside it (audit, 2026-09-05). The first
 * version was private here and the channel server inlined its own copy of the
 * same four lines - two implementations of one refusal, one of which would
 * have been the one nobody updated. It also recorded nothing, which is the
 * defect the auth counter beside it exists to remember: on the day
 * MIN_CLIENT_PROTOCOL is raised, the wave of stale tabs being turned away is
 * the one thing worth watching, and it would not have been a number anywhere.
 */
export function refuseProtocol(
  wss: WebSocketServer,
  req: IncomingMessage,
  socket: import('stream').Duplex,
  head: Buffer,
  saw: number,
  path: 'table' | 'multi' | 'channel'
): void {
  recordWsProtocolRefusal(path);
  wss.handleUpgrade(req, socket, head, (ws) => {
    try {
      ws.close(CLOSE_UPGRADE_REQUIRED, `upgrade_required:${saw}<${MIN_CLIENT_PROTOCOL}`);
    } catch {
      ws.terminate();
    }
  });
}

// ─── EngineWebSocketServer ────────────────────────────────────────────────────

export class EngineWebSocketServer {
  private wss: WebSocketServer;
  private connections: Map<WebSocket, ConnectionState> = new Map();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  /** Last time the heartbeat interval actually got CPU time. */
  private lastHeartbeatSweepAt = Date.now();
  private readonly hub: TableStateHub;
  private readonly tableExists: TableExistsCheck;
  private readonly ensureTable?: EnsureTableCheck;
  private readonly verifyToken: (token: string) => Promise<TokenVerdict | null>;
  private readonly authorizeConnection: (
    tableId: string,
    userId: string
  ) => Promise<TableConnectionAccess>;
  private readonly onResync?: (tableId: string, userId: string) => void;
  private readonly onConnect?: (tableId: string, userId: string) => void;
  private readonly onDisconnect?: (tableId: string, userId: string) => void;
  private accessStarts = new Map<symbol, number>();
  private accessCompleted = 0;
  private accessFailed = 0;
  private accessMaxMs = 0;
  private accessOverGrace = 0;

  constructor(opts: EngineWebSocketServerOptions) {
    this.hub = opts.hub;
    this.tableExists = opts.tableExists;
    this.ensureTable = opts.ensureTable;
    this.verifyToken = opts.verifyToken ?? defaultVerifyToken;
    const authority = opts.authorizeConnection ?? authorizeTableConnection;
    this.authorizeConnection = async (tableId, userId) => {
      const request = Symbol('connection-authority');
      const started = performance.now();
      this.accessStarts.set(request, started);
      try {
        const verdict = await authority(tableId, userId);
        if (verdict.reason === 'check_failed') this.accessFailed++;
        return verdict;
      } catch (error) {
        this.accessFailed++;
        throw error;
      } finally {
        const elapsed = Math.max(0, performance.now() - started);
        this.accessStarts.delete(request);
        this.accessCompleted++;
        this.accessMaxMs = Math.max(this.accessMaxMs, elapsed);
        if (elapsed > 1200) this.accessOverGrace++;
      }
    };
    this.onResync = opts.onResync;
    this.onConnect = opts.onConnect;
    this.onDisconnect = opts.onDisconnect;
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

      /* ═══ PROTOCOL GATE (Phase 4, 2026-09-05) ═══════════════════════════
         Before auth and before any table work, because it is cheaper than
         both and because a bundle we will not serve should not be charged a
         token verification to find out.

         REFUSED WITH A CLOSE FRAME, NOT AN HTTP STATUS. A status written
         before the handshake reaches JavaScript as 1006 - the lesson of
         2026-09-03, where a pre-handshake 401 was indistinguishable from a
         dropped link and got retried for 22 hours. The same mistake here
         would be a stale tab reconnecting forever instead of fetching the
         bundle that would fix it. `refuseProtocol` completes the handshake
         and closes 4426, which the client acts on.

         A no-op while MIN_CLIENT_PROTOCOL is 0. */
      if (
        (url.pathname === '/ws/multi' || url.pathname.startsWith('/ws/table/')) &&
        clientProtocolVersion(url) < MIN_CLIENT_PROTOCOL
      ) {
        refuseProtocol(
          this.wss,
          req,
          socket,
          head,
          clientProtocolVersion(url),
          url.pathname === '/ws/multi' ? 'multi' : 'table'
        );
        return;
      }

      // ── Roadmap batch 6: multiplexed path ────────────────────────────
      // Auth-only at upgrade; every table-scoped gate runs per SUBSCRIBE.
      // Additive and OFF by default client-side (ca_ws_mux flag), so this
      // path carries zero traffic until a client opts in.
      if (url.pathname === '/ws/multi') {
        const muxToken = extractBearerToken(req.headers['sec-websocket-protocol']);
        if (!muxToken) {
          socket.write(
            'HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
          );
          socket.destroy();
          return;
        }
        const muxClientIp = extractClientIp(req);
        this.verifyToken(muxToken)
          .then((auth) => {
            const muxDenial = tokenDenial(auth);
            if (muxDenial || !auth?.userId) {
              // 2026-09-04: 4401 + reason, never a silent pre-handshake 401.
              refuseUpgrade(
                this.wss,
                req,
                socket,
                head,
                muxDenial ?? { denied: 'invalid', code: 'invalid' },
                'multi'
              );
              return;
            }
            const userId = auth.userId;
            this.wss.handleUpgrade(req, socket, head, (ws) => {
              this.onUpgradedMux(ws, userId, muxClientIp, muxToken);
            });
          })
          .catch(() => {
            socket.write(
              'HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
            );
            socket.destroy();
          });
        return;
      }

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
          const denial = tokenDenial(auth);
          if (denial || !auth?.userId) {
            // 2026-09-04: this used to be a bare pre-handshake 401, which a
            // browser reports as 1006 - a network blip - so a revoked session
            // was retried with the same dead token for 22 hours. An invalid
            // token now gets the handshake and close 4401 with an auth:<code>
            // reason; an auth outage stays a 503 the client keeps retrying.
            refuseUpgrade(
              this.wss,
              req,
              socket,
              head,
              denial ?? { denied: 'invalid', code: 'invalid' },
              'table'
            );
            return;
          }
          const viewerAccess = await this.authorizeConnection(tableId, auth.userId);
          const banned = viewerAccess.banned;
          if (!viewerAccess.allowed) {
            const status =
              viewerAccess.reason === 'table_not_found'
                ? '404 Not Found'
                : viewerAccess.reason === 'check_failed'
                  ? '503 Service Unavailable'
                  : '403 Forbidden';
            socket.write(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
            socket.destroy();
            return;
          }

          // Round 70: blacklist enforcement at WS upgrade. Banned users can't
          // even open a connection to the table, so they can't see other
          // players' actions / chat / etc. Belt-and-suspenders relative to
          // the buyin gate at /api/club-arena/buyin.
          if (banned) {
            socket.write(
              'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
            );
            socket.destroy();
            return;
          }

          /*
           * A brand-new empty table is deliberately absent from the normal
           * occupied-table discovery RPC. Before this gate, Create And Start
           * navigated to the felt immediately, this synchronous check returned
           * false, and the client received an endless 404/reconnect cycle until
           * a seat somehow existed on a table nobody could open. An authorized
           * viewer now wakes that one table on demand. The GameServer method
           * validates cash/status/deletion state and takes the same single-owner
           * lease as background discovery before it installs the engine.
           */
          if (
            !this.tableExists(tableId) &&
            !(this.ensureTable && (await this.ensureTable(tableId)))
          ) {
            socket.write(
              'HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
            );
            socket.destroy();
            return;
          }

          // 2026-08-19: IP Restriction, made real. The switch existed on the
          // create-table page since day one and enforced nothing. It means
          // what it means in a live room: two DIFFERENT accounts may not be at
          // the same table from the same internet connection.
          //
          // Deliberately narrow:
          //   • the same player reconnecting is always fine — only a different
          //     userId counts as a conflict;
          //   • an address we could not learn (loopback, 'unknown') never
          //     counts, or a proxy misconfiguration would lock out the room;
          //   • whoever is already connected keeps their seat. This refuses
          //     the arriving connection, it never drops a seated player.
          if (this.isIpConflict(tableId, auth.userId, clientIp, viewerAccess.ipRestricted)) {
            socket.write(
              'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
            );
            socket.destroy();
            return;
          }

          // Round 67/190: log connection IP to action_audit_logs so the
          // multi-account detector has data on real player traffic. Bots
          // generate no audit log entries; this gap meant the detector was
          // blind. Fire-and-forget — never blocks the upgrade.
          this.logConnectionAudit(auth.userId, tableId, clientIp);

          this.wss.handleUpgrade(req, socket, head, (ws) => {
            this.onUpgraded(ws, req, auth.userId, tableId, clientIp, token);
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
      this.lastHeartbeatSweepAt = Date.now();
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

  /** Counts and monotonic durations only; no identities or table contents. */
  connectionAccessStats(): {
    completed: number;
    failed: number;
    pending: number;
    oldestPendingMs: number;
    maxDurationMs: number;
    over1200Ms: number;
  } {
    let oldestPendingMs = 0;
    const now = performance.now();
    for (const started of this.accessStarts.values()) {
      oldestPendingMs = Math.max(oldestPendingMs, now - started);
    }
    return {
      completed: this.accessCompleted,
      failed: this.accessFailed,
      pending: this.accessStarts.size,
      oldestPendingMs,
      maxDurationMs: this.accessMaxMs,
      over1200Ms: this.accessOverGrace,
    };
  }

  /**
   * Who is actually on the multiplexed socket, and how much is it carrying?
   *
   * The `ca_ws_mux` beta has been "off, pending a soak" for two sessions, and
   * the reason it never got soaked is that nothing could tell you whether it
   * was on. /ws-metrics reported two numbers, neither of which distinguishes a
   * client holding four per-table sockets from one holding a single mux socket
   * with four subscriptions — the exact difference the beta exists to make.
   *
   * Everything here is already tracked per connection; this only counts it.
   * Counts only, no payloads and no user ids: /ws-metrics is unauthenticated.
   */
  muxStats(): {
    muxSockets: number;
    singleSockets: number;
    muxSubscriptions: number;
    maxSubsOnOneSocket: number;
  } {
    let muxSockets = 0;
    let singleSockets = 0;
    let muxSubscriptions = 0;
    let maxSubsOnOneSocket = 0;
    for (const conn of this.connections.values()) {
      if (!conn.isMux) {
        singleSockets++;
        continue;
      }
      muxSockets++;
      const n = conn.subs?.size ?? 0;
      muxSubscriptions += n;
      if (n > maxSubsOnOneSocket) maxSubsOnOneSocket = n;
    }
    return { muxSockets, singleSockets, muxSubscriptions, maxSubsOnOneSocket };
  }

  /** The database decides the setting; this process owns its live sockets. */
  private isIpConflict(
    tableId: string,
    userId: string,
    ip: string | null,
    restricted: boolean
  ): boolean {
    if (!restricted || !isUsableClientIp(ip)) return false;
    const needle = ip.trim().toLowerCase();
    for (const conn of this.connections.values()) {
      const sub = conn.subs?.get(tableId);
      const atTable =
        conn.tableId === tableId || (conn.isMux && sub != null && typeof sub !== 'symbol');
      if (!atTable || conn.userId === userId || !isUsableClientIp(conn.clientIp)) continue;
      if (conn.clientIp.trim().toLowerCase() === needle) return true;
    }
    return false;
  }

  // ─── Round 67/190: per-connection audit log ─────────────────────────────
  /**
   * Fire-and-forget: write a row to action_audit_logs so the multi-account
   * IP detector has a data source for real engine traffic (the engine path
   * that bypasses /api/club-arena/* routes which is where auditLogger.js
   * normally fires).
   */
  private logConnectionAudit(userId: string, tableId: string, ip: string | null): void {
    void Promise.resolve(
      supabase.from('action_audit_logs').insert({
        action_type: 'engine_ws_connect',
        user_id: userId,
        ip_address: ip ?? 'unknown',
        details: { table_id: tableId },
      })
    )
      .then(({ error }) => {
        if (error && error.code !== '23505' /* dup */) {
          console.warn('[EngineWS] audit log failed:', error.message);
        }
      })
      .catch((err: unknown) => {
        console.warn('[EngineWS] audit log threw:', (err as Error)?.message ?? err);
      });
  }

  // ─── Upgrade aftermath ─────────────────────────────────────────────────────

  private onUpgraded(
    ws: WebSocket,
    _req: IncomingMessage,
    userId: string,
    tableId: string,
    clientIp: string | null = null,
    token = ''
  ): void {
    if (this.refuseIfOverSocketCap(ws, userId)) return;
    const conn: ConnectionState = {
      id: randomUUID(),
      userId,
      token,
      nextReauthAt: staggeredReauthAt(REAUTH_INTERVAL_MS),
      tableId,
      ws,
      lastPongAt: Date.now(),
      heartbeatGraceAt: 0,
      inboundCount: 0,
      inboundWindowStart: Date.now(),
      clientIp,
    };
    this.connections.set(ws, conn);

    // HubSubscriber adapter: ws already matches the shape almost exactly,
    // but we need a stable .id field and a numeric readyState.
    const subscriber: HubSubscriber = {
      id: conn.id,
      userId,
      get readyState() {
        return ws.readyState;
      },
      // FIX 2026-08-22: without this the hub's backpressure logic read
      // `sub.bufferedAmount ?? 0` as 0 forever on every single-table socket,
      // so the soft-drop / hard-evict thresholds never fired for the
      // connections that carry all current traffic (only the mux path
      // exposed it).
      get bufferedAmount() {
        return ws.bufferedAmount;
      },
      send(data: string) {
        ws.send(data);
      },
      // 2026-08-24: hub hard-drop → close the socket so the client's
      // onclose fires NOW and it reconnects on the slow ladder (4429),
      // instead of holding an open socket that will never speak again.
      evict() {
        try {
          ws.close(CLOSE_RATE_LIMITED, 'backpressure evict - reconnect');
        } catch {
          /* ignore */
        }
      },
    };
    (ws as unknown as { __sub: HubSubscriber }).__sub = subscriber;
    this.hub.subscribe(tableId, subscriber);
    // FIX 2 (2026-07-24): a fresh (re)connect gets the public SNAPSHOT above;
    // ask the engine to also re-deliver this player's hole cards for the
    // current hand so a reconnecting player isn't left blind.
    // 2026-08-22 review: these callbacks reach into engine code and MUST NOT
    // be able to abort the wiring below — a throw here used to leave the
    // socket in this.connections and subscribed to the hub with NO close
    // handler: a permanent leak the sweeps could never collect.
    try {
      this.resyncPlayer(tableId, userId);
      // Presence: tell the engine this player has a live transport again.
      this.onConnect?.(tableId, userId);
    } catch {
      /* engine wiring must never take down the transport */
    }

    ws.on('message', (raw) => this.onMessage(conn, raw));
    ws.on('close', () => this.onClose(ws));
    ws.on('error', () => this.onClose(ws));
  }

  // ─── Roadmap batch 6: mux connection lifecycle ──────────────────────────

  private onUpgradedMux(ws: WebSocket, userId: string, clientIp: string | null, token = ''): void {
    if (this.refuseIfOverSocketCap(ws, userId)) return;
    const conn: ConnectionState = {
      id: randomUUID(),
      userId,
      token,
      nextReauthAt: staggeredReauthAt(REAUTH_INTERVAL_MS),
      tableId: '',
      ws,
      lastPongAt: Date.now(),
      heartbeatGraceAt: 0,
      inboundCount: 0,
      inboundWindowStart: Date.now(),
      clientIp,
      isMux: true,
      subs: new Map(),
    };
    this.connections.set(ws, conn);
    ws.on('message', (raw) => this.onMessage(conn, raw));
    ws.on('close', () => this.onClose(ws));
    ws.on('error', () => this.onClose(ws));
  }

  /** A private-state replay failure must not abort transport recovery or presence. */
  private resyncPlayer(tableId: string, userId: string): void {
    try {
      this.onResync?.(tableId, userId);
    } catch (error) {
      reportError(error, 'EngineWS.private_state_resync');
    }
  }

  private sendMuxError(
    conn: ConnectionState,
    tableId: string,
    code: string,
    message: string
  ): void {
    try {
      conn.ws.send(JSON.stringify({ type: 'ERROR', tableId, code, message }));
    } catch {
      /* next close/sweep collects the socket */
    }
  }

  private async handleMuxSubscribe(conn: ConnectionState, tableId: string): Promise<void> {
    if (!conn.subs) return;
    const existing = conn.subs.get(tableId);
    if (typeof existing === 'symbol') return; // in flight - first one wins
    if (existing) {
      // Idempotent: already subscribed. Re-ack + resync so a client retry
      // converges instead of erroring.
      try {
        conn.ws.send(JSON.stringify({ type: 'SUBSCRIBED', tableId }));
      } catch {
        /* ignore */
      }
      this.hub.resync(tableId, existing);
      this.resyncPlayer(tableId, conn.userId);
      return;
    }
    // Audit round 4: counting only SETTLED subscriptions let a client that
    // fired 5+ SUBSCRIBEs in one burst sail past the cap while they were all
    // still 'pending'. In-flight counts against the limit.
    if (conn.subs.size >= MUX_MAX_TABLES) {
      this.sendMuxError(
        conn,
        tableId,
        'SUB_LIMIT',
        `At most ${MUX_MAX_TABLES} tables per connection`
      );
      return;
    }
    let owned: HubSubscriber | symbol = Symbol('pending subscription');
    conn.subs.set(tableId, owned);
    const isCurrent = () => this.connections.has(conn.ws) && conn.subs?.get(tableId) === owned;
    try {
      const viewerAccess = await this.authorizeConnection(tableId, conn.userId);
      const banned = viewerAccess.banned;
      // UNSUBSCRIBE, close, or a new attempt may have won during the await.
      // Neither a stale success nor a stale refusal belongs to that attempt.
      if (!isCurrent()) return;
      if (!viewerAccess.allowed) {
        conn.subs.delete(tableId);
        this.sendMuxError(
          conn,
          tableId,
          viewerAccess.reason === 'table_not_found'
            ? 'TABLE_NOT_FOUND'
            : viewerAccess.reason === 'check_failed'
              ? 'ACCESS_CHECK_FAILED'
              : viewerAccess.reason === 'observers_restricted'
                ? 'OBSERVERS_RESTRICTED'
                : 'CLUB_MEMBERSHIP_REQUIRED',
          viewerAccess.reason === 'table_not_found'
            ? 'Table not found'
            : viewerAccess.reason === 'check_failed'
              ? 'Unable to verify table access'
              : viewerAccess.reason === 'observers_restricted'
                ? 'This Table Is Open To Seated Players Only'
                : 'Join this club before watching its live games'
        );
        return;
      }
      if (banned) {
        conn.subs.delete(tableId);
        this.sendMuxError(conn, tableId, 'BANNED', 'Not permitted at this table');
        return;
      }
      // The multiplexed path must wake new empty tables exactly like the
      // single-table WebSocket path, or multi-table users still get the old
      // permanent TABLE_NOT_FOUND loop.
      const tableReady =
        this.tableExists(tableId) || (this.ensureTable && (await this.ensureTable(tableId)));
      if (!isCurrent()) return;
      if (!tableReady) {
        conn.subs.delete(tableId);
        this.sendMuxError(conn, tableId, 'TABLE_NOT_FOUND', 'Table not found in engine');
        return;
      }
      if (this.isIpConflict(tableId, conn.userId, conn.clientIp, viewerAccess.ipRestricted)) {
        conn.subs.delete(tableId);
        this.sendMuxError(
          conn,
          tableId,
          'IP_RESTRICTED',
          'Another account is already connected from this address'
        );
        return;
      }
      // The socket may have closed while the async gates ran.
      if (!isCurrent()) return;
      this.logConnectionAudit(conn.userId, tableId, conn.clientIp);
      const ws = conn.ws;
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const self = this;
      const subscriber: HubSubscriber = {
        id: `${conn.id}:${tableId}`,
        userId: conn.userId,
        get readyState() {
          return ws.readyState;
        },
        get bufferedAmount() {
          return ws.bufferedAmount;
        },
        send(data: string) {
          ws.send(data);
        },
        // 2026-08-24: on a mux socket, closing the whole connection would
        // punish the user's OTHER tables for one table's backpressure.
        // Drop just this table's subscription and say so; the client's
        // per-table facade sees the close and reconnects that table alone.
        evict() {
          conn.subs?.delete(tableId);
          self.sendMuxError(conn, tableId, 'EVICTED', 'backpressure evict - resubscribe');
        },
      };
      owned = subscriber;
      conn.subs.set(tableId, subscriber);
      try {
        conn.ws.send(JSON.stringify({ type: 'SUBSCRIBED', tableId }));
      } catch {
        /* ignore */
      }
      this.hub.subscribe(tableId, subscriber);
      // 2026-08-22 review: guarded separately — after hub.subscribe() has
      // succeeded, a throw from these engine callbacks must not fall into the
      // outer catch, which would delete the sub entry and orphan the hub
      // subscriber (unreachable by onClose).
      try {
        this.resyncPlayer(tableId, conn.userId);
        // Presence: mux SUBSCRIBE established a live transport for this table.
        this.onConnect?.(tableId, conn.userId);
      } catch {
        /* engine wiring must never take down the transport */
      }
    } catch (err) {
      if (!isCurrent()) return;
      if (typeof owned !== 'symbol') this.hub.unsubscribe(tableId, owned);
      conn.subs.delete(tableId);
      this.sendMuxError(conn, tableId, 'SUB_FAILED', 'Subscribe failed');
    }
  }

  private handleMuxMessage(conn: ConnectionState, msg: { type?: string; tableId?: unknown }): void {
    const tableId = typeof msg.tableId === 'string' ? msg.tableId : '';
    switch (msg.type) {
      case 'PONG':
        conn.lastPongAt = Date.now();
        conn.heartbeatGraceAt = 0;
        return;
      case 'SUBSCRIBE':
        if (!tableId) return;
        void this.handleMuxSubscribe(conn, tableId);
        return;
      case 'UNSUBSCRIBE': {
        if (!tableId || !conn.subs) return;
        const sub = conn.subs.get(tableId);
        conn.subs.delete(tableId);
        if (sub && typeof sub !== 'symbol') this.hub.unsubscribe(tableId, sub);
        return;
      }
      case 'RESYNC': {
        if (!tableId || !conn.subs) return;
        const sub = conn.subs.get(tableId);
        if (sub && typeof sub !== 'symbol') {
          this.hub.resync(tableId, sub);
          this.resyncPlayer(tableId, conn.userId);
        }
        return;
      }
      default:
        return; // action ingress stays REST-only, same as the single path
    }
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

    if (conn.isMux) {
      this.handleMuxMessage(conn, msg as { type?: string; tableId?: unknown });
      return;
    }

    switch (msg.type) {
      case 'PONG':
        conn.lastPongAt = Date.now();
        conn.heartbeatGraceAt = 0;
        return;
      case 'RESYNC': {
        const sub = (conn.ws as unknown as { __sub: HubSubscriber }).__sub;
        this.hub.resync(conn.tableId, sub);
        // FIX 2 (2026-07-24): re-deliver hole cards alongside the public
        // snapshot — the RESYNC snapshot only carries scrubbed public state.
        this.resyncPlayer(conn.tableId, conn.userId);
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
    if (conn.isMux) {
      this.connections.delete(ws);
      if (conn.subs) {
        for (const [tableId, sub] of conn.subs) {
          if (typeof sub !== 'symbol') this.hub.unsubscribe(tableId, sub);
        }
        const tableIds = [...conn.subs.keys()];
        conn.subs.clear();
        for (const tableId of tableIds) {
          this.notifyDisconnectIfLast(tableId, conn.userId);
        }
      }
      return;
    }
    const sub = (ws as unknown as { __sub?: HubSubscriber }).__sub;
    if (sub) this.hub.unsubscribe(conn.tableId, sub);
    this.connections.delete(ws);
    // Delete AFTER removing this connection, so "is anyone left" is accurate.
    this.notifyDisconnectIfLast(conn.tableId, conn.userId);
  }

  /**
   * CONNECTIVITY UPGRADE (2026-08-22): fire onDisconnect only when the player
   * has NO other live socket carrying this table. During a reconnect the new
   * socket opens before the old one closes; without this check the old
   * socket's close would mark a freshly reconnected player as disconnected.
   */
  private notifyDisconnectIfLast(tableId: string, userId: string): void {
    if (!this.onDisconnect || !tableId) return;
    for (const [otherWs, other] of this.connections) {
      if (other.userId !== userId) continue;
      if (otherWs.readyState !== WebSocket.OPEN) continue;
      if (other.tableId === tableId) return; // still connected on another socket
      if (other.isMux && other.subs?.has(tableId)) return;
    }
    try {
      this.onDisconnect(tableId, userId);
    } catch {
      /* presence wiring must never take down the transport */
    }
  }

  /**
   * Refuse a socket that would take one account past the cap.
   *
   * THE NEW ONE IS REFUSED, NEVER AN OLD ONE EVICTED. An existing socket may
   * be carrying a hand; the arriving one certainly is not. Evicting the oldest
   * would also hand any client stuck in a connect loop a way to knock its own
   * player off the felt, over and over, which is a worse failure than the one
   * this bounds.
   *
   * Closed with 4429 - the code this client already understands as "slow
   * down", and which makes its ladder back off rather than hammer - and with
   * a reason that says what happened, because a close nobody can read is the
   * 2026-09-03 lesson.
   */
  private refuseIfOverSocketCap(ws: WebSocket, userId: string): boolean {
    const held = socketsHeldBy(this.connections, userId);
    if (held < MAX_SOCKETS_PER_USER) return false;
    recordWsSocketCapRefusal();
    try {
      ws.close(CLOSE_RATE_LIMITED, `too_many_sockets:${held}`);
    } catch {
      try {
        ws.terminate();
      } catch {
        /* nothing further to do */
      }
    }
    return true;
  }

  /**
   * Re-ask GoTrue whether the sessions behind live sockets are still alive.
   *
   * Runs inside the heartbeat sweep because that is already the one place
   * every connection is walked on a timer. Bounded per sweep and staggered per
   * socket, so this is a trickle rather than a wave.
   *
   * A DEFINITIVE rejection closes with 4401 and the same `auth:<code>` reason
   * the upgrade path uses, so the client's existing handling - ask GoTrue,
   * prompt, sign in - runs unchanged. Anything else leaves the socket alone
   * and tries again next period: an auth outage must never close a table.
   */
  private reauthSweep(now: number): void {
    /* The SHARED sweep (audit, 2026-09-06). This was a private copy here and
       the channel socket had none at all - the same "two of the three sockets"
       gap Phase 4 warned about, one phase later. One implementation now, in
       wsHelpers, handed each server's own connection map. */
    runReauthSweep({
      now,
      connections: this.connections,
      path: (conn) => (conn.isMux ? 'multi' : 'table'),
      verify: (token) => this.verifyToken(token),
      close: (ws, code, reason) => {
        try {
          ws.close(code, reason);
        } catch {
          try {
            ws.terminate();
          } catch {
            /* ignore */
          }
        }
      },
      intervalMs: REAUTH_INTERVAL_MS,
      maxPerSweep: REAUTH_MAX_PER_SWEEP,
      closeCode: CLOSE_AUTH_FAILED,
    });
  }

  private heartbeatSweep(): void {
    const now = Date.now();
    const sweepGap = now - this.lastHeartbeatSweepAt;
    const schedulerDebtMs =
      sweepGap > HEARTBEAT_INTERVAL_MS + HEARTBEAT_SCHEDULER_LATE_MS
        ? sweepGap - HEARTBEAT_INTERVAL_MS
        : 0;
    this.lastHeartbeatSweepAt = now;
    // Trust has to be renewed: see REAUTH_INTERVAL_MS. Runs first so a socket
    // whose session died is closed on this sweep rather than pinged first.
    this.reauthSweep(now);
    for (const [ws, conn] of this.connections) {
      // If THIS process was late, a healthy PONG can be queued behind the same
      // event-loop stall that delayed this sweep. Credit only the lost
      // scheduling time (not a whole new timeout), then send a fresh probe.
      if (schedulerDebtMs > 0) {
        conn.heartbeatGraceAt = Math.min(
          now,
          Math.max(conn.lastPongAt, conn.heartbeatGraceAt) + schedulerDebtMs
        );
      }
      const lastFairLivenessAt = Math.max(conn.lastPongAt, conn.heartbeatGraceAt);
      if (now - lastFairLivenessAt > HEARTBEAT_TIMEOUT_MS) {
        try {
          ws.close(1001, 'heartbeat timeout');
        } catch {
          /* ignore */
        }
        // FIX 2026-08-22: close() starts a graceful handshake a half-open
        // socket can never finish, so the fd lingered until the OS TCP
        // timeout. A peer that missed 60s of pongs is gone — terminate.
        //
        // ...but terminating in the SAME TICK discarded the close frame we had
        // just written, so every client saw 1006 "abnormal" and none ever
        // learned it was a heartbeat timeout. A socket that is merely slow
        // rather than half-open can still receive that frame if given a moment,
        // and a truly half-open one loses nothing by waiting: it is already off
        // the connection map above, so the sweep will not see it again.
        const doomed = ws;
        const reaper = setTimeout(() => {
          try {
            doomed.terminate();
          } catch {
            /* ignore */
          }
        }, TERMINATE_GRACE_MS);
        (reaper as { unref?: () => void }).unref?.();
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
