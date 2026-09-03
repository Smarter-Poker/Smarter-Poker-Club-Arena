/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  NOTIFICATIONS OPEN AS A POPUP (Dan, 2026-09-02, BINDING)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim: "WHEN YOU CLICK ON NOTIFICATIONS, IT SHOULDN'T OPEN TO ITS OWN
 * PAGE, IT SHOULD CREATE A 'FULL SCREEN POP UP' SO YOU STAY ON THE PAGE YOU
 * WERE ON, AND NOT REDIRECT TO A WHOLE PAGE FOR NOTIFICATIONS. YOU SHOULD BE
 * ABLE TO 'X' OFF THE NOTIFICATIONS POP UP AND STAY ON THE SAME PAGE YOU WERE
 * ON STILL. THIS SHOULD WORK LIKE THIS INSIDE THE WORLD HUB, CLUB ARENA AND
 * CLUB COMMANDER PAGES."
 *
 * WHY THIS IS A LAW AND NOT JUST A COMMIT
 * ───────────────────────────────────────────────────────────────────────────
 * The World Hub had ALREADY built this popup, months before the request. Its
 * bell called `openOverlay('notifications')` and its notifications page already
 * hid its own chrome when framed. It still reached Dan as a bug, because the
 * open flag was a `useState` inside one header component: every OTHER door —
 * the bottom nav, four hamburger entries, Commander's profile menu — kept
 * navigating. Nobody reverted anything. The behaviour simply never spread from
 * the control it was written on, and a half-applied rule looks identical to no
 * rule at all from the player's side.
 *
 * So the failure mode this law guards is not "somebody puts it back". It is
 * "somebody adds the NEXT notifications trigger and wires it the old way",
 * which is the way every example in the codebase looked until today. Each pin
 * below is a door that was, in fact, navigating on 2026-09-02.
 *
 * WHAT IS DELIBERATELY NOT PINNED
 * ───────────────────────────────────────────────────────────────────────────
 *   * The `/notifications` ROUTE. It stays, and deleting it would break push
 *     deep links, bookmarks, cmd-click on the bell, and
 *     `everyRouteIsReachableLaw`. The popup is an extra door, not a
 *     replacement for the address. `NotificationsPage` rendering the surface
 *     directly is pinned BECAUSE of that — a route that redirects into a popup
 *     is a dead link to everything above.
 *   * The <Link>/anchor shape of the triggers. They must stay anchors so a
 *     modified click still opens a new tab, which is why every interceptor
 *     tests the modifier keys before calling preventDefault.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

