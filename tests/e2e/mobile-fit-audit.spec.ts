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

interface Violation {
  route: string;
  scrollWidth: number;
  viewport: number;
  offenders: Array<{ sel: string; left: number; right: number; w: number }>;
}

test('no Club Arena route scrolls horizontally at 375px', async ({ page }) => {
  /* Budget per route, not a flat cap. The 58 static routes finish in about
     six minutes, but AUDIT_CLUB_ID adds 23 club dashboards — the heaviest
     pages in the app. Production run 34024252195 reached the final checks
     with 173 tests green, then this sweep hit the old 12s-per-route ceiling
     while the deployment host was busy. 15s each plus two minutes of slack
     scales with the route list and remains inside the workflow's 42m cap. */
  test.setTimeout(ROUTES.length * 15_000 + 120_000);
  await page.setViewportSize({ width: 375, height: 812 });

  const violations: Violation[] = [];
  const skipped: string[] = [];
  const unreachable: string[] = [];

  for (const route of ROUTES) {
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
        unreachable.push(`${route}: ${msg.split('\n')[0]}`);
        continue;
      }
      /* Redirected. Give the replacement route the same settle below. */
    }
    await page.waitForTimeout(2200);

    if (page.url().includes('/auth')) {
      skipped.push(route);
      continue;
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

    if (result.overflow > 2) {
      violations.push({
        route,
        scrollWidth: result.scrollWidth,
        viewport: result.vw,
        offenders: result.offenders,
      });
    }
  }

  console.log(
    'MOBILE_FIT_AUDIT ' +
      JSON.stringify({ violations, skipped, unreachable, routesChecked: ROUTES.length }, null, 1)
  );

  if (process.env.MOBILE_FIT_STRICT || process.env.CI) {
    expect(
      violations,
      `Routes with horizontal overflow at 375px:\n${violations
        .map((v) => `  ${v.route}: ${v.scrollWidth}px wide (${v.offenders[0]?.sel ?? '?'})`)
        .join('\n')}`
    ).toEqual([]);

    /* A route that could not be loaded AT ALL was not measured, and an
       unmeasured route passing silently is how a suite ends up asserting
       nothing (this repo has done that twice). Report it separately from a
       layout violation, because the fix is a different one. */
    expect(unreachable, `Routes that failed to load:\n  ${unreachable.join('\n  ')}`).toEqual([]);
  }
});
