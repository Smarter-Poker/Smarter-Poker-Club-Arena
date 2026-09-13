/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ChannelWebSocketServer — WebSocket transport for /ws/channel
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Handles upgrade requests on `/ws/channel` (a single, global endpoint —
 * no :tableId segment). Authenticates via `Sec-WebSocket-Protocol: bearer, <jwt>`,
 * calls Supabase auth.getUser() to verify, and delegates all subscription
 * management to ChannelHub.
 *
 * Client → Server message types
 * ───────────────────────────────
 *   JOIN_CLUB           { type, clubId }
 *   LEAVE_CLUB          { type, clubId }
 *   UPDATE_PRESENCE     { type, clubId, status, currentTableId? }
 *   JOIN_TOURNAMENT     { type, tournamentId }
 *   LEAVE_TOURNAMENT    { type, tournamentId }
 *   JOIN_LOBBY          { type }
 *   LEAVE_LOBBY         { type }
 *   REQUEST_HAND_REPLAY { type, handId }
 *   CHANNEL_PING        { type }
 *
 * Heartbeat (2026-08-24): server sends PING + CHANNEL_PING every 25 s; ANY
 * well-formed inbound frame (PONG, CHANNEL_PONG, JOIN_*, ...) counts as proof
 * of life. Closes after 60 s of total inbound silence. (The old contract —
 * CHANNEL_PING out, only CHANNEL_PONG accepted back — did not match the
 * deployed client, which answers PING with PONG; every connection was
 * therefore force-closed 60s after it opened, forever.)
 *
 * Hand replay: on REQUEST_HAND_REPLAY the server queries `hand_history`
 * for rows matching `hand_id` and streams them as HAND_REPLAY_EVENT messages
 * with a 200 ms delay between frames, mimicking live playback.
 *
 * Close codes
 *   4400  bad request (malformed upgrade / path mismatch)
 *   4401  auth failed (invalid or expired JWT)
 *   4429  rate-limited
 */

import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { IncomingMessage } from 'http';
import type { Server as HttpServer } from 'http';
import { supabase } from '../services/supabase.js';
import {
  extractBearerToken,
  verifySupabaseToken,
  authRejectionReason,
  tokenDenial,
  recordWsAuthRefusal,
  recordWsSocketCapRefusal,
  runReauthSweep,
  socketsHeldBy,
  staggeredReauthAt,
  type TokenVerdict,
} from './wsHelpers.js';
import { channelHub } from '../hub/ChannelHub.js';
// One definition of the protocol gate for every socket on this engine. A
// second copy of the number is how two sockets end up disagreeing about which
// bundles they serve (Realtime Phase 4, 2026-09-05).
import {
  MIN_CLIENT_PROTOCOL,
  clientProtocolVersion,
  refuseProtocol,
  REAUTH_INTERVAL_MS,
  REAUTH_MAX_PER_SWEEP,
  MAX_SOCKETS_PER_USER,
} from './EngineWebSocketServer.js';

/** B13: how long a club-membership verdict may be reused. */
const CLUB_MEMBERSHIP_TTL_MS = 60_000;
const CLUB_MEMBERSHIP_CACHE_MAX = 10_000;
const MAX_PENDING_CLUB_JOINS = 64;

interface PendingClubJoin {
  failures: number;
  timer?: ReturnType<typeof setTimeout>;
  presence?: { status: 'online' | 'at_table' | 'away'; currentTableId?: string };
}

// ─── Constants ────────────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_TIMEOUT_MS = 60_000;
/**
 * How long a closing socket is given to flush its close frame before the fd is
 * reclaimed. Without it the frame is written and discarded in the same tick and
 * the peer only ever sees 1006, so the reason never reaches a single client.
 */
