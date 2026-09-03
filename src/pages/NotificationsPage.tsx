/**
 * NOTIFICATIONS — the `/notifications` route
 * ═══════════════════════════════════════════════════════════════════════
 * Dan, 2026-09-02: "WHEN YOU CLICK ON NOTIFICATIONS, IT SHOULDN'T OPEN TO ITS
 * OWN PAGE, IT SHOULD CREATE A FULL SCREEN POP UP SO YOU STAY ON THE PAGE YOU
 * WERE ON, AND NOT REDIRECT TO A WHOLE PAGE FOR NOTIFICATIONS."
 *
 * So nothing in the app CLICKS its way here any more. The bell, the hamburger
 * entry and the account rail all open `NotificationsOverlay` instead, which
 * renders the very same `NotificationsSurface` this route renders.
 *
 * THE ROUTE STAYS, AND DELETING IT WOULD BREAK REAL TRAFFIC
 * ───────────────────────────────────────────────────────────────────────
 * A popup has no address, and several things need one:
 *
 *   * push payloads and emails deep-link to /hub/club-arena/notifications;
 *   * bookmarks, and anyone who has ever pasted the URL to a teammate;
 *   * cmd-click / middle-click / "open in new tab" on the header bell, which
 *     still resolves because that control is a real anchor with a real href;
 *   * `tests/unit/everyRouteIsReachableLaw.test.ts`, which requires every
 *     route to be reachable, and `tests/e2e-page-load-audit.ts`, which imports
 *     this module by path.
 *
 * The page and the popup are therefore two doors onto one room, not two rooms.
 * If you are tempted to make this file redirect into the overlay, don't: a URL
 * that cannot render its own content is a dead link to everything above.
 */

import NotificationsSurface from '../components/notifications/NotificationsSurface';

export default function NotificationsPage() {
  return <NotificationsSurface variant="page" />;
}
