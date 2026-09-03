/**
 * NOTIFICATIONS OVERLAY — the full-screen popup
 * ═══════════════════════════════════════════════════════════════════════
 * Dan, 2026-09-02, verbatim: "WHEN YOU CLICK ON NOTIFICATIONS, IT SHOULDN'T
 * OPEN TO ITS OWN PAGE, IT SHOULD CREATE A 'FULL SCREEN POP UP' SO YOU STAY ON
 * THE PAGE YOU WERE ON, AND NOT REDIRECT TO A WHOLE PAGE FOR NOTIFICATIONS.
 * YOU SHOULD BE ABLE TO 'X' OFF THE NOTIFICATIONS POP UP AND STAY ON THE SAME
 * PAGE YOU WERE ON STILL."
 *
 * Mounted once, by AppLayout. Opened by anything that calls the store. It
 * renders `NotificationsSurface` — the same component the `/notifications`
 * route renders — so there is still exactly one notifications display.
 *
 * WHAT "STAY ON THE PAGE YOU WERE ON" REQUIRES, AND WHY EACH PIECE IS HERE
 * ───────────────────────────────────────────────────────────────────────
 *  * NO NAVIGATION. Opening pushes no history entry and changes no URL. The
 *    page underneath is not unmounted, so its sockets, timers, scroll position
 *    and in-flight state are all still there when the popup closes. That is
 *    the whole point, and it is why this is not `navigate('/notifications')`
 *    with a modal skin.
 *  * A PORTAL. Rendered into document.body rather than into the page, so no
 *    ancestor's `transform`, `overflow` or stacking context can clip it or
 *    trap it below sibling chrome.
 *  * SCROLL LOCK. The body cannot scroll behind the popup, so dismissing it
 *    returns the player to the scroll position they left.
 *  * ESCAPE, THE X, AND THE BACKDROP all close. Three affordances for one
 *    action because this covers the global header, including its Back button.
 *  * A FOCUS TRAP, with focus restored to the bell on close. A full-screen
 *    surface that leaks Tab focus to the page behind it is unusable with a
 *    keyboard and invisible to the person it fails.
 *
 * IT MUST NEVER BECOME AN IFRAME. CLAUDE.md section 1.3 forbids iframe code in
 * Club Arena, and the notifications route was rewritten away from one on
 * 2026-08-27 precisely because framing `/hub/notifications` booted a second
 * application — second document, second hydration, second Supabase client,
 * second auth read — before the feed request could even start. The World Hub's
 * FullScreenPageOverlay does frame a page and that is correct THERE. Do not
 * "unify" the two by bringing the iframe here.
 */

import { useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { useNotificationsOverlayStore } from '../../stores/useNotificationsOverlayStore';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import NotificationsSurface from './NotificationsSurface';
import './NotificationsOverlay.css';

export default function NotificationsOverlay() {
  const isOpen = useNotificationsOverlayStore((s) => s.isOpen);
  const openedFrom = useNotificationsOverlayStore((s) => s.openedFrom);
  const close = useNotificationsOverlayStore((s) => s.closeNotifications);
  const location = useLocation();

  const panelRef = useFocusTrap<HTMLDivElement>(isOpen);

  /**
   * A route change while the popup is open can only have come from somewhere
   * other than this surface (the surface closes itself before it navigates —
   * see NotificationsSurface.leaveTo). Either way the popup has outlived the
   * page it was opened over, so it goes.
   */
  useEffect(() => {
    if (isOpen) close();
    // Deliberately keyed on the path alone: this is "the page changed", not
    // "the open flag changed". Including `isOpen` would close it on the very
    // render that opened it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  /** Escape closes, matching every other dismissible surface in the app. */
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen, close]);

  /**
   * Scroll lock. The previous inline value is restored rather than blanked,
   * so a page that had deliberately locked its own scroll (a table, a modal
   * already open beneath) is handed back exactly what it set.
   */
  useEffect(() => {
    if (!isOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [isOpen]);

  const handleBackdrop = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      // Only a click on the backdrop itself. A click that started inside the
      // list and drifted onto the edge is not a dismissal.
      if (event.target === event.currentTarget) close();
    },
    [close]
  );

  // Unmounted while closed, not merely hidden: the surface holds a realtime
  // subscription and a feed poll, and neither should run for a popup nobody
  // opened. It also keeps the channel name free for the `/notifications`
  // route, which uses the same one.
  if (!isOpen) return null;

  return createPortal(
    <div
      className="ca-notif-overlay"
      role="presentation"
      data-opened-from={openedFrom || undefined}
      onMouseDown={handleBackdrop}
    >
      <div
        ref={panelRef}
        className="ca-notif-overlay__panel"
        role="dialog"
        aria-modal="true"
        aria-label="Notifications"
      >
        <button
          type="button"
          className="ca-notif-overlay__close"
          onClick={close}
          title="Close Notifications"
          aria-label="Close Notifications"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>

        <div className="ca-notif-overlay__scroll">
          <NotificationsSurface variant="overlay" onRequestClose={close} />
        </div>
      </div>
    </div>,
    document.body
  );
}