const TERMINATE_GRACE_MS = 250;
const INBOUND_RATE_LIMIT = 30; // messages per second per connection
const INBOUND_RATE_WINDOW_MS = 1_000;
const MAX_INBOUND_MESSAGE_BYTES = 8 * 1024;
const HAND_REPLAY_DELAY_MS = 200;
// Preserve concurrent hand-ID subscriptions without letting one connection or
// a reconnect storm create an unbounded number of reads and replay timers.
const MAX_HAND_REPLAYS_PER_CONNECTION = 4;
const MAX_ACTIVE_HAND_REPLAYS = 64;

// Close codes
const CLOSE_BAD_REQUEST = 4400;
const CLOSE_AUTH_FAILED = 4401;
const CLOSE_RATE_LIMITED = 4429;

// ─── Types ────────────────────────────────────────────────────────────────────

interface PendingHandReplay {
  abort: AbortController;
  cancelWait?: () => void;
}

interface ConnectionState {
  handReplays: Map<string, PendingHandReplay>;
  clubJoins: Map<string, PendingClubJoin>;
  userId: string;
  ws: WebSocket;
  lastPongAt: number;
  inboundCount: number;
  inboundWindowStart: number;
  /**
   * Phase 5 audit (2026-09-06). This socket had no periodic re-check and no
   * per-user cap: Phase 5 gave both to the TABLE sockets and skipped this one,
   * the same "two of the three sockets" gap Phase 4 wrote a warning about. It
   * matters here as much as there - this socket carries FINANCIAL_UPDATE, so a
   * revoked session went on receiving a player's wallet balance and ledger
   * entries indefinitely.
   */
  token: string;
  nextReauthAt: number;
}

// Inbound message discriminated union
type InboundMessage =
  | { type: 'JOIN_CLUB'; clubId: string }
  | { type: 'LEAVE_CLUB'; clubId: string }
  | {
      type: 'UPDATE_PRESENCE';
      clubId: string;
      status: 'online' | 'at_table' | 'away';
      currentTableId?: string;
    }
  | { type: 'JOIN_TOURNAMENT'; tournamentId: string }
  | { type: 'LEAVE_TOURNAMENT'; tournamentId: string }
  | { type: 'JOIN_LOBBY' }
  | { type: 'LEAVE_LOBBY' }
  | { type: 'REQUEST_HAND_REPLAY'; handId: string }
  | { type: 'CHANNEL_PING' }
  | { type: 'CHANNEL_PONG' }
  | { type: 'PONG'; ts?: number };

// ─── Default JWT verification ─────────────────────────────────────────────────

// 2026-09-04: the verdict says WHY (see wsHelpers) so a revoked session can
// be refused with a close code the browser can read, and an auth outage can
// be told apart from it.
async function verifyToken(token: string): Promise<TokenVerdict> {
  return verifySupabaseToken(supabase.auth, token);
}

// ─── ChannelWebSocketServer ───────────────────────────────────────────────────

export class ChannelWebSocketServer {
  private wss: WebSocketServer;
  private connections: Map<WebSocket, ConnectionState> = new Map();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private closing = false;
  // Cancelled reads remain charged until their promise settles. Dropping the
  // charge on disconnect would let reconnects multiply unresolved requests.
  private activeHandReplays = new Set<PendingHandReplay>();

  constructor() {
    this.wss = new WebSocketServer({ noServer: true });
  }

  /**
   * Attach to a node http.Server. Routes upgrade requests on `/ws/channel`
   * to this WS server; leaves all other paths untouched.
   */
  attach(httpServer: HttpServer): void {
    httpServer.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url || '/', 'http://localhost');

      // Only handle our path — leave /ws/table/:tableId to EngineWebSocketServer
      if (url.pathname !== '/ws/channel') return;

      /* Protocol gate (Realtime Phase 4, 2026-09-05), the same one the table
         sockets carry and for the same reason: the origin keeps old assets, so
         a tab from yesterday is talking to today's engine. Refused with a
         CLOSE FRAME rather than an HTTP status, because a pre-handshake status
         reaches the browser as 1006 and 1006 means "retry" - the one thing a
         stale bundle must not do. A no-op while MIN_CLIENT_PROTOCOL is 0. */
      if (clientProtocolVersion(url) < MIN_CLIENT_PROTOCOL) {
        // The SHARED refusal, not a copy of it (audit, 2026-09-05): this
        // inlined the same four lines, so the counter and any future change to
        // how a refusal is written would have reached one socket and not the
        // other.
        refuseProtocol(this.wss, req, socket, head, clientProtocolVersion(url), 'channel');
        return;
      }

