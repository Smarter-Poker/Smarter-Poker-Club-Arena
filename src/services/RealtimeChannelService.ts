/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 📡 REALTIME CHANNEL SERVICE — Supabase Presence & Broadcast
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Manages real-time communication channels for:
 * - Club presence and activity
 * - Tournament updates and eliminations
 * - Table state synchronization
 * - Hand-by-hand streaming
 *
 * CHANNELS:
 * - club:{id} — Member join/leave, table created, announcements
 * - tournament:{id} — Registration, eliminations, payouts
 * - table:{id} — Game state, player actions (handled by TableWebSocket)
 * - hand:{id} — Hand replay streaming
 */

import { supabase } from '../lib/supabase';
import { subscriptionMonitor } from '../utils/subscriptionMonitor';
import type { RealtimeChannel, RealtimePresenceState } from '@supabase/supabase-js';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
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
  payload: any;
  timestamp: string;
}

export interface TournamentEvent {
  type:
    | 'registration_open'
    | 'registration_closed'
    | 'tournament_started'
    | 'player_registered'
    | 'player_eliminated'
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
  payload: any;
  timestamp: string;
}

export interface HandEvent {
  type: 'deal' | 'action' | 'street' | 'showdown' | 'pot_awarded';
  payload: any;
  timestamp: string;
}

export interface ChannelSubscription {
  channel: RealtimeChannel;
  type: ChannelType;
  entityId: string;
  onEvent: (event: any) => void;
  onPresenceSync?: (members: ClubPresence[]) => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

// Subscription limits and cleanup
// Increased from 10 to 25. At 10, a user in 2 clubs watching a tournament
// with the lobby open would easily exceed the limit, causing the oldest
// subscription (often a critical club presence channel) to be silently dropped.
// Supabase supports up to 100 concurrent channels per connection.
const MAX_CONCURRENT_SUBSCRIPTIONS = 25;
const SUBSCRIPTION_CLEANUP_TIMEOUT = 30 * 60 * 1000; // 30 minutes

class RealtimeChannelService {
  private subscriptions: Map<string, ChannelSubscription> = new Map();
  private presenceState: Map<string, ClubPresence[]> = new Map();
  private subscriptionTimestamps: Map<string, number> = new Map();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Initialize cleanup interval for stale subscriptions
   */
  private initializeCleanupInterval(): void {
    if (this.cleanupInterval) return;

    this.cleanupInterval = setInterval(
      () => {
        const now = Date.now();
        const staleKeys: string[] = [];

        this.subscriptionTimestamps.forEach((timestamp, key) => {
          if (now - timestamp > SUBSCRIPTION_CLEANUP_TIMEOUT) {
            staleKeys.push(key);
          }
        });

        if (staleKeys.length > 0) {
          console.error(
            `[RealtimeChannelService] Found ${staleKeys.length} stale subscriptions (>30 min old). Cleaning up...`
          );
          staleKeys.forEach((key) => {
            const sub = this.subscriptions.get(key);
            if (sub) {
              sub.channel
                .unsubscribe()
                .catch((e) => console.error('[RealtimeChannel] Cleanup failed:', e));
              this.subscriptions.delete(key);
              this.subscriptionTimestamps.delete(key);
              subscriptionMonitor.unregister(key);
            }
          });
        }
      },
      5 * 60 * 1000
    ); // Check every 5 minutes
  }

  /**
   * Synchronous pre-check: if at limit, remove oldest from Maps immediately.
   * The actual channel.unsubscribe() still happens async, but the slot is freed
   * synchronously so new subscriptions won't overshoot the limit.
   */
  private enforceSubscriptionLimitSync(): void {
    if (this.subscriptions.size < MAX_CONCURRENT_SUBSCRIPTIONS) return;

    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    this.subscriptionTimestamps.forEach((timestamp, key) => {
      if (timestamp < oldestTime) {
        oldestTime = timestamp;
        oldestKey = key;
      }
    });

    if (oldestKey) {
      const oldest = this.subscriptions.get(oldestKey);
      // Remove from registry synchronously
      this.subscriptions.delete(oldestKey);
      this.subscriptionTimestamps.delete(oldestKey);
      subscriptionMonitor.unregister(oldestKey);
      // Fire-and-forget the actual unsubscribe
      if (oldest) {
        oldest.channel
          .unsubscribe()
          .catch((e) =>
            console.warn('[RealtimeChannel] Async cleanup failed for', oldestKey, ':', e)
          );
      }
      console.warn(`[RealtimeChannelService] Sync limit enforcement: removed oldest ${oldestKey}`);
    }
  }

