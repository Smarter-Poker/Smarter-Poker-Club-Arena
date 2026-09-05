/**
 * NOTIFICATION PREFERENCES AND PROFILE QR
 * ============================================================================
 * What is left of the old MessagingService.
 *
 * The file used to be 1,444 lines: subscribe, getConversations, getMessages,
 * sendMessage, reactions, pinning, forwarding, scheduling, read receipts,
 * announcement channels, typing presence. All of it read and wrote the
 * `conversations` / `messages` table family, which is Club Arena's own
 * messaging tree and is NOT the messenger this platform runs. The live
 * messenger is the social_* family behind /hub/messenger, and every screen a
 * user can actually reach goes there. `public.messages` has never held a row.
 *
 * Worse than dead: it was dead code that LOOKED alive. There were unit tests
 * exercising getConversations, getMessages, getReactions, markAsRead, search
 * and pinning, all passing, all against tables nothing writes to. That is
 * negative value - it is confidence in a path no user can take. The tests went
 * with the code they tested.
 *
 * Four methods had real callers, and none of them touch a database:
 *
 *   getNotificationPreferences / setNotificationPreferences
 *                          localStorage, read by NotificationSettingsPanel
 *   isNotificationTypeMuted  localStorage, read by NotificationService
 *
 * Those three are what remain. (generateProfileQRData, the fourth survivor,
 * went on 2026-09-04: it built an api.qrserver.com URL, and PublicProfilePage
 * now renders the code locally with qrcode.react.) If messaging logic is needed on the Club Arena
 * side again, it belongs against social_* - not against this tree.
 *
 * Removed 2026-08-21. History is in git; the deleted methods are recoverable
 * from the commit before this one if any of them is ever wanted back.
 */

import { STORAGE_KEYS } from '../lib/storage';
import { reportError } from '../utils/errorReporter';

const DEFAULT_PREFERENCES: Record<string, boolean> = {
  messages: true,
  games: true,
  social: true,
  achievements: true,
  system: true,
};

class MessagingServiceClass {
  /** Notification preferences, per category, from localStorage. */
  getNotificationPreferences(): Record<string, boolean> {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.NOTIF_PREFERENCES);
      return raw ? JSON.parse(raw) : { ...DEFAULT_PREFERENCES };
    } catch (err) {
      reportError(err, 'MessagingService.getNotificationPreferences');
      return { ...DEFAULT_PREFERENCES };
    }
  }

  setNotificationPreferences(prefs: Record<string, boolean>): void {
    try {
      localStorage.setItem(STORAGE_KEYS.NOTIF_PREFERENCES, JSON.stringify(prefs));
    } catch (err) {
      // Private browsing and a full quota both throw here. Losing a
      // preference is not worth taking the settings panel down with it.
      reportError(err, 'MessagingService.setNotificationPreferences');
    }
  }

  /**
   * Map a notification DB type onto the preference category the UI shows.
   * The DB types are finer-grained than the five switches a user gets, so an
   * unknown type falls through to 'system' rather than being silently muted.
   */
  private mapNotifTypeToCategory(type: string): string {
    switch (type) {
      case 'message':
        return 'messages';
      case 'waitlist_ready':
      case 'table_invite':
        return 'games';
      case 'club_announcement':
      case 'friend_request':
        return 'social';
      case 'achievement':
      case 'bonus':
        return 'achievements';
      case 'settlement':
      case 'system':
      default:
        return 'system';
    }
  }

  isNotificationTypeMuted(type: string): boolean {
    const prefs = this.getNotificationPreferences();
    return prefs[this.mapNotifTypeToCategory(type)] === false;
  }
}

export const messagingService = new MessagingServiceClass();
