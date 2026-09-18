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
import { prepareCashLobbyActions } from './support/cashLobbyOverlays';

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
    .waitFor({ state: 'visible', timeout: 45000 });

  // Every test has a fresh context. Dismiss the optional entry greeting and
  // Diamond invitation through their real controls before lobby interactions.
  await prepareCashLobbyActions(page);
}

test.describe('Club lobby', () => {
  /* Every case opens a fresh context and may need the 45s cold-read budget.
     Keep the existing 30s route/action budget in addition to that read. A
     shorter outer deadline closes the page before settlement can report its
     result, and must not be caught as though the lobby had loaded. */
  test.describe.configure({ timeout: 75_000 });

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

  /**
   * A TOURNAMENT goes to its own screen. A CASH game opens the panel.
   *
   * Dan 2026-08-25: "when you click any of the MTT fields in the display
   * inside of ALL or MTT, it should open to the tournament lobby." The old
   * rule here was narrower — only a tournament already RUNNING / in LATE REG /
   * COMPLETED routed, and a REGISTERING one fell through to the pre-commit
   * panel. Same row, same tab, two destinations depending on a status the
   * player cannot see. `openEntry` now short-circuits on `kind === 'mtt'`
   * alone, so this selector drops the status classes with it.
   *
   * The contract this spec defends is UNCHANGED and still asserted on both
   * destinations: selecting a row never JOINS, REGISTERS or SPENDS. A
   * read-only tournament screen does none of those (verified: `registerMtt`
   * is reachable only from the sign-up modal's onClick, and the auto-open-seat
   * effect requires an existing `tournament_players` row). Only WHERE the
   * review happens changed.
   *
   * Lobby rows carry `data-kind`, so which of the two a row is can be read off
   * the row itself instead of guessed from its position.
   */
  const ROUTED_MTT = '[data-kind="mtt"]';

  /**
   * Index of the first row of one kind or the other, or -1. Reading the index
   * and then clicking through a normal Playwright locator keeps the click a
   * real click, with the actionability checks intact — only the CHOICE of row
   * is made in the page.
   */
  async function firstRow(page: Page, kind: 'panel' | 'mtt'): Promise<number> {
    return page.evaluate(
      ({ sel, wantMtt }) =>
        [
          ...document.querySelectorAll('.club-home__games .lt-row:not(.lt-row--skeleton)'),
        ].findIndex((r) => r.matches(sel) === wantMtt),
      { sel: ROUTED_MTT, wantMtt: kind === 'mtt' }
    );
  }

  test('selecting a row opens the game lobby panel without joining', async ({ page }) => {
    const ok = await expectRoute(page, LOBBY);
    if (!ok) return;
    await lobbySettled(page);

    const rows = await rowCount(page);
    test.skip(rows === 0, 'no games in this lobby right now');

    const i = await firstRow(page, 'panel');
    test.skip(i < 0, 'every game in this lobby is a tournament, which routes instead');

    const row = page.locator('.club-home__games .lt-row:not(.lt-row--skeleton)').nth(i);
    const kind = await row.getAttribute('data-kind');
    expect(kind, 'a lobby row rendered without a data-kind').toBeTruthy();

    const before = page.url();
    await row.click();

    // The panel opens with the approved presentation for that game; the URL
    // must not move — a row click reviews the game, it never joins, registers,
    // or spends. Cash tables deliberately use the live Arena machine while
    // tournament-derived games use the Casino Plaque.
    const panel = page.locator('.glp');
    await expect(panel, 'selecting a row did not open the game lobby panel').toBeVisible({
      timeout: 8000,
    });
    if (kind === 'cash') {
      await expect(panel.locator('.arena-game-card')).toBeVisible();
    } else {
      await expect(panel.locator('.cplaque')).toBeVisible();
    }

    /* The panel deep-links itself: ClubHomePage writes `?game=<id>` while it
       is open so the selection survives a refresh and can be shared. That is
       a search-param write on the SAME route, not navigation, and comparing
       whole URLs called it a failure — the second way this assertion had gone
       stale against a deliberate change. Compare the route, and require that
       the only thing added is the deep link. */
    const now = new URL(page.url());
    expect(now.pathname, 'selecting a row navigated away from the lobby').toBe(
      new URL(before).pathname
    );
    for (const [k] of now.searchParams) {
      expect(k, 'selecting a row changed more than the game deep link').toBe('game');
    }

    // Escape closes the panel.
    await page.keyboard.press('Escape');
    await expect(panel, 'Escape did not close the game lobby panel').toBeHidden({ timeout: 8000 });
  });

  test('selecting a tournament at ANY status opens its own screen, and still does not register', async ({
    page,
  }) => {
    const ok = await expectRoute(page, LOBBY);
    if (!ok) return;
    await lobbySettled(page);

    const i = await firstRow(page, 'mtt');
    test.skip(i < 0, 'no tournament in this lobby right now');

    const row = page.locator('.club-home__games .lt-row:not(.lt-row--skeleton)').nth(i);
    const id = await row.getAttribute('data-id');
    expect(id, 'a lobby row rendered without a data-id').toBeTruthy();

    await row.click();

    // It reviews the tournament. It must be THAT tournament, and it must not
    // have committed the player to anything on the way there.
    await expect(page, 'a tournament row did not open its own screen').toHaveURL(
      new RegExp(`/tournaments/${id}(?:[/?#]|$)`),
      { timeout: 10000 }
    );
    await expect(
      page.locator('.glp'),
      'the game lobby panel opened on top of the tournament screen'
    ).toHaveCount(0);
  });

  test('a full table says it is full and offers the queue without navigating', async ({ page }) => {
    const ok = await expectRoute(page, LOBBY);
    if (!ok) return;
    await lobbySettled(page);

    // Find a full CASH row by its status badge.
    const fullRow = page
      .locator('.club-home__games .lt-row[data-kind="cash"]')
      .filter({ has: page.locator('.lt-status--full') })
      .first();
    test.skip((await fullRow.count()) === 0, 'no full cash tables in this lobby right now');

    await fullRow.scrollIntoViewIfNeeded();
    await fullRow.click();

    const panel = page.locator('.glp');
    await expect(panel).toBeVisible({ timeout: 8000 });

    /* Re-resolve the CTA before every interaction: toggling the queue
       re-renders the panel and a stale handle detaches. */
    const cta = () => panel.locator('.agc-action--primary');
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
