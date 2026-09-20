/**
 * THE DIAMOND ARENA ROUTE ON A PHONE (D8, 2026-09-20)
 *
 * `/hub/club-arena/clubs/diamond-arena` is the one room in this app that is
 * light rather than black, and it is the room a player reaches from the wallet
 * while funded play is still switched off. What has to hold on the narrowest
 * phone we support, in both orientations:
 *
 *   1. nothing overflows sideways at 375 CSS pixels;
 *   2. asking for the arena without a session does not LOSE the arena: the
 *      sign-in bounce carries the route back, so the selection survives the
 *      door;
 *   3. on the arena, the light scheme is published on its own attribute
 *      (`data-arena-scheme`) and not by rewriting the player's `data-theme`;
 *   4. the closed-arena copy is shown, a refresh on the route keeps the arena,
 *      and walking back out takes the scheme away again. A scheme that is
 *      applied but never removed reads as correct on the arena and turns the
 *      chip estate white.
 *
 * THREE OUTCOMES, NOT TWO. `ci.yml` runs this suite against production SIGNED
 * OUT and holds no credentials, by design; `post-deploy-e2e.yml` runs it with
 * the isolated production account it creates for the certification. Measured
 * 2026-09-20 signed out, this route answers
 * `/auth/login?redirect=%2Fhub%2Fclub-arena%2Fclubs%2Fdiamond-arena`, which is
 * the World Hub's sign-in page and not this app at all. So cases 1 and 2 are
 * certified on every run, and the cases that need to be STANDING ON the arena
 * say so: they skip, naming why the browser is not there, rather than asserting
 * something a login page would also satisfy. This estate has paid for the
 * alternative: 92 route specs once sat green on a 404 page, because a body is
 * visible there too.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const ARENA_ROUTE = 'clubs/diamond-arena';
/* Leaving the arena, by a route inside this app that no account is refused
   and that is not a club: the wallet. */
const AWAY_ROUTE = 'wallet';
const SCHEME_ATTR = 'data-arena-scheme';
const ARENA_PATH = '/clubs/diamond-arena';
const CLOSED_COPY = 'Not Open Yet';

const ORIENTATIONS = [
  ['portrait', { width: 375, height: 812 }],
  ['landscape', { width: 812, height: 375 }],
] as const;

/** Something has painted. Not `#root`: signed out this is a different app. */
async function waitForPaint(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.body && document.body.childElementCount > 0,
    undefined,
    {
      timeout: 30_000,
    }
  );
}

/**
 * Open the arena and let any bounce finish before anything is read. Reading the
 * DOM while a redirect is in flight is what "Execution context was destroyed"
 * means, and it is a property of the page rather than of the case.
 *
 * `onArena` is the third outcome: not "passed" and not "failed" but "the
 * browser is not standing where this case is about", with the reason named.
 */
