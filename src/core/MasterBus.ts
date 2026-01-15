/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🚌 MASTER BUS — Centralized State & Event Management Layer
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * The Master Bus is the central nervous system of Club Arena, orchestrating:
 * - Type-safe event emission and subscription
 * - Cross-store state synchronization
 * - Realtime channel bridge for live updates
 * - Service layer coordination
 * 
 * NO DEMO DATA - All operations are real.
 */

import { useArenaStore } from '../stores/useArenaStore';
import { useClubStore } from '../stores/useClubStore';
import { useTableStore } from '../stores/useTableStore';
import { useUnionStore } from '../stores/useUnionStore';
import { useWalletStore } from '../stores/useWalletStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useUserStore } from '../stores/useUserStore';
import { realtimeChannelService } from '../services/RealtimeChannelService';

// ═══════════════════════════════════════════════════════════════════════════════
// EVENT TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type BusEventType =
    | 'AUTH_STATE_CHANGED'
    | 'USER_PROFILE_LOADED'
    | 'CLUB_JOINED'
    | 'CLUB_LEFT'
    | 'TABLE_SEATED'
    | 'TABLE_LEFT'
    | 'BALANCE_UPDATED'
    | 'WALLET_REFRESHED'
    | 'REALTIME_CONNECTED'
    | 'REALTIME_DISCONNECTED'
    | 'SYSTEM_ERROR';

export interface BusEvent<T = unknown> {
    type: BusEventType;
    payload: T;
    timestamp: string;
}

export interface AuthStatePayload {
    userId: string | null;
    isAuthenticated: boolean;
}

export interface ClubEventPayload {
    clubId: string;
    clubName?: string;
}

export interface TableEventPayload {
    tableId: string;
    seat?: number;
}

export interface BalancePayload {
    walletType: 'PLAYER' | 'BUSINESS' | 'PROMO';
    available: number;
    total: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MASTER BUS STATUS
// ═══════════════════════════════════════════════════════════════════════════════

export interface MasterBusStatus {
    online: boolean;
    stores: {
        arena: boolean;
        club: boolean;
        table: boolean;
        union: boolean;
        wallet: boolean;
        settings: boolean;
        user: boolean;
    };
    eventSubscribers: number;
    timestamp: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MASTER BUS SINGLETON
// ═══════════════════════════════════════════════════════════════════════════════

type EventHandler<T = unknown> = (event: BusEvent<T>) => void;

class MasterBusCore {
    private subscribers: Map<BusEventType, Set<EventHandler>> = new Map();
    private status: MasterBusStatus | null = null;
    private initialized: boolean = false;

    /**
     * Initialize the Master Bus
     * Verifies all stores are accessible and sets up event system
     */
    init(): MasterBusStatus {
        if (this.initialized) {
            console.log('🚌 [MASTER BUS] Already initialized');
            return this.status!;
        }

        console.log('═══════════════════════════════════════════════════════════════');
        console.log('🚌 [MASTER BUS] INITIALIZING STATE MANAGEMENT LAYER');
        console.log('═══════════════════════════════════════════════════════════════');

        const stores = {
            arena: false,
            club: false,
            table: false,
            union: false,
            wallet: false,
            settings: false,
            user: false,
        };

        // Verify each store is accessible
        try {
            const arenaState = useArenaStore.getState();
            stores.arena = arenaState !== undefined;
            console.log(`  ├─ ArenaStore: ${stores.arena ? '✓' : '✗'}`);
        } catch (e) {
            console.error('  ├─ ArenaStore: ✗ (Error)', e);
        }

        try {
            const clubState = useClubStore.getState();
            stores.club = clubState !== undefined;
            console.log(`  ├─ ClubStore: ${stores.club ? '✓' : '✗'}`);
        } catch (e) {
            console.error('  ├─ ClubStore: ✗ (Error)', e);
        }

        try {
            const tableState = useTableStore.getState();
            stores.table = tableState !== undefined;
            console.log(`  ├─ TableStore: ${stores.table ? '✓' : '✗'}`);
        } catch (e) {
            console.error('  ├─ TableStore: ✗ (Error)', e);
        }

        try {
            const unionState = useUnionStore.getState();
            stores.union = unionState !== undefined;
            console.log(`  ├─ UnionStore: ${stores.union ? '✓' : '✗'}`);
        } catch (e) {
            console.error('  ├─ UnionStore: ✗ (Error)', e);
        }

        try {
            const walletState = useWalletStore.getState();
            stores.wallet = walletState !== undefined;
            console.log(`  ├─ WalletStore: ${stores.wallet ? '✓' : '✗'}`);
        } catch (e) {
            console.error('  ├─ WalletStore: ✗ (Error)', e);
        }

        try {
            const settingsState = useSettingsStore.getState();
            stores.settings = settingsState !== undefined;
            console.log(`  ├─ SettingsStore: ${stores.settings ? '✓' : '✗'}`);
        } catch (e) {
            console.error('  ├─ SettingsStore: ✗ (Error)', e);
        }

        try {
            const userState = useUserStore.getState();
            stores.user = userState !== undefined;
            console.log(`  └─ UserStore: ${stores.user ? '✓' : '✗'}`);
        } catch (e) {
            console.error('  └─ UserStore: ✗ (Error)', e);
        }

        // Determine overall status
        const allOnline = Object.values(stores).every(s => s === true);

        this.status = {
            online: allOnline,
            stores,
            eventSubscribers: this.getTotalSubscribers(),
            timestamp: new Date().toISOString(),
        };

        this.initialized = true;

        // Set up internal event handlers for cross-store sync
        this.setupInternalHandlers();

        // DETERMINISTIC PROOF
        console.log('───────────────────────────────────────────────────────────────');
        console.log(`MASTER_BUS:${allOnline ? 'ONLINE' : 'OFFLINE'}`);
        console.log('═══════════════════════════════════════════════════════════════');

        return this.status;
    }

