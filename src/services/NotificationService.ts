/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  NOTIFICATION SERVICE — Push & In-App Notifications
 * Real-time notifications with Supabase subscriptions
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { supabase } from '../lib/supabase';
import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import { masterBus } from '../core/MasterBus';
import { STORAGE_KEYS } from '../lib/storage';
import { reportError } from '../utils/errorReporter';
import { unionRouteRef } from '../utils/unionIdResolver';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface Notification {
  id: string;
  userId: string;
  type:
    | 'waitlist_ready'
    | 'waitlist_seat_open' // engine seat offer (notifyWaitlistSeatOpen)
    | 'table_invite'
    | 'club_announcement'
    | 'message'
    | 'achievement'
    | 'bonus'
    | 'settlement'
    | 'accounting_invoice'
    | 'system'
    | 'your_turn' // Bible V8 5.18: your turn to act
    | 'your_turn_reminder' // Bible V8 5.19: reminder after 5s inaction
    | 'time_bank_active' // Bible V8 5.20: time bank activated
    | 'tournament_starting' // PokerBros: tournament about to start
    | 'hand_won'; // Bible V8 5.21: you won the pot
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
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          if (err)
            reportError(err?.message || err, 'NotificationService._Channel_error_on_notifications');
        }
        if (status === 'TIMED_OUT') {
          console.warn(`[NotificationService] Channel notifications:${userId} timed out`);
        }
      });
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
      .select('id, user_id, type, title, message, metadata, data, read, action_url, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (options?.unreadOnly) {
      query = query.eq('read', false);
    }

    query = query.limit(options?.limit || 100);

    const { data, error } = await query;

    if (error) {
      reportError(error, 'NotificationService.Failed_to_fetch');
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
      .eq('read', false);

    if (error) {
      reportError(error, 'NotificationService.Failed_to_get_count');
      return 0;
    }

    return count || 0;
  }

  /**
   * Mark notification as read
   */
  async markAsRead(notificationId: string): Promise<boolean> {
    // Get the notification's user_id before updating (needed for re-count)
    const { data: notif } = await supabase
      .from('notifications')
      .select('user_id')
      .eq('id', notificationId)
      .maybeSingle();

    const { error } = await supabase
      .from('notifications')
      .update({ read: true })
      .eq('id', notificationId);

    if (error) {
      reportError(error, 'NotificationService.Failed_to_mark_as_read');
      return false;
    }

    // Emit NOTIFICATION_READ for instant header badge decrement
    masterBus.emit('NOTIFICATION_READ', { notifId: notificationId, allRead: false });

    // Re-count and emit for other consumers
    if (notif?.user_id) {
      const { count: remaining } = await supabase
        .from('notifications')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', notif.user_id)
        .eq('read', false);
      masterBus.emit('NOTIFICATION_COUNT_CHANGED', { count: remaining || 0 });
    }

    return true;
  }

  /**
   * Mark all notifications as read
   */
  async markAllAsRead(userId: string): Promise<boolean> {
    const { error } = await supabase
      .from('notifications')
      .update({ read: true })
      .eq('user_id', userId)
      .eq('read', false);

    if (error) {
      reportError(error, 'NotificationService.Failed_to_mark_all_as_read');
      return false;
    }

    // Emit NOTIFICATION_READ with allRead: true for instant badge zero
    masterBus.emit('NOTIFICATION_READ', { notifId: null, allRead: true });
    masterBus.emit('NOTIFICATION_COUNT_CHANGED', { count: 0 });
    return true;
  }

  /**
   * Create a notification (with auto-generated deep-link URL)
   */
  async create(
    notification: Omit<Notification, 'id' | 'createdAt' | 'isRead'>
  ): Promise<Notification | null> {
    // Q3: Auto-generate action_url from metadata
    const actionUrl = this.getDeepLinkUrl(notification.type, notification.metadata);

    const { data, error } = await supabase
      .from('notifications')
      .insert({
        user_id: notification.userId,
        type: notification.type,
        title: notification.title,
        message: notification.message,
        metadata: notification.metadata,
        action_url: actionUrl,
        read: false,
      })
      .select()
      .maybeSingle();

    if (error) {
      reportError(error, 'NotificationService.Failed_to_create');
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
      title: 'Your Seat Is Ready!',
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
        .select('user_id:player_id')
        .eq('id', cashoutId)
        .maybeSingle();

      if (cashoutError || !cashout) {
        reportError(
          new Error('[NotificationService] Cashout request not found'),
          'NotificationService.Cashout_request_not_found'
        );
        return;
      }

      // Verify the requesting user is the one making the cashout (not an arbitrary user)
      if (cashout.user_id !== requestingUserId) {
        reportError(
          new Error('[NotificationService] User attempting to trigger cashout for another user'),
          'NotificationService.User_attempting_to_trigger_cashout_for_a'
        );
        return;
      }
    }

    await this.create({
      userId: agentId,
      type: 'settlement',
      title: 'Cash-Out Request',
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
  public getDeepLinkUrl(
    type: Notification['type'],
    metadata?: Record<string, unknown>
  ): string | undefined {
    if (!metadata) return undefined;

    switch (type) {
      case 'waitlist_ready':
        return metadata.tableId ? `/table/${metadata.tableId}` : '/';
      case 'waitlist_seat_open': {
        // The engine writes { table_id } into the row's `data` column, which
        // mapNotification folds into this metadata bag. Snake and camel both
        // accepted so an older writer still deep-links.
        const tid = (metadata.table_id ?? metadata.tableId) as string | undefined;
        // ?buyin=1: the seat is held 60s (Dan 2026-08-30) — land the player on
        // the table with the buy-in screen ALREADY OPEN, not just the felt.
        return tid ? `/table/${tid}?buyin=1` : '/waitlist';
      }
      case 'table_invite':
        return metadata.tableId ? `/table/${metadata.tableId}` : '/';
      case 'club_announcement':
        return metadata.clubSlug
          ? `/clubs/${metadata.clubSlug}`
          : metadata.clubId
            ? `/clubs/${metadata.clubId}`
            : '/clubs';
      case 'message':
        return metadata.conversationId
          ? `/messages/${metadata.conversationId}`
          : metadata.senderId
            ? `/profile/${metadata.senderId}`
            : '/messages';
      case 'accounting_invoice': {
        const conversation = metadata.conversation_id ?? metadata.conversationId;
        return typeof conversation === 'string' && conversation.trim()
          ? `/hub/messenger?conversation=${encodeURIComponent(conversation)}`
          : undefined;
      }
      case 'achievement':
        return '/achievements';
      case 'bonus':
        return '/bonus';
      case 'settlement':
        if (metadata.unionId)
          return `/unions/${unionRouteRef(String(metadata.unionId))}/settlement`;
        return metadata.clubSlug
          ? `/clubs/${metadata.clubSlug}/financials`
          : metadata.clubId
            ? `/clubs/${metadata.clubId}/financials`
            : '/wallet';
      case 'your_turn':
      case 'your_turn_reminder':
      case 'time_bank_active':
      case 'hand_won':
        return metadata.tableId ? `/table/${metadata.tableId}` : '/';
      case 'tournament_starting':
        return metadata.tournamentId
          ? `/tournament/${metadata.tournamentId}`
          : metadata.clubSlug
            ? `/clubs/${metadata.clubSlug}/tournaments`
            : metadata.clubId
              ? `/clubs/${metadata.clubId}/tournaments`
              : '/tournaments';
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
    localStorage.setItem(STORAGE_KEYS.DND_UNTIL, String(this.dndUntil));
    console.info(`[DND] Notifications muted for ${durationMinutes} minutes`);
  }

  /**
   * Disable DND mode immediately
   */
  clearDnd(): void {
    this.dndUntil = null;
    localStorage.removeItem(STORAGE_KEYS.DND_UNTIL);
  }

  /**
   * Check if DND mode is currently active
   */
  isDndActive(): boolean {
    if (this.dndUntil === null) {
      // Rehydrate from localStorage
      const saved = localStorage.getItem(STORAGE_KEYS.DND_UNTIL);
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
  // BIBLE V8 5.18-5.21: ANTI-SPAM GATE FOR GAME NOTIFICATIONS
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // Per-turn notification limits:
  //   - "your_turn": max 1 initial + 1 reminder per turn
  //   - "time_bank_active": max 1 per turn
  //   - Other game notifications: max 1 per type per 30s window
  //
  // Prevents notification spam during rapid multi-way action.

  private turnNotificationLog: Map<string, { count: number; lastSent: number }> = new Map();

  /**
   * Check if a game notification should be sent (anti-spam gate).
   * Returns true if the notification is allowed, false if suppressed.
   * Bible V8 5.18-5.21: one initial + one reminder max per turn.
   */
  shouldSendGameNotification(
    userId: string,
    type: 'your_turn' | 'your_turn_reminder' | 'time_bank_active' | 'hand_won' | 'new_hand',
    handId?: string
  ): boolean {
    // DND overrides everything
    if (this.isDndActive()) return false;

    const key = `${userId}:${type}:${handId || 'global'}`;
    const now = Date.now();
    const entry = this.turnNotificationLog.get(key);

    // Per-type limits per Bible V8 5.18-5.21
    const maxPerTurn: Record<string, number> = {
      your_turn: 1, // One initial notification
      your_turn_reminder: 1, // One reminder after 5s
      time_bank_active: 1, // One time-bank notification
      hand_won: 1, // One win notification
      new_hand: 1, // One new-hand notification for absent players
    };

    const limit = maxPerTurn[type] ?? 1;

    if (entry) {
      // Within same turn/hand: check count
      if (entry.count >= limit) return false;
      // Minimum 5s between same-type notifications (anti-spam floor)
      if (now - entry.lastSent < 5000) return false;
      entry.count++;
      entry.lastSent = now;
    } else {
      this.turnNotificationLog.set(key, { count: 1, lastSent: now });
    }

    // Clean old entries (older than 5 minutes) to prevent memory leak
    if (this.turnNotificationLog.size > 200) {
      const cutoff = now - 5 * 60_000;
      for (const [k, v] of this.turnNotificationLog) {
        if (v.lastSent < cutoff) this.turnNotificationLog.delete(k);
      }
    }

    return true;
  }

  /**
   * Reset turn notification tracking (call when a new hand starts).
   * This clears all per-turn limits so the next hand gets fresh notifications.
   */
  resetTurnNotifications(): void {
    this.turnNotificationLog.clear();
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
      // Every accounting transaction retains its own visible notification.
      if (notif.type === 'accounting_invoice') {
        ungroupable.push(notif);
        continue;
      }
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
      reportError(err, 'NotificationService.Error');
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
      // The engine writes its payload into `data` (waitlist_seat_open carries
      // { table_id } there); older writers used `metadata`. Fold both so a
      // deep link never depends on which column the writer chose.
      metadata: {
        ...((data.data as Record<string, unknown>) || {}),
        ...((data.metadata as Record<string, unknown>) || {}),
      },
      isRead: (data.read ?? false) as boolean,
      createdAt: data.created_at as string,
    };
  }
}

// Export singleton instance
export const notificationService = new NotificationServiceClass();
