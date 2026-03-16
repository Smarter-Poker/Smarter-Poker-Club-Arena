/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  NOTIFICATION SERVICE — Push & In-App Notifications
 * Real-time notifications with Supabase subscriptions
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { supabase } from '../lib/supabase';
import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import { masterBus } from '../core/MasterBus';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface Notification {
  id: string;
  userId: string;
  type:
    | 'waitlist_ready'
    | 'table_invite'
    | 'club_announcement'
    | 'message'
    | 'achievement'
    | 'bonus'
    | 'settlement'
    | 'system';
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
  isRead: boolean;
  createdAt: string;
}

interface NotificationCallbacks {
  onNew?: (notification: Notification) => void;
  onUpdate?: (notification: Notification) => void;
  onDelete?: (notificationId: string) => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

class NotificationServiceClass {
  private channel: RealtimeChannel | null = null;
  private callbacks: NotificationCallbacks = {};
  private currentUserId: string | null = null;

  /**
   * Subscribe to real-time notifications for a user
   */
  async subscribe(userId: string, callbacks: NotificationCallbacks): Promise<void> {
    if (this.channel) {
      await this.unsubscribe();
    }

    this.currentUserId = userId;
    this.callbacks = callbacks;

    this.channel = supabase
      .channel(`notifications:${userId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${userId}`,
        },
        (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
          if (callbacks.onNew && payload.new) {
            const notification = this.mapNotification(payload.new);
            callbacks.onNew(notification);
            this.showBrowserNotification(notification);
            masterBus.emit('NOTIFICATION_RECEIVED', {
              notification: notification as unknown as Record<string, unknown>,
            });
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${userId}`,
        },
        (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
          if (callbacks.onUpdate && payload.new) {
            callbacks.onUpdate(this.mapNotification(payload.new));
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${userId}`,
        },
        (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
          if (callbacks.onDelete && payload.old) {
            const old = payload.old as Record<string, unknown>;
            callbacks.onDelete(old.id as string);
          }
        }
      )
      .subscribe();
  }

  /**
   * Unsubscribe from notifications
   */
  async unsubscribe(): Promise<void> {
    if (this.channel) {
      await supabase.removeChannel(this.channel);
      this.channel = null;
      this.currentUserId = null;
    }
  }

  /**
   * Get all notifications for a user
   */
  async getNotifications(
    userId: string,
    options?: { unreadOnly?: boolean; limit?: number }
  ): Promise<Notification[]> {
    let query = supabase
      .from('notifications')
      .select('id, user_id, type, title, message, metadata, is_read, action_url, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (options?.unreadOnly) {
      query = query.eq('is_read', false);
    }

    query = query.limit(options?.limit || 100);

    const { data, error } = await query;

    if (error) {
      console.error('[Notifications] Failed to fetch:', error);
      return [];
    }

    return (data || []).map(this.mapNotification);
  }

  /**
   * Get unread count
   */
  async getUnreadCount(userId: string): Promise<number> {
    const { count, error } = await supabase
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('is_read', false);

    if (error) {
      console.error('[Notifications] Failed to get count:', error);
      return 0;
    }

    return count || 0;
  }

  /**
   * Mark notification as read
   */
  async markAsRead(notificationId: string): Promise<boolean> {
    const { error } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('id', notificationId);

    if (error) {
      console.error('[Notifications] Failed to mark as read:', error);
      return false;
    }

    masterBus.emit('NOTIFICATION_COUNT_CHANGED', {} as Record<string, unknown>);
    return true;
  }

  /**
   * Mark all notifications as read
   */
  async markAllAsRead(userId: string): Promise<boolean> {
    const { error } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', userId)
      .eq('is_read', false);

    if (error) {
      console.error('[Notifications] Failed to mark all as read:', error);
      return false;
    }

    masterBus.emit('NOTIFICATION_COUNT_CHANGED', {} as Record<string, unknown>);
    return true;
  }

