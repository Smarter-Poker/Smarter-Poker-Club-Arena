/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ChannelHub — in-memory pub/sub for the /ws/channel endpoint
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Replaces Supabase Realtime for club presence, tournament events, lobby
 * updates, hand replays, and financial notifications. All routing for the
 * /ws/channel endpoint is managed here — ChannelWebSocketServer is the thin
 * transport layer that calls into this hub.
 *
 * Data model
 * ----------
 *   connections:    Map<userId, WebSocket>
 *   clubSubs:       Map<clubId, Set<userId>>
 *   tournamentSubs: Map<tournamentId, Set<userId>>
 *   lobbySubscribers: Set<userId>
 *   presence:       Map<clubId, Map<userId, ClubPresence>>
 *
 * Every 30 s broadcastLobbyUpdate() fires via setInterval and sends current
 * online counts for all clubs to lobby subscribers.
 *
 * Thread safety: Node.js is single-threaded, so all Map/Set operations are
 * inherently safe. No locking needed.
 *
 * @version 1.1.0 — 2026-05-18
 */

import { WebSocket } from 'ws';

// ─── Domain types ─────────────────────────────────────────────────────────────

export interface ClubPresence {
  userId: string;
  status: 'online' | 'at_table' | 'away';
  currentTableId?: string;
  /** ISO timestamp of last status change. */
  updatedAt: string;
}

export type ClubEvent = Record<string, unknown>;
export type TournamentEvent = Record<string, unknown>;
export type HandEvent = Record<string, unknown>;

// ─── Server → Client message shapes ─────────────────────────────────────────

interface ClubPresenceUpdateMsg {
  type: 'CLUB_PRESENCE_UPDATE';
  clubId: string;
  members: ClubPresence[];
  event: 'sync' | 'join' | 'leave';
  changed?: ClubPresence;
}

interface ClubEventMsg {
  type: 'CLUB_EVENT';
  clubId: string;
  event: ClubEvent;
}

interface TournamentEventMsg {
  type: 'TOURNAMENT_EVENT';
  tournamentId: string;
  event: TournamentEvent;
}

interface LobbyUpdateMsg {
  type: 'LOBBY_UPDATE';
  kind?: 'maintenance';
  payload: unknown;
}

interface HandReplayEventMsg {
  type: 'HAND_REPLAY_EVENT';
  handId: string;
  event: HandEvent;
}

interface ChannelErrorMsg {
  type: 'CHANNEL_ERROR';
  code: string;
  message: string;
}

type OutboundMessage =
  | ClubPresenceUpdateMsg
  | ClubEventMsg
  | TournamentEventMsg
  | LobbyUpdateMsg
  | HandReplayEventMsg
  | ChannelErrorMsg
  | { type: 'CHANNEL_PONG' }
  | { type: 'TABLE_META_UPDATE'; tableId: string; table: unknown }
  | {
      type: 'FINANCIAL_UPDATE';
      userId: string;
      walletType: string;
      available: number;
      total: number;
      ledgerEntry?: unknown;
    };

// ─── ChannelHub ───────────────────────────────────────────────────────────────

export class ChannelHub {
  // userId → live sockets for that user (one per tab / device).
  //
  // 2026-08-24 MULTI-TAB FIX: this was Map<userId, WebSocket> and
  // addConnection() closed the user's existing socket on every new one —
  // "one socket per userId". With TWO tabs open (lobby + table, or
  // multi-table play, or phone + desktop) the tabs EVICTED EACH OTHER in an
  // endless loop: A connects → B connects, kills A → A auto-reconnects,
  // kills B → forever. Every cycle dropped subscriptions and burned an auth
  // round-trip, and the user saw wallet/tournament/lobby feeds flap
  // permanently. A user is now allowed several sockets; subscriptions are
  // torn down only when the LAST one closes.
  private connections: Map<string, Set<WebSocket>> = new Map();

  /** Cap per user — bounds a leak or a hostile client, generous for real use. */
  private static readonly MAX_SOCKETS_PER_USER = 8;

