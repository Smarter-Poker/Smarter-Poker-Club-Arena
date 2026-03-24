/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PUSH NOTIFICATION SERVICE — OneSignal Integration
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Handles push notifications via OneSignal for:
 * - Table seat availability alerts
 * - Tournament start reminders
 * - Settlement notifications
 * - Achievement unlocks
 * - Friend requests
 * - Club announcements
 */

import { supabase } from '../lib/supabase';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type NotificationCategory =
  | 'table_available'
  | 'tournament_start'
  | 'tournament_result'
  | 'settlement'
  | 'achievement'
  | 'friend_request'
  | 'club_announcement'
  | 'wallet_credit'
  | 'general';

export interface PushNotificationPayload {
  title: string;
  message: string;
  category: NotificationCategory;
  data?: Record<string, any>;
  url?: string; // Deep link URL
  imageUrl?: string;
}

export interface NotificationPreferences {
  tableAlerts: boolean;
  tournamentReminders: boolean;
  achievementAlerts: boolean;
  friendAlerts: boolean;
  clubAnnouncements: boolean;
  settlementAlerts: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ONESIGNAL CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

const ONESIGNAL_APP_ID = import.meta.env.VITE_ONESIGNAL_APP_ID || '';

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

class PushNotificationServiceClass {
  private initialized = false;

  /**
   * Initialize OneSignal SDK (call on app start)
   */
  async init(): Promise<void> {
    if (this.initialized || !ONESIGNAL_APP_ID) {
      console.debug('[PushService] OneSignal not configured or already initialized');
      return;
    }

    try {
      // OneSignal Web SDK initialization
      // @ts-expect-error - OneSignal CDN types - OneSignal is loaded via CDN
      if (typeof window !== 'undefined' && window.OneSignalDeferred) {
        // @ts-expect-error - OneSignal CDN types
        window.OneSignalDeferred.push(async (OneSignal: any) => {
          try {
            await OneSignal.init({
              appId: ONESIGNAL_APP_ID,
              allowLocalhostAsSecureOrigin: true,
              notifyButton: { enable: false },
            });
            this.initialized = true;
          } catch (innerErr: unknown) {
            console.debug('[PushService] OneSignal.init() failed inside deferred:', innerErr);
          }
        });
      }
    } catch (error: unknown) {
      console.debug('[PushService] Init failed:', error);
    }
  }

  /**
   * Register/update user's OneSignal external ID
   */
  async setExternalUserId(userId: string): Promise<void> {
    try {
      // @ts-expect-error - OneSignal CDN types
      if (typeof window !== 'undefined' && window.OneSignal) {
        // @ts-expect-error - OneSignal CDN types
        await window.OneSignal.login(userId);
      }
    } catch (error: unknown) {
      // OneSignal SDK v16 intermittent issue — non-blocking, suppress to warn
      console.debug('[PushService] External user ID set skipped (OneSignal SDK):', (error as Error)?.message || error);
    }
  }

  /**
   * Request push notification permission
   */
  async requestPermission(): Promise<boolean> {
    try {
      // @ts-expect-error - OneSignal CDN types
      if (typeof window !== 'undefined' && window.OneSignal) {
        // @ts-expect-error - OneSignal CDN types
        const permission = await window.OneSignal.Notifications.requestPermission();
        return permission;
      }
      return false;
    } catch (error: unknown) {
      console.error('[PushService] Permission request failed:', error);
      return false;
    }
  }

  /**
   * Check if push notifications are enabled
   */
  async isEnabled(): Promise<boolean> {
    try {
      // @ts-expect-error - OneSignal CDN types
      if (typeof window !== 'undefined' && window.OneSignal) {
        // @ts-expect-error - OneSignal CDN types
        return await window.OneSignal.Notifications.permission;
      }
      return false;
    } catch (err) {
      console.error('[PushNotificationService] Error:', err);
      return false;
    }
  }

  /**
   * Send push notification to specific user(s)
   * Uses Supabase Edge Function to call OneSignal REST API
   */
  async sendToUser(userId: string, payload: PushNotificationPayload): Promise<boolean> {
    return this.sendToUsers([userId], payload);
  }

  /**
   * Send push notification to multiple users
   */
  async sendToUsers(userIds: string[], payload: PushNotificationPayload): Promise<boolean> {
    try {
      // Check user preferences before sending
      const filteredUserIds = await this.filterByPreferences(userIds, payload.category);
      if (filteredUserIds.length === 0) return true;

      const { error } = await supabase.functions.invoke('send-push-notification', {
        body: {
          userIds: filteredUserIds,
          title: payload.title,
          message: payload.message,
          category: payload.category,
          data: payload.data,
          url: payload.url,
          imageUrl: payload.imageUrl,
        },
      });

      if (error) throw error;
      return true;
    } catch (error: unknown) {
      console.error('[PushService] Send failed:', error);
      return false;
    }
  }

