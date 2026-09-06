/**
 * MOBILE FIT AUDIT — Dan 2026-08-22: "the mobile layout needs to use the same
 * type of mobile layout as the social media pages, where everything shrinks
 * down and fits into one screen."
 *
 * The measurable half of that instruction: at phone width, NO route may
 * scroll horizontally, and no element may extend past the viewport's right
 * edge. This spec walks every static route in App.tsx at 375x812 (signed in
 * via global-setup when SP_EMAIL/SP_PASS are present) and reports every
 * violation with the offending elements' selectors and widths.
 *
 * Run in AUDIT mode (default locally): logs a JSON report, never fails —
 * used to build the fix list. STRICT mode (MOBILE_FIT_STRICT=1, or CI where
 * this suite runs against production AFTER a deploy) fails on any violation.
 * Post-deploy CI is the right place for strict: a red run names the route
 * and the offending element without blocking anyone's merge.
 */
import { test, expect } from '@playwright/test';
import { evaluateAcrossDocumentReplacement } from './support/evaluateAcrossDocumentReplacement';

const ROUTES = [
  '',
  'achievements',
  'agent-dashboard',
  'agent-management',
  'agent-portal',
  'analytics',
  'anti-cheat',
  'bonuses',
  'cashier',
  'challenges',
  'clubs',
  'clubs-list',
  'clubs/create',
  'data',
  'disputes',
  'financial-alerts',
  'financial-health',
  'flash-pool',
  'friends',
  'hand-history',
  'hands',
  'help',
  'history',
  'invite',
  'leaderboard',
  'legal/fair-gaming',
  'legal/privacy',
  'legal/promotions',
  'legal/tos',
  'marketplace',
  'messages',
  'messages/clubs',
  'messages/new',
  'notification-center',
  'notifications',
  'player-sessions',
  'players',
  'profile',
  'promotions',
  'rakeback',
  'rakeback-dashboard',
  'search',
  'session-history',
  'settings',
  'settlement-history',
  'stats',
  'tournament-lobby',
  'tournament-results',
  'tournaments',
  'transactions',
  'union-dashboard',
  'union-games',
  'unions',
  'unions/create',
  'vip',
  'waitlist',
  'wallet',
  'xmtt',
];

/* Club-scoped routes are the app's biggest surface (26 subpages). They need a
   real club id; pass one via AUDIT_CLUB_ID (use a club the signed-in test
   account OWNS, so the staff dashboards actually render). */
const CLUB_SUBROUTES = [
  '',
  'agent-dashboard',
  'agents',
  'announcements',
  'blacklist',
  'cashier',
  'create-table',
  'dashboard',
  'dashboard-full',
  'data',
  'disputes',
  'financials',
  'jackpot',
  'lobby',
  'members',
  'messages',
  'promotions',
  'reports',
  'rules',
  'settings',
  'settlement',
  'table-creation',
  'tournaments',
];

/* DEFAULTED 2026-08-23. AUDIT_CLUB_ID appears in no workflow, so in CI this
   list was always empty and the club surface - 23 subpages including the
   lobby, the densest horizontal screen in the app - was never measured at
   375px by the gate written to measure exactly that. The Lobby V2 table was
   scrolling ~225px sideways on a phone and this spec could not see it.

   The fallback is the same club the club-lobby spec uses, so both specs point
   at one known-good club; override with AUDIT_CLUB_ID for a club the signed-in
   account OWNS if you want the staff dashboards to render too. */
const clubId = process.env.AUDIT_CLUB_ID || 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
for (const sub of CLUB_SUBROUTES) {
  ROUTES.push(`clubs/${clubId}${sub ? '/' + sub : ''}`);
}

const STRICT = Boolean(process.env.MOBILE_FIT_STRICT || process.env.CI);