    /**
     * Subscribe to an event type
     */
    subscribe<T = unknown>(eventType: BusEventType, handler: EventHandler<T>): () => void {
        if (!this.subscribers.has(eventType)) {
            this.subscribers.set(eventType, new Set());
        }

        this.subscribers.get(eventType)!.add(handler as EventHandler);

        // Return unsubscribe function
        return () => {
            this.subscribers.get(eventType)?.delete(handler as EventHandler);
        };
    }

    /**
     * Emit an event to all subscribers
     */
    emit<T = unknown>(type: BusEventType, payload: T): void {
        const event: BusEvent<T> = {
            type,
            payload,
            timestamp: new Date().toISOString(),
        };

        console.log(`🚌 [BUS EVENT] ${type}`, payload);

        const handlers = this.subscribers.get(type);
        if (handlers) {
            handlers.forEach(handler => {
                try {
                    handler(event);
                } catch (e) {
                    console.error(`🚌 [BUS ERROR] Handler failed for ${type}:`, e);
                }
            });
        }
    }

    /**
     * Set up internal handlers for cross-store synchronization
     */
    private setupInternalHandlers(): void {
        // When auth state changes, sync user data across stores
        this.subscribe<AuthStatePayload>('AUTH_STATE_CHANGED', (event) => {
            const { userId, isAuthenticated } = event.payload;

            if (isAuthenticated && userId) {
                // Load user-specific data
                useClubStore.getState().loadMemberships();
                useWalletStore.getState().refreshAll(userId);
            } else {
                // Clear user data on logout
                useClubStore.getState().reset();
                useWalletStore.getState().reset();
                useArenaStore.getState().reset();
            }
        });

        // When joining a club, subscribe to realtime channel
        this.subscribe<ClubEventPayload>('CLUB_JOINED', (event) => {
            const { clubId } = event.payload;
            const user = useUserStore.getState().user;

            if (user) {
                realtimeChannelService.subscribeToClub(
                    clubId,
                    user.id,
                    {
                        id: user.id,
                        displayName: user.display_name || user.username,
                        playerNumber: 0,
                        avatarUrl: user.avatar_url || '',
                        status: 'online',
                    },
                    {
                        onEvent: (clubEvent) => {
                            console.log('🚌 [REALTIME] Club event:', clubEvent);
                        },
                    }
                );
            }
        });

        // When leaving a club, unsubscribe from realtime
        this.subscribe<ClubEventPayload>('CLUB_LEFT', (event) => {
            realtimeChannelService.unsubscribeFromClub(event.payload.clubId);
        });
    }

    /**
     * Get total number of event subscribers
     */
    private getTotalSubscribers(): number {
        let total = 0;
        this.subscribers.forEach(handlers => {
            total += handlers.size;
        });
        return total;
    }

    /**
     * Get current Master Bus status
     */
    getStatus(): MasterBusStatus | null {
        if (this.status) {
            this.status.eventSubscribers = this.getTotalSubscribers();
        }
        return this.status;
    }

    /**
     * Check if Master Bus is online
     */
    isOnline(): boolean {
        return this.status?.online === true;
    }

    /**
     * Reset the Master Bus (for testing or logout)
     */
    reset(): void {
        this.subscribers.clear();
        this.status = null;
        this.initialized = false;
        console.log('🚌 [MASTER BUS] Reset complete');
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

// Singleton instance
export const masterBus = new MasterBusCore();

// Convenience functions
export function initMasterBus(): MasterBusStatus {
    return masterBus.init();
}

export function getMasterBusStatus(): MasterBusStatus | null {
    return masterBus.getStatus();
}

export function isMasterBusOnline(): boolean {
    return masterBus.isOnline();
}
