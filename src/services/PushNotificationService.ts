/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PUSH NOTIFICATION SERVICE — RETIRED TRANSPORT, LIVE CALL SITES
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * EVERY METHOD HERE RETURNS false AND DELIVERS NOTHING. The transport it was
 * built on (a Supabase edge function relaying to OneSignal) was retired on
 * 2026-08-19; the eight call sites that use it were not. See sendToUsers() for
 * the full reasoning, and #1498 for the work to move each flow server-side.
 *
 * It is kept rather than deleted because deleting it would silently drop the
 * INTENT — the recipient, the category, the exact copy each flow wants to send
 * are all recorded here, and that is most of the specification for the
 * replacement. Removing it would leave nothing to port.
 *
 * The flows still waiting on a working transport:
 *   - table seat availability     (covered server-side already: waitlist_seat_open)
 *   - tournament start / result   (NOT covered)
 *   - settlement                  (covered, barely: 1 notification in 30 days)
 *   - achievement unlocks         (NOT covered)
 *   - friend requests             (covered server-side already)
 *   - club announcements          (NOT covered)
 *   - wallet credit / cashout     (NOT covered)
 *   - disputes                    (NOT covered)
 * Measured against production 2026-08-29 by grouping `notifications` by type
 * over 30 days.
 */

import { reportError } from '../utils/errorReporter';

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
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

