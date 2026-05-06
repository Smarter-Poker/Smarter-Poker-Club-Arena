/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  WEBSOCKET CLIENT — Real-Time Game State Sync
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Supabase Realtime + fallback WebSocket client for table state synchronization.
 * Features:
 * - Auto-reconnection with exponential backoff
 * - Presence tracking (who's at the table)
 * - Optimistic updates with server reconciliation
 * - Event-based game state broadcasting
 */

import { RealtimeChannel, RealtimePresenceState } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';
import GameServerAPI from './GameServerAPI';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type GameEventType =
  | 'PLAYER_JOIN'
  | 'PLAYER_LEAVE'
  | 'PLAYER_SIT'
  | 'PLAYER_STAND'
  | 'GAME_START'
  | 'DEAL_CARDS'
  | 'PLAYER_ACTION'
  | 'BETTING_ROUND'
  | 'SHOWDOWN'
  | 'POT_WIN'
  | 'HAND_COMPLETE'
  | 'CHAT_MESSAGE'
  | 'TABLE_SETTINGS'
  | 'TIMER_UPDATE';

export interface GameEvent {
  type: GameEventType;
  tableId: string;
  handId?: string;
  playerId?: string;
  data: Record<string, unknown>;
  timestamp: number;
  sequence: number;
}

export interface PlayerPresence {
  userId: string;
  username: string;
  avatar?: string;
  seatNumber?: number;
  status: 'watching' | 'sitting' | 'away';
  joinedAt: number;
}

export interface TablePresenceState {
  players: PlayerPresence[];
  observers: PlayerPresence[];
  dealerPosition: number;
}

export type EventHandler = (event: GameEvent) => void;
export type PresenceHandler = (state: TablePresenceState) => void;
export type ConnectionHandler = (connected: boolean) => void;

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000]; // Exponential backoff

// ═══════════════════════════════════════════════════════════════════════════════
// WEBSOCKET CLIENT CLASS
// Uses the shared Supabase client to avoid "Multiple GoTrueClient instances"
// ═══════════════════════════════════════════════════════════════════════════════

export class TableWebSocket {
  private supabase = supabase;

  private channel: RealtimeChannel | null = null;
  private tableId: string;
  private userId: string;
  private username: string;

  private eventHandlers: Set<EventHandler> = new Set();
  private presenceHandlers: Set<PresenceHandler> = new Set();
  private connectionHandlers: Set<ConnectionHandler> = new Set();

  private isConnected = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private lastSequence = -1;
  private pendingEvents: GameEvent[] = [];