  /**
   * Filter users based on their notification preferences
   */
  private async filterByPreferences(
    userIds: string[],
    category: NotificationCategory
  ): Promise<string[]> {
    // Map category to preference field
    const categoryToField: Record<NotificationCategory, keyof NotificationPreferences> = {
      table_available: 'tableAlerts',
      tournament_start: 'tournamentReminders',
      tournament_result: 'tournamentReminders',
      settlement: 'settlementAlerts',
      achievement: 'achievementAlerts',
      friend_request: 'friendAlerts',
      club_announcement: 'clubAnnouncements',
      wallet_credit: 'tableAlerts', // Fallback to table alerts
      general: 'clubAnnouncements',
    };

    const field = categoryToField[category];
    if (!field) return userIds;

    try {
      const { data } = await supabase
        .from('user_notification_preferences')
        .select('user_id')
        .in('user_id', userIds)
        .eq(field, true);

      // If no preferences found, assume all enabled (default on)
      if (!data || data.length === 0) return userIds;
      return data.map((d) => d.user_id);
    } catch (err) {
      console.error('[PushNotificationService] Error:', err);
      return userIds; // On error, send to all
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // CONVENIENCE METHODS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Notify user that a table seat is available
   */
  async notifyTableAvailable(userId: string, tableName: string, tableId: string): Promise<boolean> {
    return this.sendToUser(userId, {
      title: '🪑 Seat Available!',
      message: `A seat opened up at ${tableName}`,
      category: 'table_available',
      url: `/table/${tableId}`,
      data: { tableId },
    });
  }

  /**
   * Notify users that tournament is starting soon
   */
  async notifyTournamentStarting(
    userIds: string[],
    tournamentName: string,
    tournamentId: string,
    minutesUntilStart: number
  ): Promise<boolean> {
    return this.sendToUsers(userIds, {
      title: ' Tournament Starting Soon!',
      message: `${tournamentName} starts in ${minutesUntilStart} minutes`,
      category: 'tournament_start',
      url: `/tournament/${tournamentId}`,
      data: { tournamentId },
    });
  }

  /**
   * Notify user of tournament result
   */
  async notifyTournamentResult(
    userId: string,
    tournamentName: string,
    position: number,
    prize: number
  ): Promise<boolean> {
    const message =
      position === 1
        ? ` You won ${tournamentName}! Prize: ${prize.toLocaleString()} chips`
        : `You finished ${position}${this.ordinal(position)} in ${tournamentName}${prize > 0 ? ` — ${prize.toLocaleString()} chips` : ''}`;

    return this.sendToUser(userId, {
      title: position === 1 ? ' Tournament Victory!' : ' Tournament Complete',
      message,
      category: 'tournament_result',
    });
  }

  /**
   * Notify user of achievement unlock
   */
  async notifyAchievement(userId: string, achievementName: string): Promise<boolean> {
    return this.sendToUser(userId, {
      title: ' Achievement Unlocked!',
      message: `${achievementName}`,
      category: 'achievement',
      url: '/achievements',
    });
  }

  /**
   * Notify user of friend request
   */
  async notifyFriendRequest(userId: string, fromUsername: string): Promise<boolean> {
    return this.sendToUser(userId, {
      title: ' Friend Request',
      message: `${fromUsername} wants to be your friend`,
      category: 'friend_request',
      url: '/friends',
    });
  }

  /**
   * Notify club members of announcement
   */
  async notifyClubAnnouncement(
    userIds: string[],
    clubName: string,
    announcement: string
  ): Promise<boolean> {
    return this.sendToUsers(userIds, {
      title: ` ${clubName}`,
      message: announcement.substring(0, 100) + (announcement.length > 100 ? '...' : ''),
      category: 'club_announcement',
    });
  }

  /**
   * Notify user of settlement/payout
   */
  async notifySettlement(userId: string, amount: number, periodLabel: string): Promise<boolean> {
    return this.sendToUser(userId, {
      title: ' Payout Received!',
      message: `${amount.toLocaleString()} chips credited for ${periodLabel}`,
      category: 'settlement',
      url: '/wallet',
    });
  }

  private ordinal(n: number): string {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return s[(v - 20) % 10] || s[v] || s[0];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export const pushNotificationService = new PushNotificationServiceClass();
export const PushNotificationService = pushNotificationService;
export default pushNotificationService;