class PushNotificationServiceClass {
  /**
   * Send push notification to specific user(s).
   *
   * RETIRED. Always returns false. See sendToUsers().
   */
  async sendToUser(userId: string, payload: PushNotificationPayload): Promise<boolean> {
    return this.sendToUsers([userId], payload);
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════
   *  RETIRED. THIS DELIVERS NOTHING, AND IT CANNOT BE MADE TO FROM HERE.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * This used to invoke the `send-push-notification` edge function, which
   * relayed to onesignal.com. OneSignal was removed from the platform on
   * 2026-08-19 and replaced with self-hosted VAPID web push, so every call
   * since that date has delivered nothing — while returning through a
   * `console.debug` and a `false` that no call site checks. Eight of them
   * (cashout, credit requests, disputes, settlements, tournament auto-seat)
   * believe they notify people and do not.
   *
   * WHY IT IS NOT SIMPLY REPOINTED. Two independent reasons, and both matter:
   *
   *   1. The edge function performed no authorisation on WHO may be notified,
   *      so any authenticated user could push an arbitrary title, message and
   *      url to arbitrary user ids. Today that is inert because the vendor is
   *      gone. Wiring it to a working transport would turn a dead relay into a
   *      live spam and phishing vector — precisely the hole World Hub closed
   *      in pages/api/notifications/send.js on 2026-07-25.
   *
   *   2. There is no client-writable transport to point it at. Verified
   *      against production on 2026-08-29: `notifications` has RLS on with a
   *      single INSERT policy, `service_role` only, and `push_outbox` grants
   *      the browser nothing at all. A push is raised by inserting a
   *      `notifications` row; `trg_mirror_notification_to_push_outbox` mirrors
   *      it into `push_outbox`, and /api/cron/push-dispatch drains that with
   *      the consent gate applied. All of it is server-side, by design.
   *
   * So the fix for each call site is to raise the notification from the
   * trusted context that already performs the action — the RPC or trigger on
   * the underlying table — not from the browser afterwards. Tracked in #1498.
   *
   * WHAT CHANGED HERE (2026-08-29): this used to warn ONCE per session at
   * console.warn and quietly run a `filterByPreferences` query first — a DB
   * round trip to decide who to send nothing to. Now every dropped
   * notification is reported, with its category, so the flows that are
   * silently not notifying anybody are visible in monitoring instead of
   * depending on somebody reading a console on the right screen.
   */
  async sendToUsers(userIds: string[], payload: PushNotificationPayload): Promise<boolean> {
    reportError(
      new Error(
        `PushNotificationService is retired and delivered nothing: ` +
          `category="${payload.category}" title="${payload.title}" ` +
          `recipients=${userIds.length}. This flow must raise its notification ` +
          `server-side (insert into notifications, which mirrors to push_outbox). ` +
          `See issue #1498.`
      ),
      'PushNotificationService.Retired_send_dropped'
    );
    return false;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // CONVENIENCE METHODS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Notify user that a table seat is available
   */
  async notifyTableAvailable(userId: string, tableName: string, tableId: string): Promise<boolean> {
    return this.sendToUser(userId, {
      title: 'Seat Available!',
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
      title: 'Tournament Starting Soon!',
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
        ? `You won ${tournamentName}! Prize: ${prize.toLocaleString()} chips`
        : `You finished ${position}${this.ordinal(position)} in ${tournamentName}${prize > 0 ? ` - ${prize.toLocaleString()} chips` : ''}`;

    return this.sendToUser(userId, {
      title: position === 1 ? 'Tournament Victory!' : 'Tournament Complete',
      message,
      category: 'tournament_result',
    });
  }

  /**
   * Notify user of achievement unlock
   */
  async notifyAchievement(userId: string, achievementName: string): Promise<boolean> {
    return this.sendToUser(userId, {
      title: 'Achievement Unlocked!',
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
      title: 'Friend Request',
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
      title: `${clubName}`,
      message: announcement.substring(0, 100) + (announcement.length > 100 ? '...' : ''),
      category: 'club_announcement',
    });
  }

  /**
   * Notify user of settlement/payout
   */
  async notifySettlement(userId: string, amount: number, periodLabel: string): Promise<boolean> {
    return this.sendToUser(userId, {
      title: 'Payout Received!',
      message: `${amount.toLocaleString()} chips credited for ${periodLabel}`,
      category: 'settlement',
      url: '/wallet',
    });
  }

  /**
   * Notify user it's their turn to act (when app is backgrounded)
   */
  async notifyYourTurn(userId: string, tableName: string, tableId: string): Promise<boolean> {
    return this.sendToUser(userId, {
      title: 'Your Turn!',
      message: `It's your turn to act at ${tableName}`,
      category: 'table_available',
      url: `/table/${tableId}`,
      data: { tableId, action: 'your_turn' },
    });
  }

  /**
   * Dan 2026-08-21 (item 4): "if a player is LIVE IN A TOURNAMENT and getting
   * blinded off, push notifications should be sent to the phone as well as a
   * pop up for the player to TAKE THEIR SEAT."
   *
   * This is the phone half. Filed under `tournament_start` rather than
   * `table_available` on purpose: a player who has muted table-availability
   * chatter has not consented to being blinded out of a tournament they paid
   * to enter, and this is the same class of alert as "your tournament is
   * starting" — money already committed, seat already yours.
   *
   * `url` deep-links straight at the table so tapping the notification IS
   * taking the seat.
   */
  /**
   * REMOVED 2026-08-30 (#1498). The last live caller was TournamentAutoSeat,
   * and it is now handled by trg_notify_blinding_off on table_seats: the engine
   * flags is_sitting_out / is_away on a live tournament seat, the trigger raises
   * the notification, and the mirror sends the push.
   *
   * Server-side is not merely tidier here, it is the only version that works.
   * Somebody being blinded off is by definition not looking at the app, and a
   * push that only fires while a React component is mounted is the one that
   * matters least.
   */

  /**
   * Notify user that a club game is starting / has open seats
   */
  async notifyClubGameStarting(
    userIds: string[],
    clubName: string,
    tableName: string,
    tableId: string
  ): Promise<boolean> {
    return this.sendToUsers(userIds, {
      title: `${clubName} - Game Starting`,
      message: `${tableName} has open seats. Join now!`,
      category: 'table_available',
      url: `/table/${tableId}`,
      data: { tableId, clubName },
    });
  }

  /**
   * Notify user of a new direct message
   */
  async notifyNewMessage(
    userId: string,
    fromUsername: string,
    messagePreview: string
  ): Promise<boolean> {
    return this.sendToUser(userId, {
      title: `Message From ${fromUsername}`,
      message: messagePreview.substring(0, 80) + (messagePreview.length > 80 ? '...' : ''),
      category: 'general',
      url: '/messages',
    });
  }

  /**
   * Notify user of a daily login reward ready to claim
   */
  async notifyDailyReward(userId: string, streak: number): Promise<boolean> {
    return this.sendToUser(userId, {
      title: 'Daily Reward Ready!',
      message: `Day ${streak} streak - claim your bonus now`,
      category: 'general',
      url: '/bonus',
    });
  }

  /**
   * Notify user of a notable hand (bad beat, huge pot, etc.)
   */
  async notifyNotableHand(userId: string, description: string, tableId: string): Promise<boolean> {
    return this.sendToUser(userId, {
      title: 'Notable Hand!',
      message: description,
      category: 'general',
      url: `/table/${tableId}`,
      data: { tableId },
    });
  }

  /**
   * Notify user of waitlist position ready (push, not just in-app)
   */
  async notifyWaitlistReady(
    userId: string,
    tableName: string,
    tableId: string,
    position: number
  ): Promise<boolean> {
    return this.sendToUser(userId, {
      title: 'Seat Available!',
      message: `You're #${position} - a seat opened at ${tableName}`,
      category: 'table_available',
      url: `/table/${tableId}`,
      data: { tableId, waitlistPosition: position },
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
