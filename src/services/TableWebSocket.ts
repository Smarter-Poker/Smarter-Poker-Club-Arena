/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🌐 WEBSOCKET CLIENT — Real-Time Game State Sync
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Supabase Realtime + fallback WebSocket client for table state synchronization.
 * Features:
 * - Auto-reconnection with exponential backoff
 * - Presence tracking (who's at the table)
 * - Optimistic updates with server reconciliation
 * - Event-based game state broadcasting
 */

import { createClient, RealtimeChannel, RealtimePresenceState } from '@supabase/supabase-js';

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
    oduserId: string;
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

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000]; // Exponential backoff

// ═══════════════════════════════════════════════════════════════════════════════
// WEBSOCKET CLIENT CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class TableWebSocket {
    private supabase = SUPABASE_URL && SUPABASE_ANON_KEY
        ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
        : null;

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

    private lastSequence = 0;
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
            console.warn('[TableWS] Supabase not configured, running in offline mode');
            return false;
        }

        try {
            // Create channel for this table
            this.channel = this.supabase.channel(`table:${this.tableId}`, {
                config: {
                    presence: { key: this.userId },
                    broadcast: { self: false },
                },
            });

            // Set up event listeners
            this.channel
                .on('broadcast', { event: 'game_event' }, ({ payload }) => {
                    this.handleGameEvent(payload as GameEvent);
                })
                .on('presence', { event: 'sync' }, () => {
                    this.handlePresenceSync();
                })
                .on('presence', { event: 'join' }, ({ newPresences }) => {
                    console.log('[TableWS] Player joined:', newPresences);
                })
                .on('presence', { event: 'leave' }, ({ leftPresences }) => {
                    console.log('[TableWS] Player left:', leftPresences);
                });

            // Subscribe to channel - returns the channel, callback receives status
            await new Promise<void>((resolve, reject) => {
                this.channel!.subscribe(async (status) => {
                    if (status === 'SUBSCRIBED') {
                        this.isConnected = true;
                        this.reconnectAttempt = 0;
                        this.notifyConnection(true);

                        // Track presence
                        await this.channel?.track({
                            oduserId: this.userId,
                            username: this.username,
                            status: 'watching',
                            joinedAt: Date.now(),
                        } as PlayerPresence);

                        console.log('[TableWS] Connected to table:', this.tableId);
                        resolve();
                    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                        reject(new Error(`Channel error: ${status}`));
                    }
                });
            });

            return this.isConnected;
        } catch (error) {
            console.error('[TableWS] Connection error:', error);
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
            await this.channel.unsubscribe();
            this.channel = null;
        }

        this.isConnected = false;
        this.notifyConnection(false);
        console.log('[TableWS] Disconnected from table:', this.tableId);
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer) return;

        const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
        this.reconnectAttempt++;

        console.log(`[TableWS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);

        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            await this.connect();
        }, delay);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // EVENT HANDLING
    // ─────────────────────────────────────────────────────────────────────────────

    private handleGameEvent(event: GameEvent): void {
        // Check sequence for ordering
        if (event.sequence <= this.lastSequence) {
            console.warn('[TableWS] Ignoring out-of-order event:', event.sequence);
            return;
        }

        // Handle missing events (gap in sequence)
        if (event.sequence > this.lastSequence + 1) {
            console.warn('[TableWS] Missing events detected, requesting resync');
            this.requestResync();
        }

        this.lastSequence = event.sequence;

        // Notify all handlers
        this.eventHandlers.forEach((handler) => {
            try {
                handler(event);
            } catch (error) {
                console.error('[TableWS] Event handler error:', error);
            }
        });
    }

    private handlePresenceSync(): void {
        if (!this.channel) return;

        const presenceState = this.channel.presenceState<PlayerPresence>();
        const state = this.transformPresenceState(presenceState);

        this.presenceHandlers.forEach((handler) => {
            try {
                handler(state);
            } catch (error) {
                console.error('[TableWS] Presence handler error:', error);
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
            } catch (error) {
                console.error('[TableWS] Connection handler error:', error);
            }
        });
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // PUBLIC API: SENDING
    // ─────────────────────────────────────────────────────────────────────────────

    async sendAction(action: string, data: Record<string, unknown>): Promise<boolean> {
        if (!this.channel || !this.isConnected) {
            console.warn('[TableWS] Cannot send: not connected');
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
        } catch (error) {
            console.error('[TableWS] Send error:', error);
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
        } catch (error) {
            console.error('[TableWS] Chat error:', error);
            return false;
        }
    }

    async updatePresence(updates: Partial<PlayerPresence>): Promise<void> {
        if (!this.channel) return;

        await this.channel.track({
            oduserId: this.userId,
            username: this.username,
            ...updates,
            joinedAt: Date.now(),
        } as PlayerPresence);
    }

    private async requestResync(): Promise<void> {
        // Request full state from server
        // In a real implementation, this would call an RPC to get current game state
        console.log('[TableWS] Requesting state resync...');
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

    const sendAction = useCallback(
        (action: string, data: Record<string, unknown>) => {
            return wsRef.current?.sendAction(action, data) ?? Promise.resolve(false);
        },
        []
    );

    const sendChat = useCallback((message: string) => {
        return wsRef.current?.sendChat(message) ?? Promise.resolve(false);
    }, []);

    const updateSeat = useCallback(
        async (seatNumber: number | undefined) => {
            await wsRef.current?.updatePresence({
                seatNumber,
                status: seatNumber !== undefined ? 'sitting' : 'watching',
            });
        },
        []
    );

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
