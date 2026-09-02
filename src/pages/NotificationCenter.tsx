/**
 * NOTIFICATION CENTER — retired 2026-08-25
 * ═══════════════════════════════════════════════════════════════════════
 * This was a THIRD notification UI reading the same `public.notifications`
 * table as /notifications and the World Hub's /hub/notifications, with its
 * own layout, its own filters and its own routing rules.
 *
 * Nothing linked to it. No nav item, no button, no redirect pointed at
 * `/notification-center` — it was reachable only by typing the URL. It
 * survived purely because it compiled, and it was a standing invitation
 * for the display to fork again.
 *
 * Dan, 2026-08-25: "we need ONE DISPLAY."
 *
 * The route is kept as a redirect rather than deleted for two reasons:
 * any bookmark or old push payload pointing here still lands somewhere
 * real, and tests/e2e-page-load-audit.ts imports this module by path — a
 * deleted file there is a red CI test, which blocks the World Hub sync for
 * every agent (CLAUDE.md section 5.8).
 */

import { Navigate } from 'react-router-dom';

export default function NotificationCenter() {
  return <Navigate to="/notifications" replace />;
}