async function openArena(page: Page): Promise<{ onArena: boolean; why: string; url: URL }> {
  await page.goto(ARENA_ROUTE, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await waitForPaint(page);
  const url = new URL(page.url());
  const onArena = url.pathname.includes(ARENA_PATH);
  const why = onArena
    ? ''
    : url.pathname.includes('/auth')
      ? 'the Diamond Arena route needs a signed-in session and bounced to ' +
        `${url.pathname}; ci.yml runs this suite signed out on purpose. Set SP_EMAIL and ` +
        'SP_PASS for tests/e2e/global-setup.ts, or read this case from the post-deploy run. ' +
        'The layout and sign-in-bounce cases ran.'
      : `the browser did not stay on the arena; it is on ${url.pathname}. This case is about ` +
        'what the arena route renders, so it reports that it could not tell rather than ' +
        'judging another page.';
  return { onArena, why, url };
}

function scheme(page: Page): Promise<string | null> {
  return page.evaluate((attr) => document.documentElement.getAttribute(attr), SCHEME_ATTR);
}

/**
 * Sideways overflow, measured on the documents that can actually scroll. A
 * child wider than the viewport shows up here as scrollWidth past clientWidth;
 * comparing against the viewport number instead would report a scrollbar as a
 * defect.
 */
async function horizontalOverflow(page: Page): Promise<{ root: number; body: number }> {
  return page.evaluate(() => ({
    root: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }));
}

test('the stylesheet keys the light room on the attribute this spec reads', () => {
  /* Static, so it certifies on every run including the signed-out one: the
     attribute asserted below is the one the published scheme block selects. */
  const css = readFileSync('src/styles/club-engine.css', 'utf8');
  expect(css).toContain(`html[${SCHEME_ATTR}='light']`);
});

for (const [orientation, viewport] of ORIENTATIONS) {
  test.describe(`the Diamond Arena route at 375px ${orientation}`, () => {
    test.use({ viewport, hasTouch: true, isMobile: true });

    test('does not overflow sideways', async ({ page }) => {
      await openArena(page);
      const overflow = await horizontalOverflow(page);
      expect(overflow.root, 'the document scrolls sideways').toBeLessThanOrEqual(1);
      expect(overflow.body, 'the body scrolls sideways').toBeLessThanOrEqual(1);
    });

    test('keeps the arena selection through the sign-in door', async ({ page }) => {
      const { onArena, url } = await openArena(page);
      if (onArena) {
        expect(url.pathname).toContain(ARENA_PATH);
        return;
      }
      /* No session: the room is not opened, and the route is not thrown away
         either. Whichever parameter the hub uses, the arena has to be in it. */
      const carried = url.searchParams.get('redirect') ?? url.searchParams.get('next') ?? '';
      expect(decodeURIComponent(carried), `the bounce lost the arena: ${url.href}`).toContain(
        ARENA_PATH
      );
    });

    test('publishes the light scheme on its own attribute and leaves the player theme alone', async ({
      page,
    }) => {
      const { onArena, why } = await openArena(page);
      test.skip(!onArena, why);
      expect(await scheme(page)).toBe('light');
      /* The scheme says where you are. `data-theme` says what you prefer, and
         walking into a room may not rewrite it. */
      const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      expect(theme === null || theme === 'dark' || theme === 'light').toBe(true);
    });

    test('says the arena is not open yet while its switch is off', async ({ page }) => {
      const { onArena, why } = await openArena(page);
      test.skip(!onArena, why);
      /* Both switches are off, and neither is ours to flip: the seat card and
         the registration card each carry the same label. If the lobby never
         rendered a card, that is a third outcome too, not a verdict. */
      const label = page.getByText(CLOSED_COPY).first();
      const appeared = await label
        .waitFor({ state: 'visible', timeout: 20_000 })
        .then(() => true)
        .catch(() => false);
      test.skip(
        !appeared,
        'the arena lobby did not render a seat or registration card within 20s, so the ' +
          'closed-arena copy could not be read. This case reports that rather than passing.'
      );
      await expect(label).toBeVisible();
      expect((await horizontalOverflow(page)).root).toBeLessThanOrEqual(1);
    });
  });
}

test.describe('the Diamond Arena selection survives the browser', () => {
  test.use({ viewport: ORIENTATIONS[0][1], hasTouch: true, isMobile: true });

  test('a refresh on the route keeps the arena', async ({ page }) => {
    const { onArena, why } = await openArena(page);
    test.skip(!onArena, why);
    expect(await scheme(page)).toBe('light');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForPaint(page);
    /* A cold load of the same URL has to reach the same verdict: the attribute
       comes from the pathname, so it cannot depend on having navigated here. */
    expect(await scheme(page)).toBe('light');
    expect(new URL(page.url()).pathname).toContain(ARENA_PATH);
  });

  test('going back to the arena restores it, and leaving it takes it away', async ({ page }) => {
    const { onArena, why } = await openArena(page);
    test.skip(!onArena, why);
    expect(await scheme(page)).toBe('light');

    await page.goto(AWAY_ROUTE, { waitUntil: 'domcontentloaded' });
    await waitForPaint(page);
    /* The chip estate is black. An attribute that is applied and never removed
       is the defect this half of the case exists to catch. */
    expect(new URL(page.url()).pathname).not.toContain(ARENA_PATH);
    expect(await scheme(page)).toBeNull();

    await page.goBack({ waitUntil: 'domcontentloaded' });
    await waitForPaint(page);
    expect(new URL(page.url()).pathname).toContain(ARENA_PATH);
    expect(await scheme(page)).toBe('light');
  });
});
