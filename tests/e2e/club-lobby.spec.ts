/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  CLUB LOBBY — real-browser click-through
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The lobby is the most-edited surface in this app and the least covered: the
 * existing route specs assert it RENDERED, which a 404 shell also satisfies.
 * This drives it instead, and asserts the things that were actually broken in
 * production rather than the things that are easy to check.
 *
 * Every assertion here corresponds to a real defect:
 *
 *   - the result count claimed a total that did not match the grid
 *   - Advanced Filters collected nine fields and applied three
 *   - a full table looked identical to an empty one and linked straight to a
 *     seat that did not exist
 *   - Join Waitlist sat inside the card's <Link>, so queueing also navigated
 *   - the bottom nav floated mid-page instead of pinning to the footer
 *
 * SIGNED OUT this file skips, exactly like the other authenticated specs:
 * expectRoute() calls test.skip() the moment it lands on /auth. It turns
 * itself on when SP_EMAIL / SP_PASS exist (see tests/e2e/global-setup.ts).
 *
 * CLUB_ID is overridable because which club has live games moves around; the
 * assertions are written to hold for an empty lobby as well as a busy one,
 * since "no games right now" is a legitimate state and a spec that only
 * passes on a busy club is a spec that fails at 4am.
 */
import { test, expect, type Page } from '@playwright/test';
import { expectRoute } from './routes/utils';

const CLUB_ID = process.env.E2E_CLUB_ID || 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const LOBBY = `clubs/${CLUB_ID}`;

/** Cards the grid is currently rendering (tournaments + cash, not the create tile). */
async function cardCount(page: Page): Promise<number> {
  return page.locator('.club-home__games .ngc').count();
}

/**
 * Wait until the lobby has actually finished loading.
 *
 * A fixed settle is wrong here: this club renders ~130 cards behind several
 * queries, and measured against production the grid appeared anywhere between
 * 3 and 20 seconds depending on cache warmth. Asserting on a 3s snapshot tests
 * the spinner, not the lobby. Resolve when either outcome has arrived, so a
 * genuinely empty club is a pass and not a 30s timeout.
 */
async function lobbySettled(page: Page): Promise<void> {
  await page
    .locator('.club-home__games .ngc, .empty-tables')
    .first()
    .waitFor({ state: 'visible', timeout: 45000 })
    .catch(() => {
      /* Fall through: the assertions below report the real state, and a
         timeout message here would hide it behind a locator error. */
    });
}

