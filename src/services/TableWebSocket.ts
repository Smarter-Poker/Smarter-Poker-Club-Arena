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

  /** Resync attempts before we accept the gap. getTableState resolves null on failure. */
  private static readonly RESYNC_ATTEMPTS = 3;
  private static readonly RESYNC_BASE_DELAY_MS = 400;

  private eventHandlers: Set<EventHandler> = new Set();
  private presenceHandlers: Set<PresenceHandler> = new Set();
  private connectionHandlers: Set<ConnectionHandler> = new Set();

  private isConnected = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * 2026-08-22: terminal flag. The owning hook creates a fresh instance per
   * mount and calls disconnect() on cleanup — but connect() awaits
   * getSession() BEFORE assigning this.channel, so a disconnect() landing in
   * that window nulled a channel that didn't exist yet and connect() then
   * resumed, creating a subscribed zombie channel nothing could ever remove
   * (duplicate presence + duplicate game_event handlers). The hook's
   * userId/username props churn 2-3 times per table mount, so this raced
   * routinely, not rarely.
   */
  private destroyed = false;

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

  private connectInFlight: Promise<boolean> | null = null;
  private cancelPendingConnect: (() => void) | null = null;

  connect(): Promise<boolean> {
    if (this.destroyed) return Promise.resolve(false);
    if (this.connectInFlight) return this.connectInFlight;
    if (this.isConnected && this.channel) return Promise.resolve(true);
    this.connectInFlight = this.connectOnce().finally(() => {
      this.connectInFlight = null;
    });
    return this.connectInFlight;
  }

  private async connectOnce(): Promise<boolean> {
    if (!this.supabase) {
      reportError('Supabase not configured, running in offline mode', 'TableWS.connect.noSupabase');
      return false;
    }

    try {
      // Ensure auth session is ready before subscribing to channel
      const {
        data: { session },
      } = await this.supabase.auth.getSession();
      if (this.destroyed) return false; // disconnect() fired during the await
      if (!session) {
        reportError('No auth session, scheduling reconnect', 'TableWS.connect.noAuth');
        this.scheduleReconnect();
        return false;
      }

      // 2026-08-22 review: remove any previous channel FIRST. Reconnects used
      // to stack a fresh `table:<id>` channel on top of the old one every
      // time (supabase-js does not dedupe topics), and with RoomService now
      // rebinding on reconnect, N stacked channels meant N duplicate
      // deliveries of every reaction/chat/presence event.
      if (this.channel) {
        const stale = this.channel;
        this.channel = null;
        try {
          await this.supabase.removeChannel(stale);
        } catch {
          /* best effort — a dead channel object can throw on removal */
        }
        if (this.destroyed) return false;
      }

      // Create channel for this table
      this.channel = this.supabase.channel(`table:${this.tableId}`, {
        config: {
          presence: { key: this.userId },
          broadcast: { self: false },
        },
      });

      // Register with RoomService to share the channel and prevent duplicate
      // subscriptions. 2026-08-22: capture the channel NOW — this import
      // resolves on a later microtask, by which time disconnect() may have
      // nulled this.channel (the old code then registered `null!` or a
      // replacement channel under the wrong lifecycle).
      const channelForRoom = this.channel;
      import('./RoomService').then(({ roomService }) => {
        if (channelForRoom && this.channel === channelForRoom) {
          roomService.registerChannel(this.tableId, channelForRoom);
        }
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
        .on('presence', { event: 'leave' }, ({ leftPresences }) => {})
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'table_chat',
            filter: `table_id=eq.${this.tableId}`,
          },
          (payload) => {
            import('../core/MasterBus')
              .then(({ masterBus }) => {
                masterBus.emit('TABLE_CHAT_INSERT', { tableId: this.tableId, newRow: payload.new });
              })
              .catch(() => {});
          }
        );

      // Subscribe to channel - returns the channel, callback receives status
      const subscribedChannel = this.channel;
      await new Promise<void>((resolve) => {
        const settle = () => {
          if (this.cancelPendingConnect === settle) this.cancelPendingConnect = null;
          resolve();
        };
        this.cancelPendingConnect = settle;
        subscribedChannel.subscribe(async (status) => {
          if (this.destroyed || this.channel !== subscribedChannel) {
            settle();
            return;
          }
          if (status === 'SUBSCRIBED') {
            this.isConnected = true;
            this.reconnectAttempt = 0;
            if (this.reconnectTimer) {
              clearTimeout(this.reconnectTimer);
              this.reconnectTimer = null;
            }
            this.notifyConnection(true);
            try {
              await subscribedChannel.track({
                userId: this.userId,
                username: this.username,
                status: 'watching',
                joinedAt: Date.now(),
              } as PlayerPresence);
            } catch (error) {
              reportError(error, 'TableWS.presence.track_failed');
            } finally {
              settle();
            }
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            this.isConnected = false;
            this.notifyConnection(false);
            this.scheduleReconnect();
            settle();
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
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Revoke ownership before awaiting network removal. Late channel callbacks
    // must not resurrect presence or report a successful connection.
    const channel = this.channel;
    this.channel = null;
    this.isConnected = false;
    this.cancelPendingConnect?.();
    if (channel) {
      try {
        await this.supabase.removeChannel(channel);
      } catch (error) {
        reportError(error, 'TableWS.disconnect.remove_failed');
      }
    }

    // Clear pending events queue to prevent data bleed into subsequent game connections
    this.pendingEvents = [];
    this.lastSequence = -1;

    this.isConnected = false;
    this.notifyConnection(false);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.destroyed) return;

    const base = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    // 2026-08-22: jitter. Every client at a table drops at the same moment
    // when Supabase blips, and identical delays retried them in lockstep — a
    // thundering herd against the Realtime service at the worst time.
    const delay = base + Math.random() * base * 0.3;
    this.reconnectAttempt++;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.destroyed) return;
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

    // 2026-08-22: client-originated broadcasts share this channel/event name
    // (RoomService reactions/throwables/show-cards, peers' optimistic
    // actions) and carry no server sequence. They used to fall through the
    // ordering checks below and either corrupt lastSequence (assigned
    // `undefined`) or fake a forward gap at every peer, silently disabling
    // gap detection / triggering spurious resyncs. Anything without a
    // non-negative numeric sequence is dispatched as unordered instead
    // (server sequences start at 0; client-originated frames use -1).
    if (typeof event.sequence !== 'number' || event.sequence < 0) {
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
      // 2026-08-22: was `this.lastSequence + 1` — a GUESS that peers read as
      // either a duplicate (silently dropped) or a false forward gap that
      // queued the event and fired a resync round-trip. -1 = unordered; every
      // receiver dispatches it without touching sequence tracking.
      sequence: -1,
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

  /**
   * Fill a gap in the event sequence by pulling authoritative state.
   *
   * ── WHY THIS WAS REWRITTEN (2026-08-20) ──────────────────────────────────
   * The previous version was `retryAsync(() => GameServerAPI.getTableState(id), 3)`
   * inside a try/catch, and it could wedge a table permanently and silently.
   *
   * `getTableState` NEVER throws: it resolves `null` on a non-OK status, on an
   * unreachable engine, and whenever GameServerAPI's circuit breaker is open.
   * `retryAsync` only retries a THROWN retryable error, so "3 retries" bought
   * exactly one attempt, and the surrounding `catch` was dead code.
   *
   * The failure mode that follows is the bad part. `handleGameEvent` queues the
   * gapped event, calls this, and returns WITHOUT advancing `lastSequence`. If
   * the resync resolved `null`, the `if (data)` block was skipped and nothing
   * repaired the sequence — so every subsequent event was also a gap, was also
   * queued, and `processPendingEvents` (which only drains strictly in order)
   * could never run. Pot, stacks, board and the turn indicator freeze at the
   * moment of the gap. No error, no banner, no reconnect. The only way out was
   * for the player to reload the page, mid-hand, with money committed.
   *
   * So: retry on the null, and if it still fails, ACCEPT THE GAP rather than
   * freeze. A client that is one event stale still tracks the hand and is
   * repaired by the engine's next full-state broadcast. A frozen one never
   * recovers.
   */
  private resyncInFlight: Promise<void> | null = null;

  private requestResync(): Promise<void> {
    // A burst of gapped events would otherwise fire a resync per event.
    if (this.resyncInFlight) return this.resyncInFlight;
    this.resyncInFlight = this.runResync().finally(() => {
      this.resyncInFlight = null;
    });
    return this.resyncInFlight;
  }

  private async runResync(): Promise<void> {
    if (!this.supabase) {
      reportError('Cannot resync: Supabase not configured', 'TableWS.resync.noSupabase');
      this.acceptGap('supabase not configured');
      return;
    }

    let data: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < TableWebSocket.RESYNC_ATTEMPTS; attempt++) {
      data = await GameServerAPI.getTableState(this.tableId);
      if (data) break;
      if (attempt < TableWebSocket.RESYNC_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, TableWebSocket.RESYNC_BASE_DELAY_MS * 2 ** attempt));
      }
    }

    if (!data) {
      this.acceptGap(`getTableState returned null ${TableWebSocket.RESYNC_ATTEMPTS}x`);
      return;
    }

    // Broadcast the synced state to all handlers.
    // IMPORTANT: bypass handleGameEvent's sequence check — resync is authoritative.
    const syncEvent: GameEvent = {
      type: 'GAME_START', // Use as full state sync
      tableId: this.tableId,
      data: data,
      timestamp: Date.now(),
      sequence: (data.sequence as number) || this.lastSequence + 1,
    };
    this.dispatchEvent(syncEvent);
    this.lastSequence = syncEvent.sequence;
    // Resync supersedes anything queued behind the gap.
    this.pendingEvents = [];
  }

  /**
   * Resync could not be completed. Rather than sit on a queue that can never
   * drain, take the queued events at face value: dispatch them in sequence
   * order and move `lastSequence` to the newest one, so the live stream flows
   * again. We may have missed one event's worth of state; the engine's next
   * full broadcast repairs that. Freezing does not repair itself.
   */
  private acceptGap(reason: string): void {
    reportError(
      new Error(`resync failed (${reason}) - accepting the sequence gap to avoid a frozen table`),
      'TableWS.resync.acceptedGap'
    );
    if (this.pendingEvents.length === 0) return;

    const queued = [...this.pendingEvents].sort((a, b) => a.sequence - b.sequence);
    this.pendingEvents = [];
    for (const ev of queued) {
      this.lastSequence = ev.sequence;
      this.dispatchEvent(ev);
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
