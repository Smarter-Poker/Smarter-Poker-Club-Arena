/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PRESENCE SERVICE — Real-time Online Tracking
 * Uses Supabase Realtime Presence for union/club online counts
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { supabase } from '../lib/supabase';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface PresenceState {
  userId: string;
  clubId?: string;
  unionId?: string;
  tableId?: string;
  status: 'online' | 'away' | 'playing';
  lastSeen: string;
}

interface PresenceCallbacks {
  onSync?: (state: Record<string, PresenceState[]>) => void;
  onJoin?: (userId: string, current: PresenceState) => void;
  onLeave?: (userId: string, leftPresence: PresenceState) => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

class PresenceServiceClass {
  private channels: Map<string, RealtimeChannel> = new Map();
  private channelHeartbeats: Map<string, ReturnType<typeof setInterval>> = new Map();
  private currentUserId: string | null = null;
  private unloadListener: (() => void) | null = null;

  constructor() {
    // Ensure cleanup on page unload
    this.setupUnloadHandler();
  }

  /**
   * Setup beforeunload event listener to cleanup all channels
   */
  private setupUnloadHandler(): void {
    if (typeof window !== 'undefined') {
      const handleUnload = async () => {
        await this.leaveAll();
      };

      window.addEventListener('beforeunload', handleUnload);
      this.unloadListener = () => {
        window.removeEventListener('beforeunload', handleUnload);
      };
    }
  }

  /**
   * Join a presence channel (club, union, or table)
   */
  async join(
    channelName: string,
    userId: string,
    presence: Omit<PresenceState, 'userId' | 'lastSeen'>,
    callbacks?: PresenceCallbacks
  ): Promise<RealtimeChannel | null> {
    if (this.channels.has(channelName)) {
      return this.channels.get(channelName)!;
    }

    this.currentUserId = userId;

    const channel = supabase.channel(channelName, {
      config: {
        presence: { key: userId },
      },
    });

    // Set up event handlers
    channel
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState<PresenceState>();
        if (callbacks?.onSync) {
          callbacks.onSync(state);
        }
      })
      .on('presence', { event: 'join' }, ({ key, newPresences }) => {
        if (callbacks?.onJoin && newPresences.length > 0) {
          callbacks.onJoin(key, newPresences[0] as unknown as PresenceState);
        }
      })
      .on('presence', { event: 'leave' }, ({ key, leftPresences }) => {
        if (callbacks?.onLeave && leftPresences.length > 0) {
          callbacks.onLeave(key, leftPresences[0] as unknown as PresenceState);
        }
      });

    // Subscribe and track
    await channel.subscribe(async (status: string, err?: Error) => {
      if (status === 'SUBSCRIBED') {
        try {
          await channel.track({
            userId,
            ...presence,
            lastSeen: new Date().toISOString(),
          });
        } catch (e: unknown) {
          reportError(e, 'PresenceService.track');
        }
      } else if (status === 'CHANNEL_ERROR') {
        console.debug(`[PresenceService] Channel error on ${channelName}:`, err?.message || err);
      } else if (status === 'TIMED_OUT') {
        console.debug(`[PresenceService] Channel ${channelName} timed out`);
      }
    });

    this.channels.set(channelName, channel);
    this.startHeartbeat(channelName, userId, presence);

