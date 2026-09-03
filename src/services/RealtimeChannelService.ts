/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * REALTIME CHANNEL SERVICE — Hetzner WebSocket transport
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Phase 2 (2026-05-18): Migrated from Supabase Realtime to the Hetzner
 * engine WebSocket at wss://engine.smarter.poker/ws/channel.
 *
 * Public interface is IDENTICAL to the previous Supabase-backed version:
 *   subscribeToClub / unsubscribeFromClub
 *   subscribeToTournament / unsubscribeFromTournament
 *   subscribeToLobby / unsubscribeFromLobby
 *   subscribeToHandReplay / unsubscribeFromHand
 *   broadcastClubEvent / broadcastTournamentEvent / streamHandReplay
 *   getClubPresence / getActiveSubscriptions / unsubscribeAll / getDiagnostics
 *
 * All Supabase channel() / subscribe() / unsubscribe() calls have been
 * removed. Zero Supabase Realtime connections are opened by this module.
 *
 * broadcastClubEvent / broadcastTournamentEvent / streamHandReplay are
 * server-side operations. They now POST to the engine HTTP API so only the
 * server (not individual browser clients) fans out events.
 *
 * CHANNELS (now: WebSocket message types via EngineChannelClient):
 * - club:{id}        JOIN_CLUB / LEAVE_CLUB + CLUB_PRESENCE_UPDATE / CLUB_EVENT
 * - tournament:{id}  JOIN_TOURNAMENT / LEAVE_TOURNAMENT + TOURNAMENT_EVENT
 * - lobby:global     JOIN_LOBBY / LEAVE_LOBBY + LOBBY_UPDATE
 * - hand:{id}        REQUEST_HAND_REPLAY + HAND_REPLAY_EVENT
 */

import { engineChannelClient } from './EngineStateClient';
import type {
  ClubPresenceUpdateMessage,
  ClubEventMessage,
  TournamentEventMessage,
  LobbyUpdateMessage,
  HandReplayEventMessage,
} from './EngineStateClient';
import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES  (unchanged public API)
// ═══════════════════════════════════════════════════════════════════════════════

export type ChannelType = 'club' | 'tournament' | 'table' | 'hand' | 'lobby';

export interface ClubPresence {
  id: string;
  displayName: string;
  playerNumber: number;
  avatarUrl: string;
  status: 'online' | 'away' | 'playing';
  currentTableId?: string;
  joinedAt: string;
}

export interface ClubEvent {
  type:
    | 'member_joined'
    | 'member_left'
    | 'table_created'
    | 'table_closed'
    | 'announcement'
    | 'tournament_starting'
    | 'jackpot_hit';
  payload: unknown;
  timestamp: string;
}

export interface TournamentEvent {
  type:
    | 'registration_open'
    | 'registration_closed'
    | 'tournament_started'
    | 'player_registered'
    | 'player_eliminated'
    /* Emitted by finishTournament for the CHAMPION only. Deliberately not
       `player_eliminated` with position 1: TournamentPage and
       TournamentLobbyPage both raise an elimination toast on that event, and
       eliminatePlayer is never called with place 1 anyway — the bust sweep
       reserves it for the winner. See TournamentManagerEliminations. */
    | 'tournament_winner'
    | 'level_up'
    | 'final_table'
    | 'heads_up'
    | 'winner'
    | 'payout'
    | 'hand_for_hand'
    | 'prize_pool_finalized'
    | 'bubble_burst'
    | 'BREAK_START'
    | 'BREAK_END'
    | 'ADDON_PERIOD_START'
    | 'ADDON_PERIOD_END';
  payload: unknown;
  timestamp: string;
}

export interface HandEvent {
  type: 'deal' | 'action' | 'street' | 'showdown' | 'pot_awarded';
  payload: unknown;
  timestamp: string;
}

/** Lightweight record of what's currently subscribed (for diagnostics). */
interface SubscriptionRecord {
  type: ChannelType;
  entityId: string;
  unlisteners: Array<() => void>;
  registeredAt: number;
}

// ─── Engine HTTP base URL (same origin as WS) ──────────────────────────────────

