/**
 * ♠ CLUB ARENA — Multiplayer Room Service
 * Real-time WebSocket synchronization for poker tables
 */

import { supabase } from '../lib/supabase';
import type { RealtimeChannel } from '@supabase/supabase-js';
import type { SeatPlayer, Card, ActionType, HandStage } from '../types/database.types';
import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface TableRoomState {
  tableId: string;
  players: Map<number, SeatPlayer>; // seat -> player
  communityCards: Card[];
  pot: number;
  currentBet: number;
  stage: HandStage;
  currentPlayerSeat: number;
  dealerSeat: number;
  handNumber: number;
}

export interface RoomMessage {
  type:
    | 'PLAYER_JOINED'
    | 'PLAYER_LEFT'
    | 'PLAYER_ACTION'
    | 'HAND_START'
    | 'CARDS_DEALT'
    | 'COMMUNITY_CARDS'
    | 'TURN_CHANGE'
    | 'SHOWDOWN'
    | 'HAND_COMPLETE'
    | 'CHAT'
    | 'PRESENCE_SYNC';
  payload: unknown;
  sender: string;
  timestamp: number;
}

export interface PlayerPresence {
  userId: string;
  seat: number;
  username: string;
  stack: number;
  status: 'active' | 'away' | 'sitting_out';
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROOM SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

class RoomService {
  private channels: Map<string, RealtimeChannel> = new Map();
  private presenceState: Map<string, Map<string, PlayerPresence>> = new Map();
  private messageHandlers: Map<string, ((msg: RoomMessage) => void)[]> = new Map();

  // ─────────────────────────────────────────────────────────────────────────────
  // Channel Management
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Register an existing channel (from TableWebSocket) to deduplicate subscriptions.
   */
  registerChannel(tableId: string, channel: RealtimeChannel): void {
    // 2026-08-22: rebind on reconnect. This used to early-return whenever ANY
    // channel was registered for the table — but TableWebSocket re-creates
    // its channel on every reconnect, so after the first drop RoomService
    // kept broadcasting reactions/throwables/chat into the REMOVED channel
    // (no error, nothing delivered) and inbound room messages stopped. Same
    // channel object: nothing to do; new channel object: replace the binding.
    if (this.channels.get(tableId) === channel) return;

    // Handle broadcasts
    channel.on('broadcast', { event: 'game_event' }, (payload) => {
      if (this.channels.get(tableId) !== channel) return;
      this.handleMessage(tableId, payload.payload as RoomMessage);
    });

    // Handle presence sync
    channel.on('presence', { event: 'sync' }, () => {
      if (this.channels.get(tableId) !== channel) return;
      const state = channel.presenceState();
      this.updatePresence(tableId, state);
    });

    // Handle joins
    channel.on('presence', { event: 'join' }, ({ key, newPresences }) => {
      if (this.channels.get(tableId) !== channel) return;
      this.notifyHandlers(tableId, {
        type: 'PLAYER_JOINED',
        payload: { userId: key, presences: newPresences },
        sender: 'system',
        timestamp: Date.now(),
      });
    });

    // Handle leaves
    channel.on('presence', { event: 'leave' }, ({ key, leftPresences }) => {
      if (this.channels.get(tableId) !== channel) return;
      this.notifyHandlers(tableId, {
        type: 'PLAYER_LEFT',
        payload: { userId: key, presences: leftPresences },
        sender: 'system',
        timestamp: Date.now(),
      });
    });

    this.channels.set(tableId, channel);
  }

  /**
   * Leave a table room
   */
  async leaveRoom(tableId: string): Promise<void> {
    // We do NOT call untrack() or removeChannel() here because TableWebSocket owns the channel.
    // We just clean up local RoomService references.
    this.channels.delete(tableId);
    this.presenceState.delete(tableId);
    this.messageHandlers.delete(tableId);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Broadcasting
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Broadcast a game event to all players at the table
   */
  async broadcast(tableId: string, message: Omit<RoomMessage, 'timestamp'>): Promise<void> {
    const channel = this.channels.get(tableId);
    if (!channel) {
      reportError(new Error('Not connected to room'), 'RoomService.send', { tableId });
      return;
    }

    await channel.send({
      type: 'broadcast',
      event: 'game_event',
      payload: {
        ...message,
        timestamp: Date.now(),
      },
    });
  }

  /**
   * Broadcast a player action
   */
  async broadcastAction(
    tableId: string,
    seat: number,
    action: ActionType,
    amount: number,
    sender: string
  ): Promise<void> {
    await this.broadcast(tableId, {
      type: 'PLAYER_ACTION',
      payload: { seat, action, amount },
      sender,
    });
  }

  /**
   * Broadcast hand start
   */
  async broadcastHandStart(
    tableId: string,
    handNumber: number,
    dealerSeat: number,
    players: SeatPlayer[]
  ): Promise<void> {
    await this.broadcast(tableId, {
      type: 'HAND_START',
      payload: { handNumber, dealerSeat, players },
      sender: 'dealer',
    });
  }

  /**
   * Broadcast community cards
   */
  async broadcastCommunityCards(tableId: string, stage: HandStage, cards: Card[]): Promise<void> {
    await this.broadcast(tableId, {
      type: 'COMMUNITY_CARDS',
      payload: { stage, cards },
      sender: 'dealer',
    });
  }

  /**
   * Send chat message
   */
  async sendChat(tableId: string, senderId: string, message: string): Promise<void> {
    await this.broadcast(tableId, {
      type: 'CHAT',
      payload: { message },
      sender: senderId,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Event Handling
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Subscribe to room messages
   */
  onMessage(tableId: string, handler: (msg: RoomMessage) => void): () => void {
    const handlers = this.messageHandlers.get(tableId) || [];
    handlers.push(handler);
    this.messageHandlers.set(tableId, handlers);

    // Return unsubscribe function
    return () => {
      const current = this.messageHandlers.get(tableId) || [];
      this.messageHandlers.set(
        tableId,
        current.filter((h) => h !== handler)
      );
    };
  }

  private handleMessage(tableId: string, message: RoomMessage): void {
    this.notifyHandlers(tableId, message);
  }

  private notifyHandlers(tableId: string, message: RoomMessage): void {
    const handlers = this.messageHandlers.get(tableId) || [];
    for (const handler of handlers) {
      try {
        handler(message);
      } catch (error: unknown) {
        reportError(error, 'RoomService.handler');
      }
    }
  }

  private updatePresence(tableId: string, state: Record<string, unknown>): void {
    const presenceMap = new Map<string, PlayerPresence>();

    for (const [userId, presences] of Object.entries(state)) {
      const presence = (presences as PlayerPresence[])[0];
      if (presence) {
        presenceMap.set(userId, presence);
      }
    }

    this.presenceState.set(tableId, presenceMap);

    // Notify handlers
    this.notifyHandlers(tableId, {
      type: 'PRESENCE_SYNC',
      payload: Array.from(presenceMap.values()),
      sender: 'system',
      timestamp: Date.now(),
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Getters
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get current presence for a table
   */
  getPresence(tableId: string): PlayerPresence[] {
    const presenceMap = this.presenceState.get(tableId);
    if (!presenceMap) return [];
    return Array.from(presenceMap.values());
  }

  /**
   * Check if connected to a room
   */
  isConnected(tableId: string): boolean {
    return this.channels.has(tableId);
  }
}

export const roomService = new RoomService();
