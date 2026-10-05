/**
 * MOBILE FIT AUDIT — Dan 2026-08-22: "the mobile layout needs to use the same
 * type of mobile layout as the social media pages, where everything shrinks
 * down and fits into one screen."
 *
 * The measurable half of that instruction: at phone, tablet, and desktop
 * widths, NO route may scroll horizontally, and no element may extend past
 * the viewport's right edge. This spec loads every static route once, then
 * measures it at 375x812, 834x1194, and 1440x900 (signed in via global-setup
 * when SP_EMAIL/SP_PASS are present).
 *
 * Run in AUDIT mode (default locally): logs a JSON report, never fails —
 * used to build the fix list. STRICT mode (MOBILE_FIT_STRICT=1, or CI where
 * this suite runs against production AFTER a deploy) fails on any violation.
 * Post-deploy CI is the right place for strict: a red run names the route
 * and the offending element without blocking anyone's merge.
 */
import { test, expect } from '@playwright/test';
import { ADMIN_CLUB_OPERATION_ROUTES } from './support/clubOperationRoutes';
import { evaluateAcrossDocumentReplacement } from './support/evaluateAcrossDocumentReplacement';
import { assertRendered } from './routes/utils';

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
  'community',
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
  'legal',
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
  'play',
  'player-sessions',
  'players',
  'profile',
  'promotions',
  `rate-audit?club=${process.env.AUDIT_CLUB_ID || 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'}`,
  'rakeback',
  'rakeback-dashboard',
  'rewards',
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

/* Club-scoped routes are the app's biggest surface. The shared dependency-free
   registry is pinned to the application registry by a Vitest contract, so a
   new operator route cannot silently fall out of this responsive sweep. */
const CLUB_SUBROUTES = Array.from(
  new Set([
    '',
    'create-table',
    'dashboard',
    'cashier-classic',
    'jackpot',
    'lobby',
    'messages',
    'tournaments',
    ...ADMIN_CLUB_OPERATION_ROUTES.map(({ suffix }) => suffix),
  ])
);

/* DEFAULTED 2026-08-23. AUDIT_CLUB_ID appears in no workflow, so in CI this
   list was always empty and the club surface - 23 subpages including the
   lobby, the densest horizontal screen in the app - was never measured at
   375px by the gate written to measure exactly that. The Lobby V2 table was
   scrolling ~225px sideways on a phone and this spec could not see it.

   The production harness grants the isolated account temporary admin access
   to the reserved standalone fallback below, so every operation - including
   local Table Management - reaches its positive surface. */
const clubId =
  process.env.E2E_TEMPLATE_CLUB_ID ||
  process.env.AUDIT_CLUB_ID ||
  '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
for (const sub of CLUB_SUBROUTES) {
  ROUTES.push(`clubs/${clubId}${sub ? '/' + sub : ''}`);
}

const STRICT = Boolean(process.env.MOBILE_FIT_STRICT || process.env.CI);
const VIEWPORTS = [
  { label: 'mobile', width: 375, height: 812 },
  { label: 'tablet', width: 834, height: 1194 },
  { label: 'desktop', width: 1440, height: 900 },
] as const;

test.describe('Club Arena Responsive Fit At Mobile, Tablet, And Desktop', () => {
  /* One test used to walk all 81 routes serially. Production run 34024252195
     proved why that shape cannot certify anything: 173 other checks passed,
     then this single test hit its 18.2-minute cap and discarded the completed
     route verdicts. Independent cases retain every verdict, identify the exact
     route that failed, and let the configured workers share the read-only scan. */
  for (const route of ROUTES) {
    test(`${route || 'home'} has no horizontal page overflow at all three widths`, async ({
      page,
    }) => {
      test.setTimeout(30_000);
      await page.setViewportSize(VIEWPORTS[0]);

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

      if (/^messages(?:\/|$)/.test(route)) {
        await expect(page).toHaveURL(/\/hub\/(?:social-media\/)?messenger(?:[/?#]|$)/, {
          timeout: 15_000,
        });
      } else if (route === 'marketplace') {
        await expect(page).toHaveURL(/\/hub\/diamond-store(?:[/?#]|$)/, {
          timeout: 15_000,
        });
        return;
      } else {
        await assertRendered(page, route || 'home');
      }

      const destinationUrl = page.url();
      const violations: Array<{
        route: string;
        viewport: string;
        scrollWidth: number;
        width: number;
        offenders: Array<{ sel: string; left: number; right: number; w: number }>;
      }> = [];

      for (const viewport of VIEWPORTS) {
        await page.setViewportSize(viewport);
        expect(page.url(), `${route || 'home'} navigated while resizing to ${viewport.label}`).toBe(
          destinationUrl
        );

        const result = await evaluateAcrossDocumentReplacement(page, () => {
          const vw = window.innerWidth;
          const doc = document.documentElement;
          const overflow = doc.scrollWidth - vw;

          // Name the widest offenders: elements that extend past the right edge.
          // Skip elements inside a fitting overflow-x container because tables
          // and card rails intentionally own their horizontal scrolling.
          const offenders: Array<{ sel: string; left: number; right: number; w: number }> = [];
          if (overflow > 2) {
            const fitsInScroller = (el: Element): boolean => {
              let p = el.parentElement;
              while (p && p !== document.body) {
                const s = getComputedStyle(p);
                if (
                  (s.overflowX === 'auto' ||
                    s.overflowX === 'scroll' ||
                    s.overflowX === 'hidden') &&
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
                viewport: viewport.label,
                scrollWidth: result.scrollWidth,
                width: result.vw,
                offenders: result.offenders,
              }
            : null;
        if (violation) violations.push(violation);

        console.log(
          'MOBILE_FIT_AUDIT ' +
            JSON.stringify({
              route,
              destinationUrl,
              viewport: viewport.label,
              violation,
              routesChecked: 1,
            })
        );
      }

      if (STRICT) {
        expect(
          violations,
          `${route || 'home'} overflowed after one load: ${JSON.stringify(violations)}`
        ).toEqual([]);
      }
    });
  }
});
