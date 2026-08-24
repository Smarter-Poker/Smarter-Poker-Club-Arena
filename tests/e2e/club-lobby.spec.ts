/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  CLUB LOBBY — real-browser click-through (LOBBY V2, line-based)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Rewritten 2026-08-22 alongside the Lobby V2 refactor: the card grid
 * (.ngc-*) was replaced by the dense line-based table (.lt-*) plus the
 * CasinoPlaque game lobby panel (.glp / .cplaque). Every assertion still
 * corresponds to a real defect class:
 *
 *   - the result count claimed a total that did not match the list
 *   - a full table looked identical to an empty one and linked straight to a
 *     seat that did not exist
 *   - queueing from the lobby also navigated
 *   - selecting a row must NEVER join, register, or spend — it opens the
 *     game lobby panel where the player commits explicitly
 *
 * SIGNED OUT this file skips, exactly like the other authenticated specs:
 * expectRoute() calls test.skip() the moment it lands on /auth.
 */
import { test, expect, type Page } from '@playwright/test';
import { expectRoute } from './routes/utils';

const CLUB_ID = process.env.E2E_CLUB_ID || 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const LOBBY = `clubs/${CLUB_ID}`;

/** Rows the lobby table is currently rendering (skeleton rows excluded). */
async function rowCount(page: Page): Promise<number> {
  return page.locator('.club-home__games .lt-row:not(.lt-row--skeleton)').count();
}

/**
 * Wait until the lobby has actually finished loading: either rows arrived or
 * the empty state did. A genuinely empty club is a pass, not a timeout.
 */
async function lobbySettled(page: Page): Promise<void> {
  await page
    .locator('.club-home__games .lt-row:not(.lt-row--skeleton), .empty-tables')
    .first()
    .waitFor({ state: 'visible', timeout: 45000 })
    .catch(() => {
      /* Fall through: the assertions below report the real state. */
    });
}

