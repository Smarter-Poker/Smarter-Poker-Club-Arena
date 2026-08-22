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

const clubId = process.env.AUDIT_CLUB_ID;
if (clubId) {
  for (const sub of CLUB_SUBROUTES) {
    ROUTES.push(`clubs/${clubId}${sub ? '/' + sub : ''}`);
  }
}

interface Violation {
  route: string;
  scrollWidth: number;
  viewport: number;
  offenders: Array<{ sel: string; left: number; right: number; w: number }>;
}

test('no Club Arena route scrolls horizontally at 375px', async ({ page }) => {
  test.setTimeout(15 * 60 * 1000);
  await page.setViewportSize({ width: 375, height: 812 });

  const violations: Violation[] = [];
  const skipped: string[] = [];

  for (const route of ROUTES) {
    await page.goto(route === '' ? '.' : route);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2200);

    if (page.url().includes('/auth')) {
      skipped.push(route);
      continue;
    }

    const result = await page.evaluate(() => {
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
      JSON.stringify({ violations, skipped, routesChecked: ROUTES.length }, null, 1)
  );

  if (process.env.MOBILE_FIT_STRICT || process.env.CI) {
    expect(
      violations,
      `Routes with horizontal overflow at 375px:\n${violations
        .map((v) => `  ${v.route}: ${v.scrollWidth}px wide (${v.offenders[0]?.sel ?? '?'})`)
        .join('\n')}`
    ).toEqual([]);
  }
});