  constructor(tableId: string, userId: string, username: string) {
    this.tableId = tableId;
    this.userId = userId;
    this.username = username;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // CONNECTION MANAGEMENT
  // ─────────────────────────────────────────────────────────────────────────────

  async connect(): Promise<boolean> {
    if (!this.supabase) {
      reportError('Supabase not configured, running in offline mode', 'TableWS.connect.noSupabase');
      return false;
    }

    try {
      // Ensure auth session is ready before subscribing to channel
      const {
        data: { session },
      } = await this.supabase.auth.getSession();
      if (!session) {
        reportError('No auth session, scheduling reconnect', 'TableWS.connect.noAuth');
        this.scheduleReconnect();
        return false;
      }

      // Create channel for this table
      this.channel = this.supabase.channel(`table:${this.tableId}`, {
        config: {
          presence: { key: this.userId },
          broadcast: { self: false },
        },
      });

      // Register with RoomService to share the channel and prevent duplicate subscriptions
      import('./RoomService').then(({ roomService }) => {
        roomService.registerChannel(this.tableId, this.channel!);
      });

      // Set up event listeners
      this.channel
        .on('broadcast', { event: 'game_event' }, ({ payload }) => {
          this.handleGameEvent(payload as GameEvent);
        })
        .on('broadcast', { event: 'time_bank_activated' }, ({ payload }) => {
          // Fire MasterBus event so UI timers reload for opponents!
          import('../core/MasterBus').then(
            ({ masterBus }) => {
              masterBus.emit('TIME_BANK_ACTIVATED', {
                playerId: payload.player_id,
                tableId: payload.table_id,
                secondsGranted: payload.additional_seconds,
                usesRemaining: payload.uses_remaining ?? 0,
                totalRemaining: payload.total_remaining ?? 0,
              });
            },
            (err) => console.warn('[TableWS] Failed to import MasterBus:', err)
          );
        })
        .on('presence', { event: 'sync' }, () => {
          this.handlePresenceSync();
        })
        .on('presence', { event: 'join' }, ({ newPresences }) => {})
        .on('presence', { event: 'leave' }, ({ leftPresences }) => {});

      // Subscribe to channel - returns the channel, callback receives status
      await new Promise<void>((resolve, reject) => {
        this.channel!.subscribe(async (status) => {
          // Prevent zombie subscriptions if disconnect() was called during subscribe
          if (!this.channel) {
            resolve();
            return;
          }

          if (status === 'SUBSCRIBED') {
            this.isConnected = true;
            this.reconnectAttempt = 0;
            this.notifyConnection(true);

            // Track presence
            await this.channel?.track({
              userId: this.userId,
              username: this.username,
              status: 'watching',
              joinedAt: Date.now(),
            } as PlayerPresence);

            resolve();
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            console.debug(`[TableWS] Channel ${status}, will retry...`);
            resolve(); // Don't reject — let reconnect handle it gracefully
          }
        });
      });

      if (!this.isConnected) {
        this.scheduleReconnect();
      }
      return this.isConnected;
    } catch (error: unknown) {
      reportError(error, 'TableWS.connect.failed');
      this.scheduleReconnect();
      return false;
    }
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.channel) {
      // Use removeChannel instead of unsubscribe to prevent zombie channels if disconnected while connecting
      await this.supabase.removeChannel(this.channel);
      this.channel = null;
    }

    // Clear pending events queue to prevent data bleed into subsequent game connections
    this.pendingEvents = [];
    this.lastSequence = -1;

    this.isConnected = false;
    this.notifyConnection(false);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    this.reconnectAttempt++;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      await this.connect();
    }, delay);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // EVENT HANDLING
  // ─────────────────────────────────────────────────────────────────────────────

  private handleGameEvent(event: GameEvent): void {
    // Chat events don't need sequence ordering
    if (event.type === 'CHAT_MESSAGE') {
      this.dispatchEvent(event);
      return;
    }

    // Check sequence for ordering
    if (event.sequence <= this.lastSequence) {
      console.warn('[TableWS] Ignoring out-of-order event:', event.sequence);
      return;
    }

    // Handle missing events (gap in sequence) — queue and request resync
    if (event.sequence > this.lastSequence + 1) {
      console.warn(
        '[TableWS] Missing events (expected:',
        this.lastSequence + 1,
        'got:',
        event.sequence,
        ')'
      );
      this.pendingEvents.push(event);
      this.requestResync();
      return; // Don't process until resync fills the gap
    }

    this.lastSequence = event.sequence;
    this.dispatchEvent(event);

    // Process any queued events that are now in sequence
    this.processPendingEvents();
  }

  private dispatchEvent(event: GameEvent): void {
    this.eventHandlers.forEach((handler) => {
      try {
        handler(event);
      } catch (error: unknown) {
        reportError(error, 'TableWS.dispatchEvent');
      }
    });
  }

  private processPendingEvents(): void {
    // Sort pending by sequence
    this.pendingEvents.sort((a, b) => a.sequence - b.sequence);

    while (this.pendingEvents.length > 0) {
      const next = this.pendingEvents[0];
      if (next.sequence === this.lastSequence + 1) {
        this.pendingEvents.shift();
        this.lastSequence = next.sequence;
        this.dispatchEvent(next);
      } else {
        break; // Still have a gap
      }
    }
  }

  private handlePresenceSync(): void {
    if (!this.channel) return;

    const presenceState = this.channel.presenceState<PlayerPresence>();
    const state = this.transformPresenceState(presenceState);

    this.presenceHandlers.forEach((handler) => {
      try {
        handler(state);
      } catch (error: unknown) {
        reportError(error, 'TableWS.presenceHandler');
      }
    });
  }

  private transformPresenceState(raw: RealtimePresenceState<PlayerPresence>): TablePresenceState {
    const players: PlayerPresence[] = [];
    const observers: PlayerPresence[] = [];

    Object.values(raw).forEach((presences) => {
      presences.forEach((p) => {
        if (p.seatNumber !== undefined) {
          players.push(p);
        } else {
          observers.push(p);
        }
      });
    });

    return {
      players: players.sort((a, b) => (a.seatNumber || 0) - (b.seatNumber || 0)),
      observers,
      dealerPosition: 0, // This would come from game state
    };
  }

  private notifyConnection(connected: boolean): void {
    this.connectionHandlers.forEach((handler) => {
      try {
        handler(connected);
      } catch (error: unknown) {
        reportError(error, 'TableWS.connectionHandler');
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PUBLIC API: SENDING
  // ─────────────────────────────────────────────────────────────────────────────

  async sendAction(action: string, data: Record<string, unknown>): Promise<boolean> {
    if (!this.channel || !this.isConnected) {
      reportError('Cannot send: not connected', 'TableWS.sendAction.notConnected');
      return false;
    }

    const event: GameEvent = {
      type: 'PLAYER_ACTION',
      tableId: this.tableId,
      playerId: this.userId,
      data: { action, ...data },
      timestamp: Date.now(),
      sequence: this.lastSequence + 1, // Optimistic
    };

    try {
      await this.channel.send({
        type: 'broadcast',
        event: 'game_event',
        payload: event,
      });
      return true;
    } catch (error: unknown) {
      reportError(error, 'TableWS.sendAction');
      return false;
    }
  }

  async sendChat(message: string): Promise<boolean> {
    if (!this.channel || !this.isConnected) return false;

    const event: GameEvent = {
      type: 'CHAT_MESSAGE',
      tableId: this.tableId,
      playerId: this.userId,
      data: { message, username: this.username },
      timestamp: Date.now(),
      sequence: 0, // Chat doesn't need ordering
    };

    try {
      await this.channel.send({
        type: 'broadcast',
        event: 'game_event',
        payload: event,
      });
      return true;
    } catch (error: unknown) {
      reportError(error, 'TableWS.sendChat');
      return false;
    }
  }

  async updatePresence(updates: Partial<PlayerPresence>): Promise<void> {
    if (!this.channel) return;

    await this.channel.track({
      userId: this.userId,
      username: this.username,
      ...updates,
      joinedAt: Date.now(),
    } as PlayerPresence);
  }

  private async requestResync(): Promise<void> {
    // Request full state from server via Supabase RPC

    if (!this.supabase) {
      reportError('Cannot resync: Supabase not configured', 'TableWS.resync.noSupabase');
      return;
    }

    try {
      // FIX: Call authoritative Node.js Engine to get live state instead of static DB
      const data = await retryAsync(() => GameServerAPI.getTableState(this.tableId), 3);

      if (data) {
        // Broadcast the synced state to all handlers
        // IMPORTANT: Bypass handleGameEvent's sequence check — resync is authoritative
        const syncEvent: GameEvent = {
          type: 'GAME_START', // Use as full state sync
          tableId: this.tableId,
          data: data,
          timestamp: Date.now(),
          sequence: (data.sequence as number) || this.lastSequence + 1,
        };
        // Dispatch directly (skip sequence ordering — resync IS the truth)
        this.dispatchEvent(syncEvent);
        // Update sequence tracking AFTER dispatch
        this.lastSequence = syncEvent.sequence;
        // Clear any pending events — resync supersedes them
        this.pendingEvents = [];
      }
    } catch (err: unknown) {
      reportError(err, 'TableWS.resync.failed');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PUBLIC API: SUBSCRIPTIONS
  // ─────────────────────────────────────────────────────────────────────────────

  onEvent(handler: EventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  onPresence(handler: PresenceHandler): () => void {
    this.presenceHandlers.add(handler);
    return () => this.presenceHandlers.delete(handler);
  }

  onConnection(handler: ConnectionHandler): () => void {
    this.connectionHandlers.add(handler);
    return () => this.connectionHandlers.delete(handler);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // GETTERS
  // ─────────────────────────────────────────────────────────────────────────────

  get connected(): boolean {
    return this.isConnected;
  }

  get table(): string {
    return this.tableId;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// REACT HOOK
// ═══════════════════════════════════════════════════════════════════════════════

import { useEffect, useState, useRef, useCallback } from 'react';
import { retryAsync } from '../utils/retryAsync';

export interface UseTableWebSocketResult {
  isConnected: boolean;
  presence: TablePresenceState | null;
  lastEvent: GameEvent | null;
  sendAction: (action: string, data: Record<string, unknown>) => Promise<boolean>;
  sendChat: (message: string) => Promise<boolean>;
  updateSeat: (seatNumber: number | undefined) => Promise<void>;
}

export function useTableWebSocket(
  tableId: string,
  userId: string,
  username: string
): UseTableWebSocketResult {
  const wsRef = useRef<TableWebSocket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [presence, setPresence] = useState<TablePresenceState | null>(null);
  const [lastEvent, setLastEvent] = useState<GameEvent | null>(null);

  useEffect(() => {
    const ws = new TableWebSocket(tableId, userId, username);
    wsRef.current = ws;

    // Set up handlers
    const unsubEvent = ws.onEvent(setLastEvent);
    const unsubPresence = ws.onPresence(setPresence);
    const unsubConnection = ws.onConnection(setIsConnected);

    // Connect
    ws.connect();

    // Cleanup
    return () => {
      unsubEvent();
      unsubPresence();
      unsubConnection();
      ws.disconnect();
    };
  }, [tableId, userId, username]);

  const sendAction = useCallback((action: string, data: Record<string, unknown>) => {
    return wsRef.current?.sendAction(action, data) ?? Promise.resolve(false);
  }, []);

  const sendChat = useCallback((message: string) => {
    return wsRef.current?.sendChat(message) ?? Promise.resolve(false);
  }, []);

  const updateSeat = useCallback(async (seatNumber: number | undefined) => {
    await wsRef.current?.updatePresence({
      seatNumber,
      status: seatNumber !== undefined ? 'sitting' : 'watching',
    });
  }, []);

  return {
    isConnected,
    presence,
    lastEvent,
    sendAction,
    sendChat,
    updateSeat,
  };
}

export default TableWebSocket;