/** Blank comment bodies so a pin cannot be satisfied — or tripped — by prose. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, (m, p1) => p1 + ''.padEnd(m.length - p1.length, ' '));
}

const OVERLAY_STORE = 'src/stores/useNotificationsOverlayStore.ts';
const OVERLAY = 'src/components/notifications/NotificationsOverlay.tsx';
const SURFACE = 'src/components/notifications/NotificationsSurface.tsx';

describe('notifications open as a popup, not as a page', () => {
  it('there is exactly one overlay, mounted by the layout that every route shares', () => {
    expect(existsSync(join(ROOT, OVERLAY))).toBe(true);
    const layout = code(read('src/components/layouts/AppLayout.tsx'));
    expect(layout).toContain('NotificationsOverlay');
    // AppLayout wraps every authenticated route, INCLUDING table and tournament
    // play pages where the global header is hidden. A player at a table is
    // exactly who needs to read a seat call without leaving the hand, so the
    // overlay must not be owned by the header.
    expect(layout).toMatch(
      /lazy\(\s*\(\)\s*=>\s*import\('\.\.\/notifications\/NotificationsOverlay'\)/
    );
  });

  it('the popup renders the SAME surface the route renders', () => {
    // "ONE DISPLAY" (Dan, 2026-08-25). The bug behind that instruction was two
    // implementations of the same list disagreeing about where a tap goes.
    expect(code(read(OVERLAY))).toContain('NotificationsSurface');
    expect(code(read('src/pages/NotificationsPage.tsx'))).toContain('NotificationsSurface');
  });

  it('the route still renders the surface directly and does not redirect into the popup', () => {
    const page = code(read('src/pages/NotificationsPage.tsx'));
    expect(page).toMatch(/variant="page"/);
    // A <Navigate> here would make the URL unresolvable, breaking push deep
    // links, bookmarks and cmd-click on the bell.
    expect(page).not.toMatch(/<Navigate\b/);
  });

  it('every trigger opens the popup instead of navigating', () => {
    const triggers: Array<[string, string]> = [
      ['src/components/navigation/GlobalHeader.tsx', 'global-header-bell'],
      ['src/components/navigation/HamburgerMenu.tsx', 'hamburger-menu'],
      ['src/components/navigation/ArenaSectionRail.tsx', 'arena-section-rail'],
      ['src/components/common/NotificationBell.tsx', 'notification-bell'],
    ];

    for (const [file, source] of triggers) {
      const src = code(read(file));
      expect(src, `${file} must open the popup`).toContain(`openNotifications('${source}')`);
      // The pin that actually matters: no door may route to the page. Each of
      // these four did on 2026-09-02.
      expect(src, `${file} must not navigate to /notifications`).not.toMatch(
        /navigate\(\s*['"`]\/notifications/
      );
      expect(src, `${file} must not hard-navigate to /notifications`).not.toMatch(
        /location\.href\s*=\s*['"`][^'"`]*\/notifications/
      );
    }
  });

  it('the popup dismisses without moving the player, and offers three ways out', () => {
    const overlay = code(read(OVERLAY));
    // "YOU SHOULD BE ABLE TO 'X' OFF ... AND STAY ON THE SAME PAGE YOU WERE ON."
    expect(overlay).toContain('Close Notifications');
    expect(overlay).toMatch(/'Escape'/);
    expect(overlay).toContain('handleBackdrop');
    // Opening must not touch history or the URL. If either appears here, the
    // page underneath is being unmounted and "stay on the page you were on" is
    // no longer true.
    expect(overlay).not.toMatch(/history\.(push|replace)State/);
    expect(overlay).not.toMatch(/\bnavigate\(/);
  });

  it('the popup restores the page it covered rather than blanking its scroll lock', () => {
    const overlay = code(read(OVERLAY));
    expect(overlay).toContain("document.body.style.overflow = 'hidden'");
    // A page that had locked its own scroll (a table, a modal already open
    // beneath) must be handed back exactly what it set, not an empty string.
    expect(overlay).toMatch(/document\.body\.style\.overflow\s*=\s*previous/);
  });

  it('the popup is not an iframe', () => {
    // CLAUDE.md section 1.3 forbids iframe code in Club Arena, and this route
    // was rewritten away from <iframe src="/hub/notifications"> on 2026-08-27
    // because framing it booted a second application before the feed request
    // could start. The World Hub's FullScreenPageOverlay does frame a page and
    // that is correct THERE. Do not unify them by bringing the iframe here.
    for (const file of [OVERLAY, SURFACE]) {
      expect(code(read(file)), `${file} must not frame a page`).not.toMatch(/<iframe\b/);
    }
  });

  it('the two surfaces do not fight over one realtime channel', () => {
    // Nothing stops a player already on /notifications from tapping the bell,
    // which mounts the overlay on top of the page: two instances, both wanting
    // a channel. Sharing one name makes the loser stop receiving inserts.
    expect(code(read(SURFACE))).toMatch(/ca-notif-\$\{variant\}:\$\{user\.id\}/);
  });

  it('the store is the only open flag, so a new door cannot invent its own', () => {
    const store = code(read(OVERLAY_STORE));
    expect(store).toContain('openNotifications');
    expect(store).toContain('closeNotifications');
    expect(store).toContain('openNotificationsOverlay');
  });

  it('the badge is acknowledged by the store, not by one control', () => {
    // This regressed once already, inside the popup work itself. The clear was
    // written out on the bell's handler, so opening the identical popup from
    // the hamburger or the rail left the bell behind it still claiming unread
    // notifications the player had just read. Invisible while those doors
    // navigated away; obvious the moment they stopped.
    expect(code(read(OVERLAY_STORE))).toContain('clearUnreadNotifications');
    for (const file of [
      'src/components/navigation/GlobalHeader.tsx',
      'src/components/navigation/HamburgerMenu.tsx',
      'src/components/navigation/ArenaSectionRail.tsx',
    ]) {
      expect(
        code(read(file)),
        `${file} must not clear the badge itself - the store does it for every door`
      ).not.toMatch(/clearUnreadNotifications\s*\(/);
    }
  });
});
