/**
 * AN OLD BOOKMARK LANDS SOMEWHERE TRUE (Diamond Phase 11, line 7).
 *
 * "Test old bookmarks ...": every URL the Diamond Arena has ever had must land
 * on the current arena page (or the sign-in door that carries it back there),
 * or on a clear not-found - never a dead screen, never a chip screen for a
 * Diamond id, never an alias the programme says must not exist ("No
 * compatibility route for the old standalone Diamond Arena is required").
 *
 * The inventory, from the Phase 2 legacy audit and Phase 5 (World Hub PR 1701,
 * 606a789e): the standalone arena was six World Hub pages, /hub/diamond-arena
 * and its history, leaderboard, schedule, stats and table-settings pages,
 * around an iframe of https://diamond.smarter.poker. Club Arena never had a
 * standalone Diamond route of its own (App.tsx history, 190 commits); its
 * Diamond URLs are the arena club by slug and by id, its invite, its doors,
 * the Diamond tables, Stats, the Staff Desk and the wallet.
 *
 * Runs signed out, as ci.yml's daily live-e2e runs every spec here against
 * production with no credentials. Signed out, today's arena URLs must reach
 * the World Hub sign-in door WITH the route, so the selection survives the
 * door. The World Hub cells need the World Hub, so against a local server they
 * say so and skip.
 */
import { expect, test, type Page } from '@playwright/test';

const DIAMOND_ID = '002c2d27-9584-4e52-835a-bb2be148fc81';
/* A Diamond cash table read from production on 2026-09-30. Signed out, the
   sign-in door is reached before any table is loaded, so this holds even if
   the table is later closed. */
const DIAMOND_TABLE = '415fd455-e37c-4b02-8c1d-586c246d6743';

const RETIRED_WORLD_HUB_PAGES = [
  '/hub/diamond-arena',
  '/hub/diamond-arena/history',
  '/hub/diamond-arena/leaderboard',
  '/hub/diamond-arena/schedule',
  '/hub/diamond-arena/stats',
  '/hub/diamond-arena/table-settings',
];
const ALIASES_THAT_MUST_NOT_EXIST = [
  '/hub/Diamond-Arena',
  '/hub/DIAMOND-ARENA',
  '/diamond-arena',
  '/hub/diamond',
  '/hub/diamonds',
  '/diamonds',
];
const RETIRED_IFRAME_ORIGIN = 'https://diamond.smarter.poker/';

/** Relative to /hub/club-arena/: the arena as it is today, and its older doors. */
const ARENA_ROUTES = [
  'clubs/diamond-arena',
  'clubs/diamond-arena/lobby',
  'clubs/diamond-arena/tournaments',
  'clubs/diamond-arena/members',
  `clubs/${DIAMOND_ID}`,
  `clubs/${DIAMOND_ID}/finance`,
  `clubs/${DIAMOND_ID}/agents`,
  'invite/diamond-arena',
  `table/${DIAMOND_TABLE}`,
  'stats',
  'diamond-staff-desk',
  'wallet',
];

function onProduction(baseURL: string | undefined): boolean {
  return !!baseURL && new URL(baseURL).hostname === 'smarter.poker';
}
const origin = (baseURL: string) => new URL(baseURL).origin;

/** Where a signed-out visit comes to rest: the sign-in door, or the page itself. */
async function settle(page: Page): Promise<URL> {
  await expect
    .poll(
      async () => {
        const url = new URL(page.url());
        if (url.pathname.startsWith('/auth/')) return 'door';
        const painted = await page
          .evaluate(() => (document.body?.innerText || '').trim().length > 0)
          .catch(() => false);
        return painted ? 'painted' : 'waiting';
      },
      { timeout: 30_000 }
    )
    .not.toBe('waiting');
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  return new URL(page.url());
}

test.describe('the retired standalone Diamond Arena is a clear not-found', () => {
  test('its six World Hub pages answer 404 and redirect nowhere', async ({ request, baseURL }) => {
    test.skip(!onProduction(baseURL), 'the World Hub serves these pages; this run is not on it');
    for (const path of RETIRED_WORLD_HUB_PAGES) {
      const res = await request.get(origin(baseURL!) + path, { maxRedirects: 0 });
      expect(res.status(), path).toBe(404);
      expect(res.headers()['location'], path).toBeUndefined();
      expect(await res.text(), path).not.toContain('diamond.smarter.poker');
    }
    /* The slash form is canonicalised onto the same 404, not into the arena. */
    const slash = await request.get(origin(baseURL!) + '/hub/diamond-arena/', { maxRedirects: 0 });
    expect(slash.status()).toBe(308);
    expect(new URL(slash.headers()['location'], origin(baseURL!)).pathname).toBe(
      '/hub/diamond-arena'
    );
  });

  test('no alias for it exists anywhere on the site', async ({ request, baseURL }) => {
    test.skip(!onProduction(baseURL), 'the World Hub serves these paths; this run is not on it');
    for (const path of ALIASES_THAT_MUST_NOT_EXIST) {
      const res = await request.get(origin(baseURL!) + path, { maxRedirects: 0 });
      expect(res.status(), path).toBe(404);
    }
  });

  test('its old iframe origin serves nothing', async ({ request, baseURL }) => {
    test.skip(!onProduction(baseURL), 'a production-only hostname; this run is not on production');
    /* 404 today (the host has no deployment). A hostname removed outright is
       an even clearer answer; any 2xx or 3xx would be the old arena. */
    const status = await request
      .get(RETIRED_IFRAME_ORIGIN, { maxRedirects: 0, timeout: 20_000 })
      .then((r) => r.status())
      .catch(() => 'unresolved' as const);
    if (status !== 'unresolved') expect(status).toBeGreaterThanOrEqual(400);
  });

  test('a browser that opens the old bookmark sees a not-found page, not the old arena', async ({
    page,
    baseURL,
  }) => {
    test.skip(!onProduction(baseURL), 'the World Hub serves this page; this run is not on it');
    const res = await page.goto(origin(baseURL!) + '/hub/diamond-arena');
    expect(res?.status()).toBe(404);
    await expect(page.locator('body')).toContainText('404');
    await expect(page.locator('iframe[src*="diamond.smarter.poker"]')).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe('/hub/diamond-arena');
  });
});

test.describe('inside the app, a Diamond URL lands on the arena or its sign-in door', () => {
  test('a guessed alias is the app’s own not-found, not the arena', async ({ page }) => {
    await page.goto('diamond-arena');
    await expect(page.getByText('This Arena Door Is Closed')).toBeVisible({ timeout: 30_000 });
    expect(new URL(page.url()).pathname).toBe('/hub/club-arena/diamond-arena');
  });

  for (const route of ARENA_ROUTES) {
    test(`${route} carries itself through the sign-in door`, async ({ page }) => {
      await page.goto(route);
      const url = await settle(page);
      if (url.pathname.startsWith('/auth/')) {
        /* Signed out: the door, with the route, so the arena is not lost. */
        const back = url.searchParams.get('redirect') ?? url.searchParams.get('next') ?? '';
        /* The bare Diamond id is canonicalised to the arena's slug before the
           door (measured on production 2026-09-30); either names the arena. */
        const exact = `/hub/club-arena/${route}`;
        expect([exact, exact.replace(DIAMOND_ID, 'diamond-arena')], url.href).toContain(
          decodeURIComponent(back)
        );
        return;
      }
      /* Signed in (a local run with a session): on the route, and not the
         app's not-found. */
      expect(url.pathname.startsWith('/hub/club-arena/'), url.href).toBe(true);
      await expect(page.locator('body')).not.toContainText('Route Not Found');
    });
  }
});
