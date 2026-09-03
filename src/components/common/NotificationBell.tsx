/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  NOTIFICATION BELL — Header Badge with Unread Count (v4.0 — Persistent Store)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Displays a bell icon with unread count badge. Tapping opens the full-screen
 * notifications popup over whatever page the player is on.
 *
 * v4.0: Now a PURE RENDERER of useHeaderDataStore — no local state, no realtime
 *       channel, no Supabase fetches. All data comes from the persistent store.
 *       This eliminates the duplicate realtime channel that previously existed
 *       alongside the GlobalHeader's channel.
 *
 * v5.0 (2026-09-02): stopped navigating. Dan: "WHEN YOU CLICK ON NOTIFICATIONS,
 *       IT SHOULDN'T OPEN TO ITS OWN PAGE, IT SHOULD CREATE A 'FULL SCREEN POP
 *       UP' SO YOU STAY ON THE PAGE YOU WERE ON." Nothing renders this bell
 *       today — GlobalHeader draws its own from the approved artwork — but it
 *       is exported from components/common, so it is one import away from being
 *       mounted. Left navigating, it would have quietly reintroduced the exact
 *       behaviour this change removed, on whichever surface picked it up.
 */

import { useHeaderDataStore } from '../../stores/useHeaderDataStore';
import { useNotificationsOverlayStore } from '../../stores/useNotificationsOverlayStore';

export default function NotificationBell() {
  const openNotifications = useNotificationsOverlayStore((s) => s.openNotifications);
  const notificationCount = useHeaderDataStore((s) => s.notificationCount);

  return (
    <button
      type="button"
      onClick={() => openNotifications('notification-bell')}
      style={{
        position: 'relative',
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        padding: 6,
        fontSize: '1.2rem',
      }}
      title="Notifications"
    >
      Bell
      {notificationCount > 0 && (
        <span
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            background: '#ef4444',
            color: '#fff',
            fontSize: '0.55rem',
            fontWeight: 800,
            borderRadius: '50%',
            width: 16,
            height: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            lineHeight: 1,
          }}
        >
          {notificationCount > 9 ? '9+' : notificationCount}
        </span>
      )}
    </button>
  );
}
