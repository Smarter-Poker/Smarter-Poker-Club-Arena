/**
 * PHASE 7 CHANGED WHERE TEN URLS GO. NOTHING IN PRODUCTION CHECKED THAT.
 *
 * Four pages were connected to a navigation surface and six duplicate doors
 * were retired into redirects. `everyRouteIsReachableLaw` proves a nav surface
 * POINTS at each connected route, and it proves it by reading the registries -
 * it cannot tell whether the page on the other end actually renders, or whether
 * a retired URL lands anywhere real.
 *
 * That is the gap this file closes, and it is the gap Dan named from the start:
 * "make sure every page and subpage is fully built out and ACTUALLY CONNECTED
 * AND FUNCTIONAL". A door drawn on a wall passes a registry test.
 *
 * It lives in tests/e2e/routes/ on purpose: post-deploy-e2e.yml names that
 * DIRECTORY rather than each file, so this runs against production from the
 * next deploy without anyone wiring it in - the property that workflow's own
 * comment calls out as why the directory is named and not its contents.
 */
import { expect, test } from '@playwright/test';
import { expectRoute } from './utils';

const CLUB_ID = process.env.E2E_CLUB_ID || 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';

test.describe('Phase 7 - the pages that were given a door', () => {
  test('the agent dashboard renders, and it is the one with 1.49M commission rows behind it', async ({
    page,
  }) => {
    await expectRoute(page, 'agent-dashboard');
  });

  test('the club-scoped agent network renders', async ({ page }) => {
    await expectRoute(page, `clubs/${CLUB_ID}/agent-dashboard`);
  });

  test('anti-cheat renders at its new club-scoped route', async ({ page }) => {
    // The route added in Phase 7. Before it, AntiCheatPage was global and
    // guessed a club from whichever club_members row came back first.
    await expectRoute(page, `clubs/${CLUB_ID}/anti-cheat`);
  });

  test('the report form renders, so the review queue can receive something', async ({ page }) => {
    // user_reports held ZERO rows because this form had no inbound link.
    await expectRoute(page, 'report/demo-user');
  });
});