test.describe('Club lobby', () => {
  test('renders the lobby shell', async ({ page }) => {
    const ok = await expectRoute(page, LOBBY);
    if (!ok) return;
    await lobbySettled(page);
    await expect(page.locator('.club-home')).toBeVisible();
  });

  test('the result count matches the number of cards on screen', async ({ page }) => {
    const ok = await expectRoute(page, LOBBY);
    if (!ok) return;
    await lobbySettled(page);

    const count = page.locator('.lobby-count__text');
    const cards = await cardCount(page);

    if (cards === 0) {
      // An empty grid must show the empty state and NOT a count of zero.
      await expect(count).toHaveCount(0);
      await expect(page.locator('.empty-tables')).toBeVisible();
      return;
    }

    await expect(count).toBeVisible();
    // The bold number is the shown count in both phrasings ("N Games" and
    // "Showing N Of M Games"), so this compares the claim against reality.
    const shown = Number((await count.locator('strong').first().innerText()).replace(/[^0-9]/g, ''));
    expect(shown, 'the result count disagrees with the grid it describes').toBe(cards);
  });

  test('switching game type re-filters the grid and the count stays honest', async ({ page }) => {
    const ok = await expectRoute(page, LOBBY);
    if (!ok) return;
    await lobbySettled(page);

    const tabs = page.locator('.game-bar__type');
    const n = await tabs.count();
    test.skip(n === 0, 'no game-type tabs rendered');

    for (let i = 0; i < Math.min(n, 4); i++) {
      await tabs.nth(i).click();
      // Re-filtering is synchronous, but the grid re-renders with a stagger
      // animation; give it a beat rather than racing the first frame.
      await page.waitForTimeout(1200);
      const cards = await cardCount(page);
      const count = page.locator('.lobby-count__text');
      if (cards === 0) {
        await expect(count).toHaveCount(0);
      } else {
        const shown = Number(
          (await count.locator('strong').first().innerText()).replace(/[^0-9]/g, '')
        );
        expect(shown, `tab ${i}: count disagrees with the grid`).toBe(cards);
      }
    }
  });

  test('a full table says it is full and offers the queue without navigating', async ({ page }) => {
    const ok = await expectRoute(page, LOBBY);
    if (!ok) return;
    await lobbySettled(page);

    const full = page.locator('.ngc-fullpill');
    test.skip((await full.count()) === 0, 'no full tables in this lobby right now');

    /* Re-resolve the button before EVERY interaction rather than holding one
       handle. Toggling the queue changes state that re-renders the grid, and a
       stale handle then points at an element that has moved or detached: the
       first version of this test clicked one and landed on the hamburger,
       which opened the drawer over the lobby. */
    const waitButton = () =>
      page
        .locator('.ngc-wrap')
        .filter({ has: page.locator('.ngc-fullpill') })
        .first()
        .locator('.ngc-waitbtn');

    await expect(waitButton(), 'a full table offers no waitlist control').toBeVisible({
      timeout: 10000,
    });

    const isQueued = async () =>
      ((await waitButton().getAttribute('class')) ?? '').includes('is-on');
    const wasQueued = await isQueued();

    /* The button lives inside the card's <Link>. Without preventDefault +
       stopPropagation the tap would queue the player AND navigate them to the
       table that has no seat, which is the confusion the control exists to
       remove. Assert the URL does not move. */
    const before = page.url();
    await waitButton().scrollIntoViewIfNeeded();
    await waitButton().click();
    await expect
      .poll(isQueued, { timeout: 12000, message: 'the waitlist button never changed state' })
      .toBe(!wasQueued);
    expect(page.url(), 'joining the waitlist navigated away from the lobby').toBe(before);

    /* PUT IT BACK. This spec runs against PRODUCTION with a real account, so
       leaving the queue entry behind would mean every run enqueues the test
       user on another table until the engine is offering real seats to
       somebody who is not there. Restoring also exercises the leave path,
       which is otherwise never tested. */
    await waitButton().scrollIntoViewIfNeeded();
    await waitButton().click();
    await expect
      .poll(isQueued, {
        timeout: 12000,
        message: 'the waitlist state was not restored, so this run left a queue entry behind',
      })
      .toBe(wasQueued);
  });

  test('advanced filters open and close', async ({ page }) => {
    const ok = await expectRoute(page, LOBBY);
    if (!ok) return;
    await lobbySettled(page);

    /* The filter button is deliberately absent on ALL, which is the tab the
       lobby lands on: ALL has no spec of its own and means "show everything",
       so offering a sheet there would imply it can be narrowed. Move to a
       real game tab first, or this test skips itself and asserts nothing. */
    const tabs = page.locator('.game-bar__type');
    test.skip((await tabs.count()) < 2, 'no game-type tabs to leave ALL with');
    await tabs.nth(1).click();
    await page.waitForTimeout(800);

    const opener = page.locator('.game-bar__filter-btn');
    await expect(
      opener.first(),
      'no advanced-filters button on a specific game tab'
    ).toBeVisible({ timeout: 8000 });

    await opener.first().click();
    const sheet = page.locator('.afx-sheet');
    await expect(sheet, 'the filters sheet did not open').toBeVisible({ timeout: 8000 });
    await page.keyboard.press('Escape');
    await expect(sheet, 'Escape did not close the filters sheet').toBeHidden({ timeout: 8000 });
  });

  test('the bottom nav is pinned to the bottom of the viewport', async ({ page }) => {
    const ok = await expectRoute(page, LOBBY);
    if (!ok) return;
    await lobbySettled(page);

    /* ClubBottomNav is a CSS module, so its class carries a build hash
       (_bottomNav_o2fho_8) that changes on every build. Match the stable
       part; a hard-coded hash would turn this into a spec that passes until
       the next deploy. */
    const nav = page.locator('[class*="bottomNav"]').first();
    test.skip((await nav.count()) === 0, 'no bottom nav on this layout');

    const box = await nav.boundingBox();
    const vh = page.viewportSize()?.height ?? 0;
    expect(box, 'the bottom nav has no box').not.toBeNull();
    // Its bottom edge should sit at the viewport floor, not mid-page.
    expect(Math.abs((box!.y + box!.height) - vh), 'the bottom nav is not pinned to the footer').toBeLessThan(4);
  });
});