const ENGINE_BASE_URL =
  (import.meta as unknown as { env: Record<string, string> }).env?.VITE_ENGINE_URL ??
  'https://engine.smarter.poker';

function authHeader(): Record<string, string> {
  try {
    const raw = localStorage.getItem('smarter-poker-auth');
    if (!raw) return {};
    const data = JSON.parse(raw) as { access_token?: string };
    return data?.access_token ? { Authorization: `Bearer ${data.access_token}` } : {};
  } catch {
    return {};
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

class RealtimeChannelService {
  private subscriptions: Map<string, SubscriptionRecord> = new Map();
  private presenceState: Map<string, ClubPresence[]> = new Map();

  // ─────────────────────────────────────────────────────────────────────────────
  // CLUB CHANNELS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Subscribe to club channel for presence and events.
   * Sends JOIN_CLUB over the engine WS; registers listeners for
   * CLUB_PRESENCE_UPDATE and CLUB_EVENT messages.
   * Returns a cleanup function.
   */
  subscribeToClub(
    clubId: string,
    _userId: string,
    _userInfo: Omit<ClubPresence, 'joinedAt'>,
    callbacks: {
      onMemberJoin?: (member: ClubPresence) => void;
      onMemberLeave?: (memberId: string) => void;
      onEvent?: (event: ClubEvent) => void;
      onPresenceSync?: (members: ClubPresence[]) => void;
    }
  ): () => void {
    const channelName = `club:${clubId}`;
    if (this.subscriptions.has(channelName)) {
      return () => void this.unsubscribeFromClub(clubId);
    }

    // Tell the engine we're joining this club
    engineChannelClient.send({ type: 'JOIN_CLUB', clubId });

    // Register presence listener
    const unPresence = engineChannelClient.onClubPresence((msg: ClubPresenceUpdateMessage) => {
      if (msg.clubId !== clubId) return;
      this.presenceState.set(clubId, msg.members);
      if (msg.event === 'sync') {
        callbacks.onPresenceSync?.(msg.members);
      } else if (msg.event === 'join' && msg.changed) {
        callbacks.onMemberJoin?.(msg.changed);
      } else if (msg.event === 'leave' && msg.changed) {
        callbacks.onMemberLeave?.(msg.changed.id);
      }
    });

    // Register club event listener
    const unEvent = engineChannelClient.onClubEvent((msg: ClubEventMessage) => {
      if (msg.clubId !== clubId) return;
      callbacks.onEvent?.(msg.event);
    });

    this.subscriptions.set(channelName, {
      type: 'club',
      entityId: clubId,
      unlisteners: [unPresence, unEvent],
      registeredAt: Date.now(),
    });

    return () => void this.unsubscribeFromClub(clubId);
  }

  async unsubscribeFromClub(clubId: string): Promise<void> {
    const channelName = `club:${clubId}`;
    const record = this.subscriptions.get(channelName);
    if (!record) return;

    engineChannelClient.send({ type: 'LEAVE_CLUB', clubId });
    record.unlisteners.forEach((fn) => fn());
    this.subscriptions.delete(channelName);
    this.presenceState.delete(clubId);
  }

  /**
   * Broadcast a club event to all members.
   * Now POSTs to the engine HTTP API — only server-side / admin callers should
   * use this. Browser clients should never broadcast directly.
   */
  async broadcastClubEvent(clubId: string, event: Omit<ClubEvent, 'timestamp'>): Promise<void> {
    try {
      const res = await fetch(`${ENGINE_BASE_URL}/channels/club/${clubId}/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ ...event, timestamp: new Date().toISOString() }),
      });
      if (!res.ok) {
        reportError(
          new Error(`broadcastClubEvent HTTP ${res.status}`),
          'RealtimeChannelService.broadcastClubEvent'
        );
      }
    } catch (e) {
      reportError(e, 'RealtimeChannelService.broadcastClubEvent');
    }
  }

  getClubPresence(clubId: string): ClubPresence[] {
    return this.presenceState.get(clubId) ?? [];
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TOURNAMENT CHANNELS
  // ─────────────────────────────────────────────────────────────────────────────

  subscribeToTournament(
    tournamentId: string,
    callbacks: {
      onEvent?: (event: TournamentEvent) => void;
      onPlayerRegistered?: (player: unknown) => void;
      onPlayerEliminated?: (elimination: unknown) => void;
      onLevelUp?: (level: unknown) => void;
      onWinner?: (winner: unknown) => void;
    }
  ): () => void {
    const channelName = `tournament:${tournamentId}`;
    if (this.subscriptions.has(channelName)) {
      return () => void this.unsubscribeFromTournament(tournamentId);
    }

    engineChannelClient.send({ type: 'JOIN_TOURNAMENT', tournamentId });

    const unTournament = engineChannelClient.onTournamentEvent((msg: TournamentEventMessage) => {
      if (msg.tournamentId !== tournamentId) return;
      const event = msg.event;
      callbacks.onEvent?.(event);
      switch (event.type) {
        case 'player_registered':
          callbacks.onPlayerRegistered?.(event.payload);
          break;
        case 'player_eliminated':
          callbacks.onPlayerEliminated?.(event.payload);
          break;
        case 'level_up':
          callbacks.onLevelUp?.(event.payload);
          break;
        case 'winner':
          callbacks.onWinner?.(event.payload);
          break;
      }
    });

    this.subscriptions.set(channelName, {
      type: 'tournament',
      entityId: tournamentId,
      unlisteners: [unTournament],
      registeredAt: Date.now(),
    });

    return () => void this.unsubscribeFromTournament(tournamentId);
  }

  async unsubscribeFromTournament(tournamentId: string): Promise<void> {
    const channelName = `tournament:${tournamentId}`;
    const record = this.subscriptions.get(channelName);
    if (!record) return;

    engineChannelClient.send({ type: 'LEAVE_TOURNAMENT', tournamentId });
    record.unlisteners.forEach((fn) => fn());
    this.subscriptions.delete(channelName);
  }

  /**
   * Broadcast a tournament event.
   * Server-side / admin only — POSTs to engine HTTP API.
   */
  async broadcastTournamentEvent(
    tournamentId: string,
    event: Omit<TournamentEvent, 'timestamp'>
  ): Promise<void> {
    try {
      const res = await fetch(`${ENGINE_BASE_URL}/channels/tournament/${tournamentId}/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ ...event, timestamp: new Date().toISOString() }),
      });
      if (!res.ok) {
        reportError(
          new Error(`broadcastTournamentEvent HTTP ${res.status}`),
          'RealtimeChannelService.broadcastTournamentEvent'
        );
      }
    } catch (e) {
      reportError(e, 'RealtimeChannelService.broadcastTournamentEvent');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // HAND REPLAY STREAMING
  // ─────────────────────────────────────────────────────────────────────────────

  subscribeToHandReplay(
    handId: string,
    callbacks: {
      onEvent?: (event: HandEvent) => void;
    }
  ): () => void {
    const channelName = `hand:${handId}`;
    if (this.subscriptions.has(channelName)) {
      return () => void this.unsubscribeFromHand(handId);
    }

    engineChannelClient.send({ type: 'REQUEST_HAND_REPLAY', handId });

    const unHand = engineChannelClient.onHandReplayEvent((msg: HandReplayEventMessage) => {
      if (msg.handId !== handId) return;
      callbacks.onEvent?.(msg.event);
    });

    this.subscriptions.set(channelName, {
      type: 'hand',
      entityId: handId,
      unlisteners: [unHand],
      registeredAt: Date.now(),
    });

    return () => void this.unsubscribeFromHand(handId);
  }

  async unsubscribeFromHand(handId: string): Promise<void> {
    const channelName = `hand:${handId}`;
    const record = this.subscriptions.get(channelName);
    if (!record) return;

    // No explicit LEAVE for hand replay — server stops streaming when done.
    record.unlisteners.forEach((fn) => fn());
    this.subscriptions.delete(channelName);
  }

  /**
   * Stream hand events for replay.
   * Server-side only — POSTs to engine HTTP API which drives the stream.
   */
  async streamHandReplay(
    handId: string,
    events: HandEvent[],
    speedMs: number = 1000
  ): Promise<void> {
    try {
      const res = await fetch(`${ENGINE_BASE_URL}/channels/hand/${handId}/replay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ events, speedMs }),
      });
      if (!res.ok) {
        reportError(
          new Error(`streamHandReplay HTTP ${res.status}`),
          'RealtimeChannelService.streamHandReplay'
        );
      }
    } catch (e) {
      reportError(e, 'RealtimeChannelService.streamHandReplay');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // LOBBY CHANNEL (Global)
  // ─────────────────────────────────────────────────────────────────────────────

  subscribeToLobby(callbacks: {
    onClubActivity?: (clubId: string, playersOnline: number) => void;
    onTournamentStarting?: (tournament: unknown) => void;
    onJackpotHit?: (jackpot: unknown) => void;
  }): () => void {
    const channelName = 'lobby:global';
    if (this.subscriptions.has(channelName)) {
      return () => void this.unsubscribeFromLobby();
    }

    engineChannelClient.send({ type: 'JOIN_LOBBY' });

    const unLobby = engineChannelClient.onLobbyUpdate((msg: LobbyUpdateMessage) => {
      switch (msg.kind) {
        case 'club_activity': {
          const p = msg.payload as { clubId: string; playersOnline: number };
          callbacks.onClubActivity?.(p.clubId, p.playersOnline);
          break;
        }
        case 'tournament_starting':
          callbacks.onTournamentStarting?.(msg.payload);
          break;
        case 'jackpot_hit':
          callbacks.onJackpotHit?.(msg.payload);
          break;
      }
    });

    this.subscriptions.set(channelName, {
      type: 'lobby',
      entityId: 'global',
      unlisteners: [unLobby],
      registeredAt: Date.now(),
    });

    return () => void this.unsubscribeFromLobby();
  }

  async unsubscribeFromLobby(): Promise<void> {
    const channelName = 'lobby:global';
    const record = this.subscriptions.get(channelName);
    if (!record) return;

    engineChannelClient.send({ type: 'LEAVE_LOBBY' });
    record.unlisteners.forEach((fn) => fn());
    this.subscriptions.delete(channelName);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // UTILITIES
  // ─────────────────────────────────────────────────────────────────────────────

  getActiveSubscriptions(): Array<{ channel: string; type: ChannelType; entityId: string }> {
    return Array.from(this.subscriptions.entries()).map(([channel, sub]) => ({
      channel,
      type: sub.type,
      entityId: sub.entityId,
    }));
  }

  async unsubscribeAll(): Promise<void> {
    // Send LEAVE messages for everything still subscribed
    for (const [channelName, record] of this.subscriptions) {
      try {
        if (record.type === 'club') {
          engineChannelClient.send({ type: 'LEAVE_CLUB', clubId: record.entityId });
        } else if (record.type === 'tournament') {
          engineChannelClient.send({ type: 'LEAVE_TOURNAMENT', tournamentId: record.entityId });
        } else if (record.type === 'lobby') {
          engineChannelClient.send({ type: 'LEAVE_LOBBY' });
        }
        record.unlisteners.forEach((fn) => fn());
      } catch (e) {
        reportError(e, `RealtimeChannelService.unsubscribeAll.${channelName}`);
      }
    }
    this.subscriptions.clear();
    this.presenceState.clear();
  }

  getDiagnostics() {
    return {
      subscriptions: {
        count: this.subscriptions.size,
        byType: this.getSubscriptionsByType(),
        details: Array.from(this.subscriptions.entries()).map(([name, sub]) => ({
          name,
          type: sub.type,
          entityId: sub.entityId,
        })),
      },
      transport: 'hetzner-websocket',
      engineStatus: engineChannelClient.getStatus(),
    };
  }

  private getSubscriptionsByType(): Record<string, number> {
    const grouped: Record<string, number> = {};
    this.subscriptions.forEach((sub) => {
      grouped[sub.type] = (grouped[sub.type] || 0) + 1;
    });
    return grouped;
  }
}

export const realtimeChannelService = new RealtimeChannelService();
export { RealtimeChannelService };
export default realtimeChannelService;