test.describe('Phase 7 - the doors that were retired', () => {
  /**
   * A retired URL must LAND somewhere, never sit on a dead route.
   *
   * SIGNED OUT, THE HUB BOUNCES AFTERWARDS, AND THAT IS NOT A FAILURE.
   * Measured against production while writing this file: `union-dashboard`
   * redirected correctly to /hub/club-arena/unions and the hub then sent the
   * anonymous visitor to /auth/login?redirect=%2Fhub%2Fclub-arena%2Funions.
   * The destination is right there in the `redirect` parameter - the redirect
   * DID happen. A first draft asserting only the final URL passed one run and
   * failed the next purely on which of the two won the race, which is exactly
   * the flake this suite must not gain.
   *
   * So: the destination, or an auth bounce that names the destination.
   */
  const landsOn = async (page: import('@playwright/test').Page, from: string, expected: RegExp) => {
    await page.goto(from);
    await page.waitForLoadState('domcontentloaded');
    await expect(page, `${from} did not land where Phase 7 sent it`).toHaveURL(
      (url) => {
        const href = url.href;
        if (expected.test(href)) return true;
        const bounced = /\/auth\/login/.test(href) ? url.searchParams.get('redirect') : null;
        return bounced ? expected.test(bounced) : false;
      },
      { timeout: 20000 }
    );
  };

  /**
   * ── THE DESTINATION HAS ITS OWN DOOR POLICY (2026-09-23) ────────────────
   *
   * `/unions` is deliberately closed. Dan, 2026-09-05: "AND THIS PAGE SHOULD
   * BE HIDDEN TO EVERYONE EXECPT ME". `UnionNetworkGuard` sends any account it
   * refuses to `/community` "which is where the Unions entry used to live and
   * is a place they can actually use". The production certification account is
   * exactly such an account, so `/unions` is never a URL it is allowed to
   * REST on.
   *
   * `landsOn` above samples the address bar, so for these two doors it was
   * racing that guard: the redirect chain is
   * `union-dashboard` -> `/unions` -> (guard resolves) -> `/community`, and
   * whether `/unions` is still showing when the assertion looks depends on how
   * fast `useCanOperateUnionNetwork` answers a network round trip.
   *
   * MEASURED, Post-Deploy E2E run 35865600057 (2026-09-23T13:37Z): the two
   * tests have the IDENTICAL destination and split in the same run.
   * `union-games` sampled at 13:37:05 and passed on `/unions`;
   * `union-dashboard` sampled from 13:37:01 and failed 20s later on
   * `https://smarter.poker/hub/club-arena/community`. Nothing about the doors
   * differed; only which side of the guard each one caught.
   *
   * The header above this helper already warned about exactly this: "A first
   * draft asserting only the final URL passed one run and failed the next
   * purely on which of the two won the race, which is exactly the flake this
   * suite must not gain." It had gained it anyway, on the one destination that
   * refuses its own visitors.
   *
   * So a union door may land on `/unions`, on the auth bounce that names it,
   * or on the refusal `/unions` itself performs. It may NOT sit on
   * `union-dashboard`/`union-games` rendering their orphan pages, and it may
   * not land anywhere else - which is the whole of what Phase 7 retired.
   *
   * This accepts the guard's outcome; it does not accept a door repointed at
   * `/community` directly. `tests/unit/phase7UnionDoorsForwardToUnions.test.ts`
   * holds both routes to `Navigate to="/unions"` in App.tsx, so the half this
   * assertion can no longer see is pinned where it cannot race.
   */
  const UNION_DOOR_LANDINGS = /\/unions(?:[/?#]|$)|\/community(?:[/?#]|$)/;

  test('rakeback-dashboard lands on the one rakeback display', async ({ page }) => {
    await landsOn(page, 'rakeback-dashboard', /\/rakeback(?:[/?#]|$)/);
  });

  test('union-dashboard lands on unions, or on where unions sends a refused account', async ({
    page,
  }) => {
    await landsOn(page, 'union-dashboard', UNION_DOOR_LANDINGS);
  });

  test('union-games lands on unions, or on where unions sends a refused account', async ({
    page,
  }) => {
    await landsOn(page, 'union-games', UNION_DOOR_LANDINGS);
  });

  test('the duplicate club dashboard lands on club data, carrying its club', async ({ page }) => {
    // `relative="path"` resolves ../data against the current URL, so the club
    // id has to survive the redirect. That is the part worth checking.
    await landsOn(page, `clubs/${CLUB_ID}/dashboard`, new RegExp(`/clubs/${CLUB_ID}/data`));
  });

  test('waitlist lands on the arena, where the tables and their queues are', async ({ page }) => {
    // The arena root, or the auth bounce that names it.
    await landsOn(page, 'waitlist', /\/hub\/club-arena\/?(?:[?#]|$)|^%2Fhub%2Fclub-arena$/);
  });

  test('player-sessions either forwards to a club roster or says a club is needed', async ({
    page,
  }) => {
    /* Three legitimate outcomes, and the test must tell them apart rather than
       assume a session:
         - a viewer WITH a club is forwarded to that club's roster;
         - a viewer WITHOUT one gets LegacyClubToolRedirect's named empty state;
         - a viewer with NO SESSION is bounced to the hub login, because
           LegacyClubToolRedirect waits on `user?.id` and the AuthGuard above it
           wins the race a moment later.
       Measured against production while writing this file: signed out, this
       route lands on the hub login page - and it lands there LATE, after
       domcontentloaded, which is why the check at the top of the other tests
       cannot see it. Asserting the empty state without this branch fails for
       having no session rather than for a broken redirect. */
    await page.goto('player-sessions');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(6000);

    const url = page.url();
    if (/\/auth(?:\/|\?|$)/.test(url)) {
      test.skip();
      return;
    }
    if (/\/clubs\/[^/]+\/members/.test(url)) return;

    await expect(
      page.getByText(/Choose A Club Before Opening/i).first(),
      'player-sessions neither forwarded to a roster nor explained why not'
    ).toBeVisible({ timeout: 15000 });
  });
});
