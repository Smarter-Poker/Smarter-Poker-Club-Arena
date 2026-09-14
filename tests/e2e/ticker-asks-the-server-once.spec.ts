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

/** The old path's fingerprint: a REST read of `tournaments` scoped by a list. */
const OLD_SWEEP = /\/rest\/v1\/tournaments\?[^\s]*club_id=in\./;
/** The old registration read: 200 rows of tournament_players, per poll. */
const OLD_REGISTRATIONS = /\/rest\/v1\/tournament_players\?/;
/** The one call that replaced them. */
const FEED_RPC = /\/rest\/v1\/rpc\/fn_get_ticker_feed/;

test.describe('the ticker reads the server once', () => {
  test('sends no five-query sweep, and no club-id list', async ({ page }) => {
    const seen: string[] = [];
    const bodies: string[] = [];
    const record = (request: Request) => {
      seen.push(request.url());
      if (request.method() === 'POST') bodies.push(request.postData() ?? '');
    };
    page.on('request', record);

    await assertRendered(page, './');

    /* The bar polls, so one paint is not enough to prove a poll tick is clean.
       Sit through longer than the interval. */
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
    const feedCalls: string[] = [];
    page.on('request', (request) => {
      if (FEED_RPC.test(request.url())) feedCalls.push(request.url());
    });

    await assertRendered(page, './');
    await page.waitForTimeout(5_000);

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