  // clubId → Set<userId>
  private clubSubs: Map<string, Set<string>> = new Map();

  // tournamentId → Set<userId>
  private tournamentSubs: Map<string, Set<string>> = new Map();

  // Set of userIds subscribed to the lobby
  private lobbySubscribers: Set<string> = new Set();

  // clubId → Map<userId, ClubPresence>
  private presence: Map<string, Map<string, ClubPresence>> = new Map();

  // Lobby broadcast interval handle
  private lobbyInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.lobbyInterval = setInterval(() => this.broadcastLobbyUpdate(), 30_000);
  }

  /**
   * Stop the lobby interval on server shutdown.
   */
  close(): void {
    if (this.lobbyInterval) {
      clearInterval(this.lobbyInterval);
      this.lobbyInterval = null;
    }
  }

  // ─── Connection lifecycle ───────────────────────────────────────────────────

  /**
   * Register a new authenticated connection. A user may hold several live
   * sockets (tabs/devices); beyond MAX_SOCKETS_PER_USER the OLDEST is closed.
   */
  addConnection(userId: string, ws: WebSocket): void {
    let set = this.connections.get(userId);
    if (!set) {
      set = new Set();
      this.connections.set(userId, set);
    }
    set.add(ws);
    if (set.size > ChannelHub.MAX_SOCKETS_PER_USER) {
      // Set preserves insertion order — the first entry is the oldest socket.
      const oldest = set.values().next().value;
      if (oldest && oldest !== ws) {
        set.delete(oldest);
        try {
          oldest.close(1001, 'too many connections for this user');
        } catch {
          /* ignore */
        }
      }
    }
  }

  /**
   * Tear down all subscriptions for a user and remove their connection entry.
   * Called from ChannelWebSocketServer on ws.close / ws.error.
   *
   * `closingWs` guards the reconnect race: addConnection() closes the OLD socket
   * when a user reconnects, which fires this handler for the OLD socket AFTER the
   * NEW socket is already registered. Without the guard we would tear down the
   * NEW connection's subscriptions and delete its entry, blinding the just-
   * reconnected user. Only tear down when the closing socket is still the current
   * one (or when no socket is provided, for legacy/explicit removal).
   */
  removeConnection(userId: string, closingWs?: WebSocket): void {
    const set = this.connections.get(userId);
    if (closingWs) {
      // Late close of a socket that is no longer registered (already evicted,
      // or torn down by a previous full removal) — nothing to do. This is the
      // same reconnect-race guard as before, generalised to the multi-socket
      // model.
      if (!set || !set.has(closingWs)) return;
      set.delete(closingWs);
      // Other tabs/devices still live: keep every subscription. Presence and
      // club/tournament/lobby feeds belong to the USER, not to one socket.
      if (set.size > 0) return;
    }
    // Last socket (or legacy full removal): tear the user down.
    // Fan out leave events for every club the user was subscribed to.
    for (const [clubId, members] of this.clubSubs) {
      if (members.has(userId)) {
        members.delete(userId);
        // Clean up presence
        const presenceMap = this.presence.get(clubId);
        if (presenceMap) {
          presenceMap.delete(userId);
        }
        // Fan out leave event to remaining club members
        this._broadcastLeaveEvent(userId, clubId);
      }
    }

    for (const members of this.tournamentSubs.values()) {
      members.delete(userId);
    }

    this.lobbySubscribers.delete(userId);
    this.connections.delete(userId);
  }

  // ─── Club subscriptions ─────────────────────────────────────────────────────

  /**
   * Subscribe a user to a club channel.
   * Immediately sends a CLUB_PRESENCE_UPDATE sync to the new subscriber,
   * then fans out a join event to all existing subscribers.
   */
  joinClub(userId: string, clubId: string): void {
    const members = this._getOrCreateSet(this.clubSubs, clubId);
    const alreadyJoined = members.has(userId);
    members.add(userId);

    // Seed presence if not already tracked
    this._ensurePresence(userId, clubId);

    if (!alreadyJoined) {
      // Send full sync to the new subscriber
      const presenceMap = this.presence.get(clubId)!;
      const allMembers = Array.from(presenceMap.values());
      const userPresence = presenceMap.get(userId)!;

      const syncMsg: ClubPresenceUpdateMsg = {
        type: 'CLUB_PRESENCE_UPDATE',
        clubId,
        members: allMembers,
        event: 'sync',
      };
      this.sendToUserSockets(userId, syncMsg);

      // Fan out join event to everyone else in the club
      const joinMsg: ClubPresenceUpdateMsg = {
        type: 'CLUB_PRESENCE_UPDATE',
        clubId,
        members: allMembers,
        event: 'join',
        changed: userPresence,
      };
      for (const memberId of members) {
        if (memberId === userId) continue;
        this.sendToUserSockets(memberId, joinMsg);
      }
    }
  }

  /**
   * Unsubscribe a user from a club channel and fan out the leave event.
   */
  leaveClub(userId: string, clubId: string): void {
    const members = this.clubSubs.get(clubId);
    if (!members) return;

    members.delete(userId);

    const presenceMap = this.presence.get(clubId);
    const leavingPresence = presenceMap?.get(userId);
    presenceMap?.delete(userId);

    // Fan out leave event to remaining members
    const remaining = Array.from(presenceMap?.values() ?? []);
    const leaveMsg: ClubPresenceUpdateMsg = {
      type: 'CLUB_PRESENCE_UPDATE',
      clubId,
      members: remaining,
      event: 'leave',
      changed: leavingPresence,
    };
    for (const memberId of members) {
      this.sendToUserSockets(memberId, leaveMsg);
    }
  }

  /**
   * Update the presence status for a user in a club and fan out a sync.
   */
  updatePresence(
    userId: string,
    clubId: string,
    status: 'online' | 'at_table' | 'away',
    currentTableId?: string
  ): void {
    // Ensure subscribed
    const members = this._getOrCreateSet(this.clubSubs, clubId);
    members.add(userId);

    const presenceMap = this._getOrCreatePresenceMap(clubId);
    const entry: ClubPresence = {
      userId,
      status,
      currentTableId,
      updatedAt: new Date().toISOString(),
    };
    presenceMap.set(userId, entry);

    const allMembers = Array.from(presenceMap.values());
    const syncMsg: ClubPresenceUpdateMsg = {
      type: 'CLUB_PRESENCE_UPDATE',
      clubId,
      members: allMembers,
      event: 'sync',
      changed: entry,
    };
    this.broadcastToClub(clubId, syncMsg);
  }

  // ─── Tournament subscriptions ───────────────────────────────────────────────

  /** B13: is this user currently subscribed to that club's channel? */
  isInClub(userId: string, clubId: string): boolean {
    return this.clubSubs.get(clubId)?.has(userId) ?? false;
  }

  joinTournament(userId: string, tournamentId: string): void {
    this._getOrCreateSet(this.tournamentSubs, tournamentId).add(userId);
  }

  leaveTournament(userId: string, tournamentId: string): void {
    this.tournamentSubs.get(tournamentId)?.delete(userId);
  }

  // ─── Lobby subscriptions ────────────────────────────────────────────────────

  joinLobby(userId: string): void {
    this.lobbySubscribers.add(userId);
  }

  leaveLobby(userId: string): void {
    this.lobbySubscribers.delete(userId);
  }

  // ─── Broadcast helpers ──────────────────────────────────────────────────────

  /**
   * Send a message to all subscribers of a club.
   */
  broadcastToClub(clubId: string, msg: OutboundMessage): void {
    const members = this.clubSubs.get(clubId);
    if (!members) return;
    for (const userId of members) {
      this.sendToUserSockets(userId, msg);
    }
  }

  /**
   * Send a message to all subscribers of a tournament.
   */
  broadcastToTournament(tournamentId: string, msg: OutboundMessage): void {
    const members = this.tournamentSubs.get(tournamentId);
    if (!members) return;
    for (const userId of members) {
      this.sendToUserSockets(userId, msg);
    }
  }

  /**
   * Send a message to all lobby subscribers.
   */
  broadcastToLobby(msg: OutboundMessage): void {
    for (const userId of this.lobbySubscribers) {
      this.sendToUserSockets(userId, msg);
    }
  }

  /**
   * Send a message to a specific user by userId — every tab/device they hold.
   */
  sendToUser(userId: string, msg: OutboundMessage): void {
    this.sendToUserSockets(userId, msg);
  }

  /**
   * Build and send a LOBBY_UPDATE with current online counts per club.
   * Called every 30 s by the internal interval, and can be called directly
   * when club state changes.
   */
  broadcastLobbyUpdate(): void {
    if (this.lobbySubscribers.size === 0) return;

    const clubCounts: Record<string, number> = {};
    for (const [clubId, members] of this.clubSubs) {
      clubCounts[clubId] = members.size;
    }

    const msg: LobbyUpdateMsg = {
      type: 'LOBBY_UPDATE',
      payload: { clubOnlineCounts: clubCounts, ts: Date.now() },
    };
    this.broadcastToLobby(msg);
  }

  /**
   * Safe JSON.stringify + ws.send. Swallows errors — a dead socket will be
   * evicted on the next removeConnection() call.
   */
  sendWs(ws: WebSocket, msg: OutboundMessage): void {
    if (ws.readyState !== 1 /* ws.OPEN */) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* swallow — transport error handled by ws.on('error') */
    }
  }

  /** Send to EVERY live socket a user holds (all tabs / devices). */
  private sendToUserSockets(userId: string, msg: OutboundMessage): void {
    const set = this.connections.get(userId);
    if (!set) return;
    for (const ws of set) this.sendWs(ws, msg);
  }

  // ─── Metrics (used by /ws-metrics and tests) ────────────────────────────────

  connectionCount(): number {
    // Total live sockets across all users (a user with 2 tabs counts as 2).
    let n = 0;
    for (const set of this.connections.values()) n += set.size;
    return n;
  }

  /** Distinct users with at least one live socket. */
  userCount(): number {
    return this.connections.size;
  }

  clubSubscriberCount(clubId: string): number {
    return this.clubSubs.get(clubId)?.size ?? 0;
  }

  tournamentSubscriberCount(tournamentId: string): number {
    return this.tournamentSubs.get(tournamentId)?.size ?? 0;
  }

  lobbySubscriberCount(): number {
    return this.lobbySubscribers.size;
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private _getOrCreateSet<K>(map: Map<K, Set<string>>, key: K): Set<string> {
    let s = map.get(key);
    if (!s) {
      s = new Set();
      map.set(key, s);
    }
    return s;
  }

  private _getOrCreatePresenceMap(clubId: string): Map<string, ClubPresence> {
    let m = this.presence.get(clubId);
    if (!m) {
      m = new Map();
      this.presence.set(clubId, m);
    }
    return m;
  }

  private _ensurePresence(userId: string, clubId: string): void {
    const presenceMap = this._getOrCreatePresenceMap(clubId);
    if (!presenceMap.has(userId)) {
      presenceMap.set(userId, {
        userId,
        status: 'online',
        updatedAt: new Date().toISOString(),
      });
    }
  }

  private _broadcastLeaveEvent(userId: string, clubId: string): void {
    const members = this.clubSubs.get(clubId);
    if (!members || members.size === 0) return;

    const presenceMap = this.presence.get(clubId);
    const remaining = Array.from(presenceMap?.values() ?? []);

    const leaveMsg: ClubPresenceUpdateMsg = {
      type: 'CLUB_PRESENCE_UPDATE',
      clubId,
      members: remaining,
      event: 'leave',
      changed: { userId, status: 'away', updatedAt: new Date().toISOString() },
    };
    for (const memberId of members) {
      this.sendToUserSockets(memberId, leaveMsg);
    }
  }
}

// Singleton — the server uses one global hub. Tests construct fresh instances.
export const channelHub = new ChannelHub();