test.describe('Club Arena Mobile Fit At 375px', () => {
  /* One test used to walk all 81 routes serially. Production run 34024252195
     proved why that shape cannot certify anything: 173 other checks passed,
     then this single test hit its 18.2-minute cap and discarded the completed
     route verdicts. Independent cases retain every verdict, identify the exact
     route that failed, and let the configured workers share the read-only scan. */
  for (const route of ROUTES) {
    test(`${route || 'home'} has no horizontal page overflow`, async ({ page }) => {
      test.setTimeout(30_000);
      await page.setViewportSize({ width: 375, height: 812 });

      /* A route that redirects the moment it mounts (a guard bouncing you to a
       club, /auth, or a default tab) ABORTS the in-flight navigation, and
       page.goto rejects with net::ERR_ABORTED. That is not a layout defect
       and it is not a broken route — it is the SPA doing its job, and the
       page that replaced it is the one worth measuring. The first CI run of
       this spec died on exactly that at /agent-management, throwing away a
       sweep that had found zero violations in every route before it.

       So: never let navigation failure end the sweep. Wait for whatever did
       land and measure that; only record a route as unreachable if the page
       is left with nothing to measure. */
      try {
        await page.goto(route === '' ? '.' : route, { waitUntil: 'domcontentloaded' });
      } catch (err) {
        const msg = String(err);
        if (!msg.includes('ERR_ABORTED')) {
          console.log('MOBILE_FIT_AUDIT ' + JSON.stringify({ route, unreachable: msg }));
          if (STRICT) {
            throw new Error(`${route || 'home'} failed to load: ${msg.split('\n')[0]}`);
          }
          return;
        }
        /* Redirected. Give the replacement route the same settle below. */
      }
      await page.waitForTimeout(2200);

      if (page.url().includes('/auth')) {
        console.log('MOBILE_FIT_AUDIT ' + JSON.stringify({ route, skipped: 'auth' }));
        test.skip(true, `${route || 'home'} requires an authenticated session`);
        return;
      }

      const result = await evaluateAcrossDocumentReplacement(page, () => {
        const vw = window.innerWidth;
        const doc = document.documentElement;
        const overflow = doc.scrollWidth - vw;

        // Name the widest offenders: elements that extend past the right edge
        // (or start left of the left edge) by more than 2px. Skip elements that
        // are inside an overflow-x container that itself fits — those scroll
        // deliberately (tables, card rails).
        const offenders: Array<{ sel: string; left: number; right: number; w: number }> = [];
        if (overflow > 2) {
          const fitsInScroller = (el: Element): boolean => {
            let p = el.parentElement;
            while (p && p !== document.body) {
              const s = getComputedStyle(p);
              if (
                (s.overflowX === 'auto' || s.overflowX === 'scroll' || s.overflowX === 'hidden') &&
                p.getBoundingClientRect().right <= vw + 2
              ) {
                return true;
              }
              p = p.parentElement;
            }
            return false;
          };
          const selectorFor = (el: Element): string => {
            const id = (el as HTMLElement).id;
            if (id) return `#${id}`;
            const cls = Array.from(el.classList).slice(0, 2).join('.');
            return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}`;
          };
          const all = document.querySelectorAll('body *');
          for (const el of all) {
            const r = el.getBoundingClientRect();
            if (r.width === 0) continue;
            /* Elements ENTIRELY left of the viewport are parked drawers
             (translateX(-100%) sidebars) — deliberately offscreen, and they
             cannot create rightward scroll. Only rightward escape counts. */
            if (r.right <= 2) continue;
            if (r.right > vw + 2 && !fitsInScroller(el)) {
              offenders.push({
                sel: selectorFor(el),
                left: Math.round(r.left),
                right: Math.round(r.right),
                w: Math.round(r.width),
              });
              if (offenders.length >= 8) break;
            }
          }
        }
        return { scrollWidth: doc.scrollWidth, vw, overflow, offenders };
      });

      const violation =
        result.overflow > 2
          ? {
              route,
              scrollWidth: result.scrollWidth,
              viewport: result.vw,
              offenders: result.offenders,
            }
          : null;

      console.log(
        'MOBILE_FIT_AUDIT ' + JSON.stringify({ route, violation, routesChecked: 1 }, null, 1)
      );

      if (STRICT) {
        expect(
          violation,
          `${route || 'home'} is ${result.scrollWidth}px wide at ${result.vw}px ` +
            `(${result.offenders[0]?.sel ?? 'unknown offender'})`
        ).toBeNull();
      }
    });
  }
});
