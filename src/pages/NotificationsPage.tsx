/**
 * NOTIFICATIONS — Club Arena surface
 * ═══════════════════════════════════════════════════════════════════════
 * This page used to be a second, independent notification client: its own
 * Supabase query, its own grouping, its own swipe actions, its own icon
 * set, its own routing switch. It read the SAME `public.notifications`
 * table as the World Hub's /hub/notifications, and the two had drifted
 * into different displays and — worse — different routing.
 *
 * Dan, 2026-08-25: "we need ONE DISPLAY. keep the social media display,
 * it's cleaner... and you need to enable the ability to click on the
 * notification and it direct you directly to the page it's notifying you
 * about... it currently just silently fails."
 *
 * The silent failure was structural. This page selected the `metadata`
 * column and never `data`, but nearly every producer writes `data` — so
 * `waitlist_seat_open` ("Seat Open", 1219 rows in production, zero with a
 * link column) resolved to no URL, marked itself read, and did nothing.
 *
 * Rather than fix a second copy, this route now embeds the canonical
 * display. There is exactly one notifications UI, one routing resolver
 * (World Hub src/lib/notificationRoute.js) and one read/dismiss path.
 *
 * WHY AN IFRAME AND NOT A REWRITE: Club Arena is a Vite SPA and the hub
 * page is a Next.js page in a different repo. Same origin, so the session
 * (`smarter-poker-auth` in localStorage) is shared and no auth handoff is
 * needed. The hub page already detects embedding and hides its own header
 * and bottom nav (pages/hub/notifications.js, `isInIframe`), so what
 * renders here is the list alone, inside Club Arena's chrome.
 *
 * NOTE: NotificationsPage.css is now orphaned — nothing imports it. It is
 * left on disk rather than deleted so this change carries no risk beyond
 * the render path; remove it in a follow-up sweep.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

/** Same-origin hub route. `embed=ca` tells it a Club Arena SPA is its parent. */
const EMBED_URL = '/hub/notifications?embed=ca';

/** Club Arena's router basename. Paths under it can be handled in-SPA. */
const CA_BASE = '/hub/club-arena';

export default function NotificationsPage() {
  const navigate = useNavigate();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    document.title = 'Notifications | Smarter Poker';
  }, []);

  useEffect(() => {
    /**
     * The embedded page posts here instead of setting window.top.location
     * when the destination is inside Club Arena. That keeps a seat-open tap
     * as an in-SPA route change — the table opens on the already-warm
     * client with its socket and table state intact — instead of a full
     * document reload that would tear the SPA down and rebuild it.
     * Anything outside Club Arena is a real navigation and is handled by
     * the embedded page itself.
     */
    const onMessage = (e: MessageEvent) => {
      // Same-origin only. Never act on a message from another origin.
      if (e.origin !== window.location.origin) return;
      const data = e.data as { type?: string; path?: string } | null;
      if (!data || data.type !== 'SP_NOTIF_NAVIGATE') return;

      const path = typeof data.path === 'string' ? data.path : '';
      if (!path.startsWith(CA_BASE)) return;

      // Strip the basename — react-router re-applies it.
      const inner = path.slice(CA_BASE.length) || '/';
      navigate(inner);
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [navigate]);

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        // Fill everything under the Club Arena header. dvh so the iOS
        // address bar collapsing does not leave a dead strip at the bottom.
        height: 'calc(100dvh - 56px)',
        background: '#F0F2F5',
        overflow: 'hidden',
      }}
    >
      {!loaded && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#F0F2F5',
          }}
        >
          <div
            style={{
              width: 36,
              height: 36,
              border: '3px solid rgba(24, 119, 242, 0.2)',
              borderTopColor: '#1877F2',
              borderRadius: '50%',
              animation: 'ca-notif-spin 0.8s linear infinite',
            }}
          />
          <style>{'@keyframes ca-notif-spin { to { transform: rotate(360deg); } }'}</style>
        </div>
      )}

      <iframe
        ref={iframeRef}
        src={EMBED_URL}
        title="Notifications"
        onLoad={() => setLoaded(true)}
        style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
      />
    </div>
  );
}