    return channel;
  }

  /**
   * Leave a presence channel
   */
  async leave(channelName: string): Promise<void> {
    const channel = this.channels.get(channelName);
    if (!channel) return;

    await channel.untrack();
    await supabase.removeChannel(channel);
    this.channels.delete(channelName);

    // Stop heartbeat for this specific channel
    this.stopHeartbeat(channelName);
  }

  /**
   * Leave all channels
   */
  async leaveAll(): Promise<void> {
    for (const channelName of this.channels.keys()) {
      await this.leave(channelName);
    }
    this.stopHeartbeat();
  }

  /**
   * Get current online count for a channel
   */
  getOnlineCount(channelName: string): number {
    const channel = this.channels.get(channelName);
    if (!channel) return 0;

    const state = channel.presenceState<PresenceState>();
    return Object.keys(state).length;
  }

  /**
   * Get all online users in a channel
   */
  getOnlineUsers(channelName: string): PresenceState[] {
    const channel = this.channels.get(channelName);
    if (!channel) return [];

    const state = channel.presenceState<PresenceState>();
    return Object.values(state).flat();
  }

  /**
   * Update presence status
   */
  async updateStatus(channelName: string, status: 'online' | 'away' | 'playing'): Promise<void> {
    const channel = this.channels.get(channelName);
    if (!channel || !this.currentUserId) return;

    await channel.track({
      userId: this.currentUserId,
      status,
      lastSeen: new Date().toISOString(),
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // CONVENIENCE METHODS
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Join a club's presence channel
   */
  async joinClub(
    clubId: string,
    userId: string,
    callbacks?: PresenceCallbacks
  ): Promise<RealtimeChannel | null> {
    return this.join(
      `club:${clubId}`,
      userId,
      {
        clubId,
        status: 'online',
      },
      callbacks
    );
  }

  /**
   * Join a union's presence channel
   */
  async joinUnion(
    unionId: string,
    userId: string,
    callbacks?: PresenceCallbacks
  ): Promise<RealtimeChannel | null> {
    return this.join(
      `union:${unionId}`,
      userId,
      {
        unionId,
        status: 'online',
      },
      callbacks
    );
  }

  /**
   * Join a table's presence channel
   */
  async joinTable(
    tableId: string,
    userId: string,
    callbacks?: PresenceCallbacks
  ): Promise<RealtimeChannel | null> {
    return this.join(
      `table:${tableId}`,
      userId,
      {
        tableId,
        status: 'playing',
      },
      callbacks
    );
  }

  /**
   * Get club online count
   */
  getClubOnlineCount(clubId: string): number {
    return this.getOnlineCount(`club:${clubId}`);
  }

  /**
   * Get union online count
   */
  getUnionOnlineCount(unionId: string): number {
    return this.getOnlineCount(`union:${unionId}`);
  }

  /**
   * Get table online count
   */
  getTableOnlineCount(tableId: string): number {
    return this.getOnlineCount(`table:${tableId}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // HEARTBEAT
  // ═══════════════════════════════════════════════════════════════════════════════

  private startHeartbeat(
    channelName: string,
    userId: string,
    presence: Omit<PresenceState, 'userId' | 'lastSeen'>
  ): void {
    // Don't start duplicate heartbeat for same channel
    if (this.channelHeartbeats.has(channelName)) return;

    // Heartbeat every 30 seconds to update lastSeen per channel
    const interval = setInterval(async () => {
      const channel = this.channels.get(channelName);
      if (!channel) {
        // Channel was removed but heartbeat is still running — clean up
        console.warn(`[PresenceService] Heartbeat orphaned for ${channelName} - stopping`);
        this.stopHeartbeat(channelName);
        return;
      }
      try {
        await channel.track({
          userId,
          ...presence,
          lastSeen: new Date().toISOString(),
        });
      } catch (err: unknown) {
        reportError(err, 'PresenceService.heartbeat', { channelName });
        // Don't stop heartbeat on transient errors — it will retry next interval.
        // But if the channel is gone from our map, stop to prevent memory leak.
        if (!this.channels.has(channelName)) {
          this.stopHeartbeat(channelName);
        }
      }
    }, 60_000); // 60s heartbeat — halves message volume vs 30s, presence accuracy sufficient

    this.channelHeartbeats.set(channelName, interval);
  }

  private stopHeartbeat(channelName?: string): void {
    if (channelName) {
      const interval = this.channelHeartbeats.get(channelName);
      if (interval) {
        clearInterval(interval);
        this.channelHeartbeats.delete(channelName);
      }
    } else {
      // Stop all heartbeats
      for (const interval of this.channelHeartbeats.values()) {
        clearInterval(interval);
      }
      this.channelHeartbeats.clear();
    }
  }
}

// Export singleton instance
export const presenceService = new PresenceServiceClass();