      const token = extractBearerToken(req.headers['sec-websocket-protocol']);
      if (!token) {
        socket.write('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      verifyToken(token)
        .then((auth) => {
          const denial = tokenDenial(auth);
          if (denial || !auth.userId) {
            recordWsAuthRefusal('channel', denial?.denied ?? 'invalid');
            // 2026-09-04: same rule as EngineWebSocketServer. A pre-handshake
            // 401 reaches the browser as 1006 and was retried as a network
            // blip for 22 hours; an invalid token is now closed with 4401 and
            // an auth:<code> reason, an auth outage stays a retryable 503.
            if (denial?.denied === 'unavailable') {
              socket.write(
                'HTTP/1.1 503 Service Unavailable\r\nRetry-After: 5\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
              );
              socket.destroy();
              return;
            }
            this.wss.handleUpgrade(req, socket, head, (ws) => {
              try {
                ws.close(CLOSE_AUTH_FAILED, authRejectionReason(denial?.code ?? 'invalid'));
              } catch {
                ws.terminate();
              }
            });
            return;
          }
          const userId = auth.userId;
          this.wss.handleUpgrade(req, socket, head, (ws) => {
            this.onUpgraded(ws, userId, token);
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
   * Call on server shutdown. Closes every connection and stops the heartbeat.
   */
  async close(): Promise<void> {
    this.closing = true;
    for (const conn of this.connections.values()) this.cancelHandReplays(conn);
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    channelHub.close();
    for (const [ws] of this.connections) {
      try {
        ws.close(1001, 'server shutting down');
      } catch {
        /* ignore */
      }
    }
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  connectionCount(): number {
    return this.connections.size;
  }

  // ─── Upgrade aftermath ─────────────────────────────────────────────────────

  private onUpgraded(ws: WebSocket, userId: string, token = ''): void {
    if (socketsHeldBy(this.connections, userId) >= MAX_SOCKETS_PER_USER) {
      // The ARRIVING socket is refused, never an existing one evicted - see
      // the table server's cap for why. 4429 is the code this client already
      // backs off on.
      recordWsSocketCapRefusal();
      try {
        ws.close(CLOSE_RATE_LIMITED, 'too_many_sockets');
      } catch {
        try {
          ws.terminate();
        } catch {
          /* nothing further to do */
        }
      }
      return;
    }
    const conn: ConnectionState = {
      handReplays: new Map(),
      clubJoins: new Map(),
      userId,
      ws,
      lastPongAt: Date.now(),
      inboundCount: 0,
      inboundWindowStart: Date.now(),
      token,
      nextReauthAt: staggeredReauthAt(REAUTH_INTERVAL_MS),
    };
    this.connections.set(ws, conn);
    channelHub.addConnection(userId, ws);

    ws.on('message', (raw) => this.onMessage(conn, raw));
    ws.on('close', () => this.onClose(ws));
    ws.on('error', () => this.onClose(ws));
  }

  /**
   * B13: membership verdicts, cached briefly.
   *
   * Club membership changes rarely and a reconnect storm must not turn into one
   * lookup per socket per attempt (the same mistake the engine WebSocket server
   * made with its ban check). 60s is short enough that a removed member loses
   * the feed promptly and long enough to collapse a burst.
   */
  private clubMembershipCache: Map<string, { member: boolean; readAt: number }> = new Map();

  private cancelClubJoin(conn: ConnectionState, clubId: string): void {
    const pending = conn.clubJoins.get(clubId);
    if (pending?.timer) clearTimeout(pending.timer);
    conn.clubJoins.delete(clubId);
  }

  private clubJoinIsCurrent(
    conn: ConnectionState,
    clubId: string,
    pending: PendingClubJoin
  ): boolean {
    return (
      this.connections.get(conn.ws) === conn &&
      conn.ws.readyState === WebSocket.OPEN &&
      conn.clubJoins.get(clubId) === pending
    );
  }

  private joinClubIfMember(conn: ConnectionState, clubId: string): void {
    // Invalid IDs are permanent request errors, never a reason to schedule
    // repeated membership reads during transport recovery.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clubId)) {
      channelHub.sendWs(conn.ws, {
        type: 'CHANNEL_ERROR',
        code: 'INVALID_CLUB_ID',
        message: 'Invalid Club Identifier',
      });
      return;
    }
    // Reasserts coalesce with an in-flight read or its retry, never multiplying
    // database work. Only this socket's current intent may publish the result.
    if (conn.clubJoins.has(clubId)) return;
    if (conn.clubJoins.size >= MAX_PENDING_CLUB_JOINS) {
      channelHub.sendWs(conn.ws, {
        type: 'CHANNEL_ERROR',
        code: 'CLUB_JOIN_LIMIT',
        message: 'Too Many Pending Club Subscriptions',
      });
      return;
    }
    const pending: PendingClubJoin = { failures: 0 };
    conn.clubJoins.set(clubId, pending);
    void this.resolveClubJoin(conn, clubId, pending);
  }

  private async resolveClubJoin(
    conn: ConnectionState,
    clubId: string,
    pending: PendingClubJoin
  ): Promise<void> {
    if (!this.clubJoinIsCurrent(conn, clubId, pending)) return;
    const { userId } = conn;
    const key = `${userId}|${clubId}`;
    const hit = this.clubMembershipCache.get(key);
    let member: boolean;
    try {
      if (hit && Date.now() - hit.readAt < CLUB_MEMBERSHIP_TTL_MS) {
        member = hit.member;
      } else {
        const { data, error } = await supabase
          .from('club_members')
          .select('user_id')
          .eq('club_id', clubId)
          .eq('user_id', userId)
          .maybeSingle();
        if (error) throw error;
        if (!this.clubJoinIsCurrent(conn, clubId, pending)) return;
        member = !!data;
        if (this.clubMembershipCache.size >= CLUB_MEMBERSHIP_CACHE_MAX) {
          const oldest = this.clubMembershipCache.keys().next().value;
          if (oldest !== undefined) this.clubMembershipCache.delete(oldest);
        }
        this.clubMembershipCache.set(key, { member, readAt: Date.now() });
      }
    } catch {
      // An unavailable read is not a membership verdict. Recover on the same
      // live intent with bounded, jittered backoff instead of silently waiting
      // for the client's three-minute reassert. No unknown verdict is cached.
      if (!this.clubJoinIsCurrent(conn, clubId, pending)) return;
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(pending.failures++, 5));
      pending.timer = setTimeout(
        () => {
          pending.timer = undefined;
          void this.resolveClubJoin(conn, clubId, pending);
        },
        delay + Math.floor(Math.random() * 500)
      );
      pending.timer.unref?.();
      return;
    }
    if (!this.clubJoinIsCurrent(conn, clubId, pending)) return;
    conn.clubJoins.delete(clubId);
    if (!member) {
      // Revalidation can revoke a previously granted feed. A confirmed denial
      // must not leave the old membership subscribed indefinitely.
      channelHub.leaveClub(userId, clubId);
      return;
    }
    channelHub.joinClub(userId, clubId);
    if (pending.presence) {
      channelHub.updatePresence(
        userId,
        clubId,
        pending.presence.status,
        pending.presence.currentTableId
      );
    }
  }

  // ─── Message routing ───────────────────────────────────────────────────────

  private onMessage(conn: ConnectionState, raw: RawData): void {
    // Rate limiting — sliding window
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

    // Payload size guard
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

    let msg: InboundMessage | null = null;
    try {
      msg = JSON.parse(raw.toString()) as InboundMessage;
    } catch {
      return; // ignore malformed JSON
    }
    if (!msg || typeof msg.type !== 'string') return;

    // 2026-08-24 HEARTBEAT FIX — any well-formed inbound frame proves the
    // link is alive. The sweep below used to accept ONLY CHANNEL_PONG as
    // proof of life while the deployed client answered heartbeats with PONG
    // (and its JOINs/PRESENCE frames were ignored as liveness too), so every
    // single /ws/channel connection was force-closed at the 60s mark,
    // forever — taking wallet updates, tournament events, club events and
    // lobby updates down with it, every minute, for every user. This mirrors
    // the client's own rule ("any byte from the peer proves the link").
    conn.lastPongAt = Date.now();

    const { userId } = conn;

    switch (msg.type) {
      case 'CHANNEL_PONG':
      case 'PONG':
        return; // liveness already stamped above

      case 'CHANNEL_PING':
        // Client-initiated ping → server replies with PONG immediately
        channelHub.sendToUser(userId, { type: 'CHANNEL_PONG' });
        return;

      case 'JOIN_CLUB':
        /**
         * B13 FIX (2026-08-20): joining a club channel now requires membership.
         *
         * This took whatever clubId the client sent and subscribed them to it.
         * Any authenticated user could therefore join ANY club's channel and
         * receive its presence feed — who is online, who is at a table, and
         * every CLUB_PRESENCE_UPDATE broadcast to it. Club rosters are private;
         * nothing in this path checked that the caller belonged to the club
         * whose feed they were asking for.
         *
         * Fails CLOSED: a lookup error refuses the join rather than defaulting
         * to allow. The client retries, and an access decision should never be
         * made optimistically on a database blip.
         */
        if (typeof msg.clubId === 'string' && msg.clubId) {
          this.joinClubIfMember(conn, msg.clubId);
        }
        return;

      case 'LEAVE_CLUB':
        if (typeof msg.clubId === 'string' && msg.clubId) {
          this.cancelClubJoin(conn, msg.clubId);
          channelHub.leaveClub(userId, msg.clubId);
        }
        return;

      case 'UPDATE_PRESENCE':
        if (
          typeof msg.clubId === 'string' &&
          msg.clubId &&
          (msg.status === 'online' || msg.status === 'at_table' || msg.status === 'away')
        ) {
          // B13: presence WRITES into a club's broadcast feed, so it needs the
          // same gate as reading it. Subscription implies the membership check
          // above already passed, which keeps this synchronous and off the DB.
          const pending = conn.clubJoins.get(msg.clubId);
          if (pending) {
            // JOIN is async; the immediately following presence frame must not
            // disappear while membership is being checked. Keep only the latest.
            pending.presence = { status: msg.status, currentTableId: msg.currentTableId };
          } else if (channelHub.isInClub(userId, msg.clubId)) {
            channelHub.updatePresence(userId, msg.clubId, msg.status, msg.currentTableId);
          }
        }
        return;

      case 'JOIN_TOURNAMENT':
        if (typeof msg.tournamentId === 'string' && msg.tournamentId) {
          channelHub.joinTournament(userId, msg.tournamentId);
        }
        return;

      case 'LEAVE_TOURNAMENT':
        if (typeof msg.tournamentId === 'string' && msg.tournamentId) {
          channelHub.leaveTournament(userId, msg.tournamentId);
        }
        return;

      case 'JOIN_LOBBY':
        channelHub.joinLobby(userId);
        // Send an immediate lobby update to the joining client
        channelHub.broadcastLobbyUpdate();
        return;

      case 'LEAVE_LOBBY':
        channelHub.leaveLobby(userId);
        return;

      case 'REQUEST_HAND_REPLAY':
        if (typeof msg.handId === 'string' && msg.handId) {
          this.startHandReplay(conn, msg.handId);
        }
        return;

      default:
        // Unknown message types are silently ignored
        return;
    }
  }

  // ─── Hand replay ───────────────────────────────────────────────────────────

  private startHandReplay(conn: ConnectionState, handId: string): void {
    if (
      this.closing ||
      this.connections.get(conn.ws) !== conn ||
      conn.ws.readyState !== WebSocket.OPEN
    )
      return;
    if (conn.handReplays.has(handId)) return;
    if (
      conn.handReplays.size >= MAX_HAND_REPLAYS_PER_CONNECTION ||
      this.activeHandReplays.size >= MAX_ACTIVE_HAND_REPLAYS
    ) {
      channelHub.sendWs(conn.ws, {
        type: 'CHANNEL_ERROR',
        code: 'REPLAY_LIMIT',
        message: 'Too Many Active Hand Replays. Try Again When One Finishes.',
      });
      return;
    }
    const replay: PendingHandReplay = { abort: new AbortController() };
    conn.handReplays.set(handId, replay);
    this.activeHandReplays.add(replay);
    void this.streamHandReplay(conn, handId, replay);
  }

  private handReplayIsCurrent(
    conn: ConnectionState,
    handId: string,
    replay: PendingHandReplay
  ): boolean {
    return (
      !this.closing &&
      !replay.abort.signal.aborted &&
      this.connections.get(conn.ws) === conn &&
      conn.ws.readyState === WebSocket.OPEN &&
      conn.handReplays.get(handId) === replay
    );
  }

  private cancelHandReplays(conn: ConnectionState): void {
    for (const replay of conn.handReplays.values()) {
      replay.abort.abort();
      replay.cancelWait?.();
    }
  }

  private waitForHandReplayFrame(replay: PendingHandReplay): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        replay.cancelWait = undefined;
        resolve();
      };
      const timer = setTimeout(finish, HAND_REPLAY_DELAY_MS);
      replay.cancelWait = finish;
      if (replay.abort.signal.aborted) finish();
    });
  }

  /**
   * Query hand_history for all events matching handId and stream them
   * to the requesting connection with HAND_REPLAY_DELAY_MS between each frame.
   */
  private async streamHandReplay(
    conn: ConnectionState,
    handId: string,
    replay: PendingHandReplay
  ): Promise<void> {
    const { userId } = conn;
    try {
      const { data: rows, error } = await supabase
        .from('hand_history')
        .select(
          'id, hand_number, actions, players, community_cards, winners, game_variant, small_blind, big_blind, started_at, ended_at'
        )
        .eq('id', handId)
        .limit(1)
        .abortSignal(replay.abort.signal)
        .maybeSingle();

      if (!this.handReplayIsCurrent(conn, handId, replay)) return;

      if (error || !rows) {
        channelHub.sendWs(conn.ws, {
          type: 'CHANNEL_ERROR',
          code: 'HAND_NOT_FOUND',
          message: `Hand ${handId} not found`,
        });
        return;
      }

      // FIX 3 (2026-07-24): AUTHORIZATION — this endpoint streamed any hand's
      // `players`/`raw_events` (which include every player's hole cards) to ANY
      // authenticated user, so a client could iterate/guess hand ids and pull
      // opponents' hole cards. Restrict full replay to a PARTICIPANT of a
      // COMPLETED hand. We deny non-participants outright rather than trying to
      // scrub cards: hole cards live in both `players[].cards` AND `raw_events`,
      // and any missed field would re-leak — deny is the safe, verifiable rule
      // and it fully preserves the legit use case (reviewing a hand you played).
      const participantIds: string[] = Array.isArray(rows.players)
        ? (rows.players as Array<{ userId?: unknown }>)
            .map((pl) => (typeof pl?.userId === 'string' ? pl.userId : null))
            .filter((id): id is string => id !== null)
        : [];
      const isParticipant = participantIds.includes(userId);
      const isCompleted = rows.ended_at != null;
      if (!isCompleted || !isParticipant) {
        channelHub.sendWs(conn.ws, {
          type: 'CHANNEL_ERROR',
          code: 'NOT_AUTHORIZED',
          message: 'You can only replay completed hands you played in.',
        });
        return;
      }

      // Build a sequence of replay events from the hand's action log.
      // Each action in the `actions` array becomes one HAND_REPLAY_EVENT frame.
      const actions: unknown[] = Array.isArray(rows.actions) ? rows.actions : [];
      const meta = {
        handId,
        handNumber: rows.hand_number,
        gameVariant: rows.game_variant,
        smallBlind: rows.small_blind,
        bigBlind: rows.big_blind,
        communityCards: rows.community_cards,
        players: rows.players,
        winners: rows.winners,
        startedAt: rows.started_at,
        endedAt: rows.ended_at,
      };

      // First frame: hand meta
      channelHub.sendWs(conn.ws, {
        type: 'HAND_REPLAY_EVENT',
        handId,
        event: { frame: 'META', ...meta },
      });

      // Subsequent frames: one per action, with delay
      for (let i = 0; i < actions.length; i++) {
        await this.waitForHandReplayFrame(replay);
        if (!this.handReplayIsCurrent(conn, handId, replay)) return;

        channelHub.sendWs(conn.ws, {
          type: 'HAND_REPLAY_EVENT',
          handId,
          event: { frame: 'ACTION', index: i, total: actions.length, action: actions[i] },
        });
      }

      // Final frame: END marker. Retired streams never announce completion.
      if (!this.handReplayIsCurrent(conn, handId, replay)) return;
      channelHub.sendWs(conn.ws, {
        type: 'HAND_REPLAY_EVENT',
        handId,
        event: { frame: 'END', handId },
      });
    } catch (err: unknown) {
      if (!this.handReplayIsCurrent(conn, handId, replay)) return;
      const msg = err instanceof Error ? err.message : String(err);
      channelHub.sendWs(conn.ws, {
        type: 'CHANNEL_ERROR',
        code: 'REPLAY_ERROR',
        message: `Hand replay failed: ${msg}`,
      });
    } finally {
      replay.cancelWait?.();
      if (conn.handReplays.get(handId) === replay) conn.handReplays.delete(handId);
      this.activeHandReplays.delete(replay);
    }
  }

  // ─── Close ─────────────────────────────────────────────────────────────────

  private onClose(ws: WebSocket): void {
    const conn = this.connections.get(ws);
    if (!conn) return;
    this.cancelHandReplays(conn);
    for (const clubId of conn.clubJoins.keys()) this.cancelClubJoin(conn, clubId);
    // Pass the closing socket so ChannelHub can ignore this teardown if the user
    // has already reconnected on a newer socket (reconnect race).
    channelHub.removeConnection(conn.userId, ws);
    this.connections.delete(ws);
  }

  // ─── Heartbeat ─────────────────────────────────────────────────────────────

  private heartbeatSweep(): void {
    const now = Date.now();
    /* Trust has to be renewed here too (audit, 2026-09-06). The SHARED sweep,
       handed this server's own connection map - the table sockets got this in
       Phase 5 and this one did not, and this is the socket carrying
       FINANCIAL_UPDATE. Runs first so a socket whose session died is closed on
       this sweep rather than pinged and closed on the next. */
    runReauthSweep({
      now,
      connections: this.connections,
      path: () => 'channel' as const,
      verify: (t) => verifyToken(t),
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
    for (const [ws, conn] of this.connections) {
      if (now - conn.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
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
      // 2026-08-24: send the heartbeat in BOTH dialects. The deployed client
      // only recognises {type:'PING'} (it replies {type:'PONG'}); newer
      // clients also answer CHANNEL_PING with CHANNEL_PONG. Sending both
      // means whichever side deploys first, no connection is ever declared
      // dead for speaking the wrong dialect again. (The old code here also
      // sent a stray unsolicited CHANNEL_PONG to the client every sweep —
      // noise that answered nothing; removed.)
      try {
        ws.send(JSON.stringify({ type: 'PING', ts: now }));
        ws.send(JSON.stringify({ type: 'CHANNEL_PING', ts: now }));
      } catch {
        /* next sweep will collect */
      }
    }
  }
}
