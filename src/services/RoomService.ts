/**
 * ♠ CLUB ARENA — Multiplayer Room Service
 * Real-time WebSocket synchronization for poker tables
 */

import { supabase, isDemoMode } from '../lib/supabase';
import type { RealtimeChannel } from '@supabase/supabase-js';
import type { SeatPlayer, Card, ActionType, HandStage } from '../types/database.types';

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
    type: 'PLAYER_JOINED' | 'PLAYER_LEFT' | 'PLAYER_ACTION' | 'HAND_START' |
    'CARDS_DEALT' | 'COMMUNITY_CARDS' | 'TURN_CHANGE' | 'SHOWDOWN' |
    'HAND_COMPLETE' | 'CHAT' | 'PRESENCE_SYNC';
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
     * Join a table room
     */
    async joinRoom(
        tableId: string,
        userId: string,
        username: string,
        seat: number,
        stack: number
    ): Promise<void> {
        if (isDemoMode) {
            console.log(`[Demo] Joined room ${tableId}`);
            return;
        }

        // Create or get channel
        let channel = this.channels.get(tableId);

        if (!channel) {
            channel = supabase.channel(`table:${tableId}`, {
                config: {
                    presence: {
                        key: userId,
                    },
                },
            });

            // Handle broadcasts
            channel.on('broadcast', { event: 'game_event' }, (payload) => {
                this.handleMessage(tableId, payload.payload as RoomMessage);
            });

            // Handle presence sync
            channel.on('presence', { event: 'sync' }, () => {
                const state = channel!.presenceState();
                this.updatePresence(tableId, state);
            });

            // Handle joins
            channel.on('presence', { event: 'join' }, ({ key, newPresences }) => {
                console.log(`Player joined:`, key, newPresences);
                this.notifyHandlers(tableId, {
                    type: 'PLAYER_JOINED',
                    payload: { userId: key, presences: newPresences },
                    sender: 'system',
                    timestamp: Date.now(),
                });
            });

            // Handle leaves
            channel.on('presence', { event: 'leave' }, ({ key, leftPresences }) => {
                console.log(`Player left:`, key, leftPresences);
                this.notifyHandlers(tableId, {
                    type: 'PLAYER_LEFT',
                    payload: { userId: key, presences: leftPresences },
                    sender: 'system',
                    timestamp: Date.now(),
                });
            });

            // Subscribe
            await channel.subscribe(async (status) => {
                if (status === 'SUBSCRIBED') {
                    // Track presence
                    await channel!.track({
                        userId,
                        username,
                        seat,
                        stack,
                        status: 'active',
                    } as PlayerPresence);
                }
            });

            this.channels.set(tableId, channel);
        } else {
            // Already in room, update presence
            await channel.track({
                userId,
                username,
                seat,
                stack,
                status: 'active',
            } as PlayerPresence);
        }
    }

    /**
     * Leave a table room
     */
    async leaveRoom(tableId: string): Promise<void> {
        const channel = this.channels.get(tableId);
        if (!channel) return;

        await channel.untrack();
        await supabase.removeChannel(channel);

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
        if (isDemoMode) {
            console.log(`[Demo] Broadcast:`, message);
            return;
        }

        const channel = this.channels.get(tableId);
        if (!channel) {
            console.error('Not connected to room:', tableId);
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
    async broadcastCommunityCards(
        tableId: string,
        stage: HandStage,
        cards: Card[]
    ): Promise<void> {
        await this.broadcast(tableId, {
            type: 'COMMUNITY_CARDS',
            payload: { stage, cards },
            sender: 'dealer',
        });
    }

    /**
     * Send chat message
     */
    async sendChat(
        tableId: string,
        senderId: string,
        message: string
    ): Promise<void> {
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
                current.filter(h => h !== handler)
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
            } catch (error) {
                console.error('Handler error:', error);
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