  /**
   * Create a notification (with auto-generated deep-link URL)
   */
  async create(
    notification: Omit<Notification, 'id' | 'createdAt' | 'isRead'>
  ): Promise<Notification | null> {
    // Q3: Auto-generate action_url from metadata
    const actionUrl = NotificationServiceClass.getDeepLinkUrl(
      notification.type,
      notification.metadata
    );

    const { data, error } = await supabase
      .from('notifications')
      .insert({
        user_id: notification.userId,
        type: notification.type,
        title: notification.title,
        message: notification.message,
        metadata: notification.metadata,
        action_url: actionUrl,
        is_read: false,
      })
      .select()
      .maybeSingle();

    if (error) {
      console.error('[Notifications] Failed to create:', error);
      return null;
    }

    return this.mapNotification(data);
  }

  /**
   * Send waitlist ready notification
   */
  async notifyWaitlistReady(userId: string, tableName: string, tableId: string): Promise<void> {
    await this.create({
      userId,
      type: 'waitlist_ready',
      title: 'Your seat is ready!',
      message: `A seat is now available at ${tableName}`,
      metadata: { tableId },
    });
  }

  /**
   * 🏧 Notify agent when a player requests a cash-out
   * SECURITY: Verifies requesting user is the one making the cashout (requestingUserId == playerRequestingUserId)
   */
  async notifyCashoutRequest(
    agentId: string,
    playerName: string,
    amount: number,
    clubId: string,
    cashoutId: string,
    requestingUserId?: string
  ): Promise<void> {
    // Authorization check: if requestingUserId provided, verify it matches the player making the request
    if (requestingUserId) {
      const { data: cashout, error: cashoutError } = await supabase
        .from('cashout_requests')
        .select('user_id')
        .eq('id', cashoutId)
        .maybeSingle();

      if (cashoutError || !cashout) {
        console.error('[NotificationService] Cashout request not found');
        return;
      }

      // Verify the requesting user is the one making the cashout (not an arbitrary user)
      if (cashout.user_id !== requestingUserId) {
        console.error('[NotificationService] User attempting to trigger cashout for another user');
        return;
      }
    }

    await this.create({
      userId: agentId,
      type: 'settlement',
      title: '🏧 Cash-Out Request',
      message: `${playerName} requested to cash out ${amount.toLocaleString()} chips`,
      metadata: { clubId, cashoutId, playerName, amount },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Q3: DEEP-LINK URL GENERATION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Generate the appropriate deep-link URL based on notification type + metadata
   */
  static getDeepLinkUrl(
    type: Notification['type'],
    metadata?: Record<string, unknown>
  ): string | undefined {
    if (!metadata) return undefined;

    switch (type) {
      case 'waitlist_ready':
        return metadata.tableId ? `/table/${metadata.tableId}` : '/lobby';
      case 'table_invite':
        return metadata.tableId ? `/table/${metadata.tableId}` : '/lobby';
      case 'club_announcement':
        return metadata.clubId ? `/club/${metadata.clubId}` : '/clubs';
      case 'message':
        return metadata.conversationId
          ? `/messages/${metadata.conversationId}`
          : metadata.senderId
            ? `/profile/${metadata.senderId}`
            : '/messages';
      case 'achievement':
        return '/achievements';
      case 'bonus':
        return '/bonus';
      case 'settlement':
        return metadata.clubId ? `/club/${metadata.clubId}/financials` : '/wallet';
      case 'system':
      default:
        return undefined;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Q3: DO NOT DISTURB MODE
  // ═══════════════════════════════════════════════════════════════════════════

  private dndUntil: number | null = null;

  /**
   * Enable DND mode for a specified duration in minutes
   */
  setDnd(durationMinutes: number): void {
    this.dndUntil = Date.now() + durationMinutes * 60_000;
    localStorage.setItem('dnd_until', String(this.dndUntil));
    console.info(`[DND] Notifications muted for ${durationMinutes} minutes`);
  }

  /**
   * Disable DND mode immediately
   */
  clearDnd(): void {
    this.dndUntil = null;
    localStorage.removeItem('dnd_until');
  }

  /**
   * Check if DND mode is currently active
   */
  isDndActive(): boolean {
    if (this.dndUntil === null) {
      // Rehydrate from localStorage
      const saved = localStorage.getItem('dnd_until');
      if (saved) this.dndUntil = Number(saved);
    }
    if (this.dndUntil && Date.now() < this.dndUntil) return true;
    if (this.dndUntil && Date.now() >= this.dndUntil) {
      this.clearDnd(); // Auto-expire
    }
    return false;
  }

  /**
   * Get remaining DND time in minutes (0 if not active)
   */
  getDndRemaining(): number {
    if (!this.isDndActive() || !this.dndUntil) return 0;
    return Math.ceil((this.dndUntil - Date.now()) / 60_000);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Q3: NOTIFICATION GROUPING UTILITY
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Group similar notifications for collapsed display.
   * E.g. "3 new friend requests" instead of 3 individual entries.
   */
  groupNotifications(
    notifications: Notification[]
  ): Array<Notification & { groupCount?: number; groupIds?: string[] }> {
    const groups = new Map<string, Notification[]>();
    const ungroupable: Notification[] = [];

    for (const notif of notifications) {
      // Handle both camelCase (service) and snake_case (page) timestamp fields
      const timestamp = (notif as any).createdAt || (notif as any).created_at;
      const timeBucket = timestamp ? Math.floor(new Date(timestamp).getTime() / (30 * 60_000)) : 0;

      // Extract grouping key from title prefix (first 2-3 words) + type + time window
      const titlePrefix = (notif.title || '').split(' ').slice(0, 3).join(' ').toLowerCase();
      const groupKey = `${titlePrefix}:${notif.type}:${timeBucket}`;

      // Only group notifications with matching title patterns
      if (titlePrefix.length > 0) {
        if (!groups.has(groupKey)) groups.set(groupKey, []);
        groups.get(groupKey)!.push(notif);
      } else {
        ungroupable.push(notif);
      }
    }

    const result: Array<Notification & { groupCount?: number; groupIds?: string[] }> = [];

    for (const [, group] of groups) {
      if (group.length >= 3) {
        // Collapse into a single entry
        const newest = group[0]; // Already sorted newest-first
        result.push({
          ...newest,
          title: `${group.length} ${newest.title.split(' ').slice(0, 2).join(' ')}…`,
          message: group
            .map((n) => n.message)
            .slice(0, 3)
            .join(' • '),
          groupCount: group.length,
          groupIds: group.map((n) => n.id),
        });
      } else {
        result.push(...group);
      }
    }

    result.push(...ungroupable);
    // Sort using whichever timestamp field exists
    result.sort((a, b) => {
      const aTime = new Date((a as any).createdAt || (a as any).created_at || 0).getTime();
      const bTime = new Date((b as any).createdAt || (b as any).created_at || 0).getTime();
      return bTime - aTime;
    });
    return result;
  }

  /**
   * Show browser notification (if permitted and not in DND)
   */
  private async showBrowserNotification(notification: Notification): Promise<void> {
    // Q3: Respect DND mode
    if (this.isDndActive()) return;

    // Q3: Respect per-type notification preferences
    try {
      const { messagingService } = await import('./MessagingService');
      if (messagingService.isNotificationTypeMuted(notification.type)) return;
    } catch (err) {

      console.error("[NotificationService] Error:", err);
      /* service not loaded — allow notification */
    }

    if (!('Notification' in window)) return;

    if (Notification.permission === 'default') {
      await Notification.requestPermission();
    }

    if (Notification.permission === 'granted') {
      new Notification(notification.title, {
        body: notification.message,
        icon: '/favicon.ico',
        tag: notification.id,
      });
    }
  }

  /**
   * Request browser notification permission
   */
  async requestPermission(): Promise<boolean> {
    if (!('Notification' in window)) return false;

    const result = await Notification.requestPermission();
    return result === 'granted';
  }

  /**
   * Map database record to Notification type
   */
  private mapNotification(data: Record<string, unknown>): Notification {
    return {
      id: data.id as string,
      userId: data.user_id as string,
      type: data.type as Notification['type'],
      title: data.title as string,
      message: data.message as string,
      metadata: data.metadata as Record<string, unknown> | undefined,
      isRead: (data.read ?? data.is_read ?? false) as boolean,
      createdAt: data.created_at as string,
    };
  }
}

// Export singleton instance
export const notificationService = new NotificationServiceClass();