  /**
   * @deprecated Use enforceSubscriptionLimitSync() instead. Kept for backward compatibility.
   * Enforce subscription limit by removing oldest if necessary
   */
  private async enforceSubscriptionLimit(): Promise<void> {
    if (this.subscriptions.size >= MAX_CONCURRENT_SUBSCRIPTIONS) {
      // Find oldest subscription
      let oldestKey: string | null = null;
      let oldestTime = Infinity;

      this.subscriptionTimestamps.forEach((timestamp, key) => {
        if (timestamp < oldestTime) {
          oldestTime = timestamp;
          oldestKey = key;
        }
      });

      // Remove oldest if found
      if (oldestKey) {
        const oldest = this.subscriptions.get(oldestKey);
        if (oldest) {
          // Remove from registry first, then await unsubscribe to prevent zombie channels
          this.subscriptions.delete(oldestKey);
          this.subscriptionTimestamps.delete(oldestKey);
          subscriptionMonitor.unregister(oldestKey);
          try {
            await oldest.channel.unsubscribe();
          } catch (e) {
            console.error('[RealtimeChannel] Cleanup failed for', oldestKey, ':', e);
          }
          console.warn(
            `[RealtimeChannelService] Max subscriptions (${MAX_CONCURRENT_SUBSCRIPTIONS}) reached. ` +
              `Removed oldest subscription: ${oldestKey}`
          );
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // CLUB CHANNELS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Subscribe to club channel for presence and events
   */
  subscribeToClub(
    clubId: string,
    userId: string,
    userInfo: Omit<ClubPresence, 'joinedAt'>,
    callbacks: {
      onMemberJoin?: (member: ClubPresence) => void;
      onMemberLeave?: (memberId: string) => void;
      onEvent?: (event: ClubEvent) => void;
      onPresenceSync?: (members: ClubPresence[]) => void;
    }
  ): () => void {
    const channelName = `club:${clubId}`;

    // Initialize cleanup on first subscription
    this.initializeCleanupInterval();

    if (this.subscriptions.has(channelName)) {
      return () => this.unsubscribeFromClub(clubId);
    }

    // Enforce subscription limit synchronously: if at capacity, the oldest subscription
    // is immediately removed from Maps. The actual channel.unsubscribe() happens async
    // in the background, but the slot is freed synchronously to prevent overshooting.
    this.enforceSubscriptionLimitSync();

    const channel = supabase.channel(channelName, {
      config: { presence: { key: userId } },
    });

    // Handle presence
    channel.on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState<ClubPresence>();
      const members = Object.values(state).flat() as ClubPresence[];
      this.presenceState.set(clubId, members);
      callbacks.onPresenceSync?.(members);
    });

    channel.on('presence', { event: 'join' }, ({ newPresences }) => {
      newPresences.forEach((presence: any) => {
        callbacks.onMemberJoin?.(presence as ClubPresence);
      });
    });

    channel.on('presence', { event: 'leave' }, ({ leftPresences }) => {
      leftPresences.forEach((presence: any) => {
        callbacks.onMemberLeave?.(presence.id);
      });
    });

    // Handle broadcast events
    channel.on('broadcast', { event: 'club_event' }, ({ payload }) => {
      callbacks.onEvent?.(payload as ClubEvent);
    });

    // Subscribe and track presence
    channel.subscribe(async (status: string, err?: Error) => {
      if (status === 'SUBSCRIBED') {
        await channel.track({
          ...userInfo,
          joinedAt: new Date().toISOString(),
        });
      } else if (status === 'CHANNEL_ERROR') {
        console.error(
          `[RealtimeChannel] ❌ Club channel error for ${clubId}:`,
          err?.message || err
        );
      } else if (status === 'TIMED_OUT') {
        console.warn(`[RealtimeChannel] ⏱️ Club channel ${clubId} timed out`);
      }
    });

    this.subscriptions.set(channelName, {
      channel,
      type: 'club',
      entityId: clubId,
      onEvent: callbacks.onEvent || (() => {}),
      onPresenceSync: callbacks.onPresenceSync,
    });

    // Track subscription for monitoring
    this.subscriptionTimestamps.set(channelName, Date.now());
    subscriptionMonitor.register(channelName, 'club');

    return () => this.unsubscribeFromClub(clubId);
  }

  /**
   * Unsubscribe from club channel
   */
  async unsubscribeFromClub(clubId: string): Promise<void> {
    const channelName = `club:${clubId}`;
    const subscription = this.subscriptions.get(channelName);

    if (subscription) {
      await subscription.channel.unsubscribe();
      this.subscriptions.delete(channelName);
      this.subscriptionTimestamps.delete(channelName);
      this.presenceState.delete(clubId);
      subscriptionMonitor.unregister(channelName);
    }
  }

  /**
   * Broadcast an event to a club channel
   */
  async broadcastClubEvent(clubId: string, event: Omit<ClubEvent, 'timestamp'>): Promise<void> {
    const channelName = `club:${clubId}`;
    const subscription = this.subscriptions.get(channelName);

    if (!subscription) {
      console.error(`Not subscribed to ${channelName}`);
      return;
    }

    const fullEvent: ClubEvent = {
      ...event,
      timestamp: new Date().toISOString(),
    };

    await subscription!.channel.send({
      type: 'broadcast',
      event: 'club_event',
      payload: fullEvent,
    });
  }

  /**
   * Get current club presence
   */
  getClubPresence(clubId: string): ClubPresence[] {
    return this.presenceState.get(clubId) || [];
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TOURNAMENT CHANNELS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Subscribe to tournament channel for updates
   */
  subscribeToTournament(
    tournamentId: string,
    callbacks: {
      onEvent?: (event: TournamentEvent) => void;
      onPlayerRegistered?: (player: any) => void;
      onPlayerEliminated?: (elimination: any) => void;
      onLevelUp?: (level: any) => void;
      onWinner?: (winner: any) => void;
    }
  ): () => void {
    const channelName = `tournament:${tournamentId}`;

    // Initialize cleanup on first subscription
    this.initializeCleanupInterval();

    if (this.subscriptions.has(channelName)) {
      return () => this.unsubscribeFromTournament(tournamentId);
    }

    // Enforce subscription limit synchronously
    this.enforceSubscriptionLimitSync();

    const channel = supabase.channel(channelName);

    channel.on('broadcast', { event: 'tournament_event' }, ({ payload }) => {
      const event = payload as TournamentEvent;
      callbacks.onEvent?.(event);

      // Route to specific callbacks
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

    channel.subscribe((status: string, err?: Error) => {
      if (status === 'CHANNEL_ERROR') {
        console.error(
          `[RealtimeChannel] ❌ Tournament channel error for ${tournamentId}:`,
          err?.message || err
        );
      }
      if (status === 'TIMED_OUT') {
        console.warn(`[RealtimeChannel] ⏱️ Tournament channel ${tournamentId} timed out`);
      }
    });

    this.subscriptions.set(channelName, {
      channel,
      type: 'tournament',
      entityId: tournamentId,
      onEvent: callbacks.onEvent || (() => {}),
    });

    // Track subscription for monitoring
    this.subscriptionTimestamps.set(channelName, Date.now());
    subscriptionMonitor.register(channelName, 'tournament');

    return () => this.unsubscribeFromTournament(tournamentId);
  }

  /**
   * Unsubscribe from tournament channel
   */
  async unsubscribeFromTournament(tournamentId: string): Promise<void> {
    const channelName = `tournament:${tournamentId}`;
    const subscription = this.subscriptions.get(channelName);

    if (subscription) {
      await subscription.channel.unsubscribe();
      this.subscriptions.delete(channelName);
      this.subscriptionTimestamps.delete(channelName);
      subscriptionMonitor.unregister(channelName);
    }
  }

  /**
   * Broadcast tournament event
   */
  async broadcastTournamentEvent(
    tournamentId: string,
    event: Omit<TournamentEvent, 'timestamp'>
  ): Promise<void> {
    const channelName = `tournament:${tournamentId}`;
    const subscription = this.subscriptions.get(channelName);

    // Create temporary channel if not subscribed
    if (!subscription) {
      const channel = supabase.channel(channelName);
      try {
        await channel.subscribe((status: string, err?: Error) => {
          if (status === 'CHANNEL_ERROR') {
            console.error(
              `[RealtimeChannel] ❌ Broadcast channel error for tournament:${tournamentId}:`,
              err?.message || err
            );
          }
        });
        await channel.send({
          type: 'broadcast',
          event: 'tournament_event',
          payload: { ...event, timestamp: new Date().toISOString() },
        });
      } catch (e: unknown) {
        console.error(
          `[RealtimeChannelService] Tournament broadcast failed for ${tournamentId}:`,
          e
        );
      } finally {
        // Always clean up — prevents orphaned channels
        try {
          await channel.unsubscribe();
        } catch (e: unknown) {
          console.error('[RealtimeChannel] Cleanup failed:', e);
        }
      }
      return;
    }

    await subscription.channel.send({
      type: 'broadcast',
      event: 'tournament_event',
      payload: { ...event, timestamp: new Date().toISOString() },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // HAND REPLAY STREAMING
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Subscribe to hand replay channel
   */
  subscribeToHandReplay(
    handId: string,
    callbacks: {
      onEvent?: (event: HandEvent) => void;
    }
  ): () => void {
    const channelName = `hand:${handId}`;

    // Initialize cleanup on first subscription (was missing for hand replays)
    this.initializeCleanupInterval();

    // Prevent duplicate subscriptions
    if (this.subscriptions.has(channelName)) {
      return () => this.unsubscribeFromHand(handId);
    }

    // Enforce subscription limit synchronously
    this.enforceSubscriptionLimitSync();

    const channel = supabase.channel(channelName);

    channel.on('broadcast', { event: 'hand_event' }, ({ payload }) => {
      callbacks.onEvent?.(payload as HandEvent);
    });

    channel.subscribe((status: string, err?: Error) => {
      if (status === 'CHANNEL_ERROR') {
        console.error(
          `[RealtimeChannel] ❌ Hand replay channel error for ${handId}:`,
          err?.message || err
        );
      }
      if (status === 'TIMED_OUT') {
        console.warn(`[RealtimeChannel] ⏱️ Hand replay channel ${handId} timed out`);
      }
    });

    this.subscriptions.set(channelName, {
      channel,
      type: 'hand',
      entityId: handId,
      onEvent: callbacks.onEvent || (() => {}),
    });

    // Track subscription for monitoring (was missing — hand replays were invisible to
    // the stale-subscription cleanup and subscription monitor)
    this.subscriptionTimestamps.set(channelName, Date.now());
    subscriptionMonitor.register(channelName, 'hand');

    return () => this.unsubscribeFromHand(handId);
  }

  /**
   * Unsubscribe from hand channel
   */
  async unsubscribeFromHand(handId: string): Promise<void> {
    const channelName = `hand:${handId}`;
    const subscription = this.subscriptions.get(channelName);

    if (subscription) {
      await subscription.channel.unsubscribe();
      this.subscriptions.delete(channelName);
      this.subscriptionTimestamps.delete(channelName);
      subscriptionMonitor.unregister(channelName);
    }
  }

  /**
   * Stream hand events for replay
   */
  async streamHandReplay(
    handId: string,
    events: HandEvent[],
    speedMs: number = 1000
  ): Promise<void> {
    const channel = supabase.channel(`hand:${handId}`);
    try {
      await channel.subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          console.error(
            `[RealtimeChannel] ❌ Hand replay stream channel error for ${handId}:`,
            err?.message || err
          );
        }
      });
      for (const event of events) {
        await new Promise((resolve) => setTimeout(resolve, speedMs));
        await channel.send({
          type: 'broadcast',
          event: 'hand_event',
          payload: event,
        });
      }
    } catch (e: unknown) {
      console.error(`[RealtimeChannelService] Hand replay stream failed for ${handId}:`, e);
    } finally {
      // Always clean up — prevents orphaned channels
      try {
        await channel.unsubscribe();
      } catch (e: unknown) {
        console.error('[RealtimeChannel] Cleanup failed:', e);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // LOBBY CHANNEL (Global)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Subscribe to global lobby for club activity
   */
  subscribeToLobby(callbacks: {
    onClubActivity?: (clubId: string, playersOnline: number) => void;
    onTournamentStarting?: (tournament: any) => void;
    onJackpotHit?: (jackpot: any) => void;
  }): () => void {
    const channelName = 'lobby:global';

    // Initialize cleanup on first subscription
    this.initializeCleanupInterval();

    if (this.subscriptions.has(channelName)) {
      return () => this.unsubscribeFromLobby();
    }

    // Enforce subscription limit synchronously
    this.enforceSubscriptionLimitSync();

    const channel = supabase.channel(channelName);

    channel.on('broadcast', { event: 'lobby_update' }, ({ payload }) => {
      switch (payload.type) {
        case 'club_activity':
          callbacks.onClubActivity?.(payload.clubId, payload.playersOnline);
          break;
        case 'tournament_starting':
          callbacks.onTournamentStarting?.(payload.tournament);
          break;
        case 'jackpot_hit':
          callbacks.onJackpotHit?.(payload.jackpot);
          break;
      }
    });

    channel.subscribe((status: string, err?: Error) => {
      if (status === 'CHANNEL_ERROR') {
        console.error(`[RealtimeChannel] ❌ Lobby channel error:`, err?.message || err);
      }
      if (status === 'TIMED_OUT') {
        console.warn(`[RealtimeChannel] ⏱️ Lobby channel timed out`);
      }
    });

    this.subscriptions.set(channelName, {
      channel,
      type: 'lobby',
      entityId: 'global',
      onEvent: () => {},
    });

    // Track subscription for monitoring
    this.subscriptionTimestamps.set(channelName, Date.now());
    subscriptionMonitor.register(channelName, 'lobby');

    return () => this.unsubscribeFromLobby();
  }

  /**
   * Unsubscribe from lobby
   */
  async unsubscribeFromLobby(): Promise<void> {
    const channelName = 'lobby:global';
    const subscription = this.subscriptions.get(channelName);

    if (subscription) {
      await subscription.channel.unsubscribe();
      this.subscriptions.delete(channelName);
      this.subscriptionTimestamps.delete(channelName);
      subscriptionMonitor.unregister(channelName);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // UTILITIES
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get all active subscriptions
   */
  getActiveSubscriptions(): Array<{ channel: string; type: ChannelType; entityId: string }> {
    return Array.from(this.subscriptions.entries()).map(([channel, sub]) => ({
      channel,
      type: sub.type,
      entityId: sub.entityId,
    }));
  }

  /**
   * Unsubscribe from all channels
   */
  async unsubscribeAll(): Promise<void> {
    const promises = Array.from(this.subscriptions.values()).map((sub) =>
      sub.channel.unsubscribe()
    );
    await Promise.allSettled(promises);
    this.subscriptions.clear();
    this.subscriptionTimestamps.clear();
    this.presenceState.clear();
    subscriptionMonitor.cleanup();

    // Stop cleanup interval
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Get diagnostics for subscription health
   */
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
      monitor: subscriptionMonitor.getDiagnostics(),
    };
  }

  /**
   * Get subscriptions grouped by type
   */
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
