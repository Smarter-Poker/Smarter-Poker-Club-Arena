/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  E2E: THE RAIL ASKS THE SERVER ONCE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The unit suite proves the wrapper calls `fn_get_ticker_feed` and the source
 * pins prove the migration says what the TypeScript thinks it says. Neither can
 * prove the thing that actually broke, which is what a REAL browser sends over
 * the wire on a real page.
 *
 * That gap is not theoretical in this suite's history: 80 specs here once ran
 * green against a 404 page because every assertion was `expect(body).toBeVisible()`.
 * So this spec asserts on TRAFFIC, which a 404 page cannot fake.
 *
 * WHAT IT PINS
 *
 *   1. The five-query signature is gone. Until 2026-09-14 the ticker sent, every
 *      thirty seconds, a `tournaments` read filtered by an inline club-id list -
 *      `club_id=in.(...)` - plus a 200-row `tournament_players` read. That URL
 *      shape is the fingerprint of the old path. If it reappears, the feed has
 *      been bypassed and 1,322-row sweeps are back.
 *
 *   2. The club-id list does not travel. Scope is derived from auth.uid() inside
 *      the function now. A request carrying a membership list up the wire means
 *      the browser is deciding its own scope again.
 *
 *   3. When a rail is on screen, the feed is what put it there.
 *
 * Unauthenticated, only the negatives are checkable - and they are the ones that
 * matter, because a regression here is silent and expensive.
 */

import { test, expect, type Request } from '@playwright/test';
import { assertRendered } from './routes/utils';

/* `assertRendered` asserts on the CURRENT page - it does not navigate. Every
   other caller in this suite goes to the route first, and the two that did not
   were how 80 specs once ran green against a blank page. Relative, because
   `baseURL` already carries /hub/club-arena/ (see playwright.config.ts). */
const ARENA = './';

/**
 * Go to the arena, and say honestly whether there is an app to look at.
 *
 * Signed out, this route renders an EMPTY `#root` - not the /auth redirect
 * `assertRendered` knows how to skip on - so the helper times out with "the app
 * mounted but rendered nothing", which is a confusing way to say "no session".
 * Every claim in this file is about the ticker, and a page with no app has no
 * ticker, so a signed-out run must SKIP rather than fail. That is the
 * convention 47 route specs in this suite already follow, and global-setup
 * writes an empty storageState when SP_EMAIL/SP_PASS are absent precisely so
 * they can.
 */
async function openArena(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(ARENA, { waitUntil: 'domcontentloaded' });

  /* SETTLE FIRST. Signed out, the arena boots - `#root` really does get
     children, measured - and then bounces to a sign-in surface that has no
     `#root` at all. Asserting immediately catches the app mid-redirect and
     reports "the SPA never mounted", which is the opposite of what happened.
     Every other spec in this suite waits before it asserts (smoke.spec.ts 3s,
     routes/admin.spec.ts 4s) and this is why. */
  await page.waitForTimeout(4_000);

  const mounted = await page
    .locator('#root > *')
    .first()
    .waitFor({ state: 'attached', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);

  /* Every claim in this file is about the ticker, and a page with no app has no
     ticker, so a signed-out run SKIPS rather than fails - the convention 47
     route specs here already follow. global-setup writes an empty storageState
     when SP_EMAIL/SP_PASS are absent precisely so they can. */
  test.skip(!mounted, `no signed-in session at ${page.url()}: nothing to measure`);
  await assertRendered(page, ARENA);
}

/** The old path's fingerprint: a REST read of `tournaments` scoped by a list. */
const OLD_SWEEP = /\/rest\/v1\/tournaments\?[^\s]*club_id=in\./;
/** The old registration read: 200 rows of tournament_players, per poll. */
const OLD_REGISTRATIONS = /\/rest\/v1\/tournament_players\?/;
/** The one call that replaced them. */
const FEED_RPC = /\/rest\/v1\/rpc\/fn_get_ticker_feed/;

test.describe('the ticker reads the server once', () => {
  test('sends no five-query sweep, and no club-id list', async ({ page }) => {
    /* The default test timeout is THIRTY seconds and the bar's poll interval is
       thirty, so this spec cannot make its point inside the default: it has to
       sit through a tick. Raised here rather than globally - nothing else in
       this suite needs it. */
    test.setTimeout(120_000);

    const seen: string[] = [];
    const bodies: string[] = [];
    const record = (request: Request) => {
      seen.push(request.url());
      if (request.method() === 'POST') bodies.push(request.postData() ?? '');
    };
    /* Attached BEFORE the navigation, or the first read - the one the bar makes
       on mount, which is the interesting one - is never seen. */
    page.on('request', record);

    await openArena(page);

    /* One paint does not prove a poll TICK is clean. Sit through longer than
       the interval so at least one refresh is in the sample. */
    await page.waitForTimeout(35_000);
    page.off('request', record);

    const sweeps = seen.filter((url) => OLD_SWEEP.test(url));
    expect(
      sweeps,
      'A `tournaments` read filtered by an inline club-id list is the old five-query ' +
        'path. It matched 1,322 rows for a three-club member and took eighty of them ' +
        'ordered by a column with no trigger maintaining it.'
    ).toEqual([]);

    const registrations = seen.filter((url) => OLD_REGISTRATIONS.test(url));
    expect(
      registrations,
      'The 200-row tournament_players read per poll. `is_registered` is resolved ' +
        'inside fn_get_ticker_feed now.'
    ).toEqual([]);

    for (const body of bodies.filter((b) => b.includes('fn_get_ticker_feed'))) {
      expect(
        body,
        'The club scope is derived from auth.uid() inside the function. A membership ' +
          'list on the wire means the browser is scoping itself again.'
      ).not.toMatch(/club_ids|clubIds|p_club/);
    }
  });

  test('when the rail is on screen, the feed is what put it there', async ({ page }) => {
    test.setTimeout(60_000);

    const feedCalls: string[] = [];
    page.on('request', (request) => {
      if (FEED_RPC.test(request.url())) feedCalls.push(request.url());
    });

    await openArena(page);
    /* Longer than the bar's first read and any retry behind it - the figure
       tests/e2e/routes/admin.spec.ts settled on for the same wait. */
    await page.waitForTimeout(8_000);

    const rail = page.locator('.mtt-ticker');
    if ((await rail.count()) === 0) {
      /* No rail on this session - signed out, or the club has it switched off,
         or there is genuinely nothing to announce. All three are correct
         behaviour, and none of them is evidence about the feed. */
      test.skip(true, 'no rail rendered for this session');
      return;
    }

    expect(
      feedCalls.length,
      'A rail is painted and fn_get_ticker_feed was never called, so something ' +
        'else fetched its contents.'
    ).toBeGreaterThan(0);

    /* The structural contract the unit tests pin, confirmed in a real browser:
       one scrolling viewport, and the clock inside its own field rather than
       welded to the label - which is what produced "Starts In0:19" on the live
       rail before 2026-09-13. */
    await expect(rail.locator('.mtt-ticker__viewport')).toHaveCount(1);
    const clock = rail.locator('.mtt-ticker__clock').first();
    if ((await clock.count()) > 0) {
      const field = clock.locator('xpath=..');
      await expect(field).toHaveClass(/mtt-ticker__field/);
      await expect(field).toContainText(/\s\d+:\d{2}/);
    }
  });
});
