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
 * Heartbeat: server sends CHANNEL_PING every 25 s; closes after 60 s without
 * a matching CHANNEL_PONG from the client.
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
import { extractBearerToken } from './wsHelpers.js';
import { channelHub } from '../hub/ChannelHub.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_TIMEOUT_MS = 60_000;
const INBOUND_RATE_LIMIT = 30; // messages per second per connection
const INBOUND_RATE_WINDOW_MS = 1_000;
const MAX_INBOUND_MESSAGE_BYTES = 8 * 1024;
const HAND_REPLAY_DELAY_MS = 200;

// Close codes
const CLOSE_BAD_REQUEST = 4400;
const CLOSE_AUTH_FAILED = 4401;
const CLOSE_RATE_LIMITED = 4429;

// ─── Types ────────────────────────────────────────────────────────────────────

interface ConnectionState {
  userId: string;
  ws: WebSocket;
  lastPongAt: number;
  inboundCount: number;
  inboundWindowStart: number;
}

// Inbound message discriminated union
type InboundMessage =
  | { type: 'JOIN_CLUB'; clubId: string }
  | { type: 'LEAVE_CLUB'; clubId: string }
  | { type: 'UPDATE_PRESENCE'; clubId: string; status: 'online' | 'at_table' | 'away'; currentTableId?: string }
  | { type: 'JOIN_TOURNAMENT'; tournamentId: string }
  | { type: 'LEAVE_TOURNAMENT'; tournamentId: string }
  | { type: 'JOIN_LOBBY' }
  | { type: 'LEAVE_LOBBY' }
  | { type: 'REQUEST_HAND_REPLAY'; handId: string }
  | { type: 'CHANNEL_PING' }
  | { type: 'CHANNEL_PONG' };

// ─── Default JWT verification ─────────────────────────────────────────────────

async function verifyToken(token: string): Promise<{ userId: string } | null> {
  if (!token) return null;
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return null;
    return { userId: data.user.id };
  } catch {
    return null;
  }
}

// ─── ChannelWebSocketServer ───────────────────────────────────────────────────

export class ChannelWebSocketServer {
  private wss: WebSocketServer;
  private connections: Map<WebSocket, ConnectionState> = new Map();
  private heartbeatTimer: NodeJS.Timeout | null = null;

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

      const token = extractBearerToken(req.headers['sec-websocket-protocol']);
      if (!token) {
        socket.write('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      verifyToken(token)
        .then((auth) => {
          if (!auth) {
            socket.write(
              'HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
            );
            socket.destroy();
            return;
          }

          this.wss.handleUpgrade(req, socket, head, (ws) => {
            this.onUpgraded(ws, auth.userId);
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

  private onUpgraded(ws: WebSocket, userId: string): void {
    const conn: ConnectionState = {
      userId,
      ws,
      lastPongAt: Date.now(),
      inboundCount: 0,
      inboundWindowStart: Date.now(),
    };
    this.connections.set(ws, conn);
    channelHub.addConnection(userId, ws);

    ws.on('message', (raw) => this.onMessage(conn, raw));
    ws.on('close', () => this.onClose(ws));
    ws.on('error', () => this.onClose(ws));
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

    const { userId } = conn;

    switch (msg.type) {
      case 'CHANNEL_PONG':
        conn.lastPongAt = Date.now();
        return;

      case 'CHANNEL_PING':
        // Client-initiated ping → server replies with PONG immediately
        channelHub.sendToUser(userId, { type: 'CHANNEL_PONG' });
        return;

      case 'JOIN_CLUB':
        if (typeof msg.clubId === 'string' && msg.clubId) {
          channelHub.joinClub(userId, msg.clubId);
        }
        return;

      case 'LEAVE_CLUB':
        if (typeof msg.clubId === 'string' && msg.clubId) {
          channelHub.leaveClub(userId, msg.clubId);
        }
        return;

      case 'UPDATE_PRESENCE':
        if (
          typeof msg.clubId === 'string' &&
          msg.clubId &&
          (msg.status === 'online' || msg.status === 'at_table' || msg.status === 'away')
        ) {
          channelHub.updatePresence(userId, msg.clubId, msg.status, msg.currentTableId);
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
          void this.streamHandReplay(userId, msg.handId);
        }
        return;

      default:
        // Unknown message types are silently ignored
        return;
    }
  }

  // ─── Hand replay ───────────────────────────────────────────────────────────

  /**
   * Query hand_history for all events matching handId and stream them
   * to the requesting user with HAND_REPLAY_DELAY_MS between each frame.
   */
  private async streamHandReplay(userId: string, handId: string): Promise<void> {
    try {
      const { data: rows, error } = await supabase
        .from('hand_history')
        .select('id, hand_number, actions, players, community_cards, winners, game_variant, small_blind, big_blind, started_at, ended_at, raw_events')
        .eq('id', handId)
        .limit(1)
        .maybeSingle();

      if (error || !rows) {
        channelHub.sendToUser(userId, {
          type: 'CHANNEL_ERROR',
          code: 'HAND_NOT_FOUND',
          message: `Hand ${handId} not found`,
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
      channelHub.sendToUser(userId, {
        type: 'HAND_REPLAY_EVENT',
        handId,
        event: { frame: 'META', ...meta },
      });

      // Subsequent frames: one per action, with delay
      for (let i = 0; i < actions.length; i++) {
        await new Promise<void>((resolve) => setTimeout(resolve, HAND_REPLAY_DELAY_MS));

        // Check connection is still alive before sending next frame.
        // connections is Map<WebSocket, ConnectionState> — look up the ConnectionState by userId,
        // then check ws.readyState directly (avoids the TS2339 error from accessing readyState
        // on ConnectionState instead of WebSocket).
        const connEntry = [...this.connections.values()].find((c) => c.userId === userId);
        if (!connEntry || connEntry.ws.readyState !== WebSocket.OPEN) break;

        channelHub.sendToUser(userId, {
          type: 'HAND_REPLAY_EVENT',
          handId,
          event: { frame: 'ACTION', index: i, total: actions.length, action: actions[i] },
        });
      }

      // Final frame: END marker
      channelHub.sendToUser(userId, {
        type: 'HAND_REPLAY_EVENT',
        handId,
        event: { frame: 'END', handId },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      channelHub.sendToUser(userId, {
        type: 'CHANNEL_ERROR',
        code: 'REPLAY_ERROR',
        message: `Hand replay failed: ${msg}`,
      });
    }
  }

  // ─── Close ─────────────────────────────────────────────────────────────────

  private onClose(ws: WebSocket): void {
    const conn = this.connections.get(ws);
    if (!conn) return;
    // Pass the closing socket so ChannelHub can ignore this teardown if the user
    // has already reconnected on a newer socket (reconnect race).
    channelHub.removeConnection(conn.userId, ws);
    this.connections.delete(ws);
  }

  // ─── Heartbeat ─────────────────────────────────────────────────────────────

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
      // Send server-initiated ping — client must reply CHANNEL_PONG
      channelHub.sendToUser(conn.userId, { type: 'CHANNEL_PONG' });
      // Actually send a distinct PING frame that the client recognises
      try {
        ws.send(JSON.stringify({ type: 'CHANNEL_PING', ts: now }));
      } catch {
        /* next sweep will collect */
      }
    }
  }
}