test.describe('Club lobby', () => {
  test('renders the lobby shell', async ({ page }) => {
    const ok = await expectRoute(page, LOBBY);
    if (!ok) return;
    await lobbySettled(page);
    await expect(page.locator('.club-home')).toBeVisible();
  });

  test('the result count matches the number of rows on screen', async ({ page }) => {
    const ok = await expectRoute(page, LOBBY);
    if (!ok) return;
    await lobbySettled(page);

    const count = page.locator('.lobby-count__text');
    const rows = await rowCount(page);

    if (rows === 0) {
      // An empty list must show the empty state and NOT a count of zero.
      await expect(count).toHaveCount(0);
      await expect(page.locator('.empty-tables')).toBeVisible();
      return;
    }

    // 2026-08-24: the bare "N Games" line was removed at Dan's request. The
    // count now renders ONLY while a filter or search is hiding games, where
    // it explains a short list rather than restating its length. So its
    // absence is correct here; when it IS present it must still be honest.
    if ((await count.count()) === 0) return;
    const shown = Number(
      (await count.locator('strong').first().innerText()).replace(/[^0-9]/g, '')
    );
    expect(shown, 'the result count disagrees with the list it describes').toBe(rows);
  });

  test('switching game type re-filters the list and the count stays honest', async ({ page }) => {
    const ok = await expectRoute(page, LOBBY);
    if (!ok) return;
    await lobbySettled(page);

    const tabs = page.locator('.game-bar__type');
    const n = await tabs.count();
    test.skip(n === 0, 'no game-type tabs rendered');

    for (let i = 0; i < Math.min(n, 4); i++) {
      await tabs.nth(i).click();
      await page.waitForTimeout(800);
      const rows = await rowCount(page);
      const count = page.locator('.lobby-count__text');
      if (rows === 0) {
        await expect(count).toHaveCount(0);
      } else if ((await count.count()) > 0) {
        // Present only while something is narrowing the list — see above.
        const shown = Number(
          (await count.locator('strong').first().innerText()).replace(/[^0-9]/g, '')
        );
        expect(shown, `tab ${i}: count disagrees with the list`).toBe(rows);
      }
    }
  });

  test('selecting a row opens the game lobby panel without joining', async ({ page }) => {
    const ok = await expectRoute(page, LOBBY);
    if (!ok) return;
    await lobbySettled(page);

    const rows = await rowCount(page);
    test.skip(rows === 0, 'no games in this lobby right now');

    const before = page.url();
    await page.locator('.club-home__games .lt-row:not(.lt-row--skeleton)').first().click();

    // The panel opens with the Casino Plaque; the URL must not move — a row
    // click reviews the game, it never joins, registers, or spends.
    const panel = page.locator('.glp');
    await expect(panel, 'selecting a row did not open the game lobby panel').toBeVisible({
      timeout: 8000,
    });
    await expect(panel.locator('.cplaque')).toBeVisible();
    expect(page.url(), 'selecting a row navigated away from the lobby').toBe(before);

    // Escape closes the panel.
    await page.keyboard.press('Escape');
    await expect(panel, 'Escape did not close the game lobby panel').toBeHidden({ timeout: 8000 });
  });

  test('a full table says it is full and offers the queue without navigating', async ({ page }) => {
    const ok = await expectRoute(page, LOBBY);
    if (!ok) return;
    await lobbySettled(page);

    // Find a full CASH row by its status badge.
    const fullRow = page
      .locator('.club-home__games .lt-row')
      .filter({ has: page.locator('.lt-status--full') })
      .first();
    test.skip((await fullRow.count()) === 0, 'no full tables in this lobby right now');

    await fullRow.scrollIntoViewIfNeeded();
    await fullRow.click();

    const panel = page.locator('.glp');
    await expect(panel).toBeVisible({ timeout: 8000 });

    /* Re-resolve the CTA before every interaction: toggling the queue
       re-renders the panel and a stale handle detaches. */
    const cta = () => panel.locator('.cplaque__cta');
    await expect(cta(), 'a full table offers no waitlist control').toBeVisible({ timeout: 10000 });

    const label = (await cta().innerText()).trim().toLowerCase();
    test.skip(
      !label.includes('waitlist'),
      'full table CTA is not a waitlist control (player may be seated here)'
    );
    const wasQueued = label.includes('leave');

    const before = page.url();
    await cta().click();
    await expect
      .poll(async () => (await cta().innerText()).trim().toLowerCase().includes('leave'), {
        timeout: 12000,
        message: 'the waitlist CTA never changed state',
      })
      .toBe(!wasQueued);
    expect(page.url(), 'joining the waitlist navigated away from the lobby').toBe(before);

    /* PUT IT BACK — this runs against production with a real account. */
    await cta().click();
    await expect
      .poll(async () => (await cta().innerText()).trim().toLowerCase().includes('leave'), {
        timeout: 12000,
        message: 'the waitlist state was not restored, so this run left a queue entry behind',
      })
      .toBe(wasQueued);

    await page.keyboard.press('Escape');
  });

  test('advanced filters open and close', async ({ page }) => {
    const ok = await expectRoute(page, LOBBY);
    if (!ok) return;
    await lobbySettled(page);

    /* The filter button is deliberately absent on ALL. Move to a real game
       tab first, or this test skips itself and asserts nothing. */
    const tabs = page.locator('.game-bar__type');
    test.skip((await tabs.count()) < 2, 'no game-type tabs to leave ALL with');
    await tabs.nth(1).click();
    await page.waitForTimeout(800);

    const opener = page.locator('.game-bar__filter-btn');
    await expect(opener.first(), 'no advanced-filters button on a specific game tab').toBeVisible({
      timeout: 8000,
    });

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

    /* ClubBottomNav is a CSS module, so its class carries a build hash.
       Match the stable part. */
    const nav = page.locator('[class*="bottomNav"]').first();
    test.skip((await nav.count()) === 0, 'no bottom nav on this layout');

    const box = await nav.boundingBox();
    const vh = page.viewportSize()?.height ?? 0;
    expect(box, 'the bottom nav has no box').not.toBeNull();
    expect(
      Math.abs(box!.y + box!.height - vh),
      'the bottom nav is not pinned to the footer'
    ).toBeLessThan(4);
  });
});
