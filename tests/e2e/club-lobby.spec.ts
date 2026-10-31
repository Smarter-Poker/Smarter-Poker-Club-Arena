import { openLobbyGameSection } from './support/lobbyGameSections';
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  CLUB LOBBY — real-browser click-through (LOBBY V2, line-based)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Rewritten 2026-08-22 alongside the Lobby V2 refactor: the card grid
 * (.ngc-*) was replaced by the dense line-based table (.lt-*) plus the
 * approved game-card lobby panel (.glp / .arena-game-card). Every assertion still
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
import { diamondEntryRead, settleDiamondSpinsOffer } from './support/diamondInvitationOffer';

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
  await prepareCashLobbyActions(page);
  await openLobbyGameSection(page, 'ALL');
  await page
    .locator('.club-home__games .lt-row:not(.lt-row--skeleton), .empty-tables')
    .first()
    .waitFor({ state: 'visible', timeout: 45000 });

  // Every test has a fresh context. Dismiss the optional entry greeting and
  // Diamond invitation through their real controls before lobby interactions.
  await prepareCashLobbyActions(page);
}

/** Cash-door cases must not inherit another case's durable MTT/PLO filter. */
async function selectAllGames(page: Page): Promise<void> {
  await openLobbyGameSection(page, 'ALL');
  const all = page.getByRole('tab', { name: 'ALL', exact: true });
  await all.click();
  await expect(all).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.club-home__games .lt-row[data-kind="cash"]').first()).toBeVisible({
    timeout: 45_000,
  });
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

  /* October 22: every kind reviews its game card first. The full tournament
     screen remains one explicit Details click away. Selection never spends. */
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
    await selectAllGames(page);

    const rows = await rowCount(page);
    test.skip(rows === 0, 'no games in this lobby right now');

    const i = await firstRow(page, 'panel');
    test.skip(i < 0, 'no cash or seat-first game in this lobby');

    const row = page.locator('.club-home__games .lt-row:not(.lt-row--skeleton)').nth(i);
    const kind = await row.getAttribute('data-kind');
    expect(kind, 'a lobby row rendered without a data-kind').toBeTruthy();

    const before = page.url();
    await row.click();

    // Every selected game uses its approved card before an explicit action.
    const panel = page.locator('.glp');
    await expect(panel, 'selecting a row did not open the game lobby panel').toBeVisible({
      timeout: 8000,
    });
    await expect(panel.locator('.arena-game-card')).toBeVisible();

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

  test('selecting a tournament reviews its card, then Details opens that event', async ({
    page,
  }) => {
    const ok = await expectRoute(page, LOBBY);
    if (!ok) return;
    await lobbySettled(page);

    // The dedicated tournament club has a real maintained catalog. ALL only
    // includes registering/late entries; use the actual MTT category instead
    // of silently skipping when that subset is temporarily empty.
    await openLobbyGameSection(page, 'MTT');
    await page.getByRole('tab', { name: "MTT'S", exact: true }).click();
    await expect(page.locator('.club-home__games .lt-row[data-kind="mtt"]').first()).toBeVisible({
      timeout: 45_000,
    });
    const i = await firstRow(page, 'mtt');
    expect(i, 'the maintained tournament club must expose a real MTT row').toBeGreaterThanOrEqual(
      0
    );

    const row = page.locator('.club-home__games .lt-row:not(.lt-row--skeleton)').nth(i);
    const id = await row.getAttribute('data-id');
    expect(id, 'a lobby row rendered without a data-id').toBeTruthy();

    await row.click();

    const panel = page.locator('.glp');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.arena-game-card')).toBeVisible();
    await expect(page).not.toHaveURL(new RegExp(`/tournaments/${id}(?:[/?#]|$)`));
    await panel.getByRole('button', { name: 'Details', exact: true }).click();

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

  test('a clustered cash game reviews its game-level door without joining', async ({ page }) => {
    const ok = await expectRoute(page, LOBBY);
    if (!ok) return;
    await lobbySettled(page);
    await selectAllGames(page);

    // R10: a cash GAME opens feeders when a Main fills. It never advertises
    // the game as Full or offers a standalone table queue. The maintained
    // Diamond catalog exercises this real production path. The standalone
    // 6/6 table's Join/Leave Waitlist path remains enforced by the actual
    // GameLobbyPanel browser fixture in both browser engines.
    const row = page.locator('.club-home__games .lt-row[data-kind="cash"]').first();
    await expect(row).toBeVisible();
    await expect(row.locator('.lt-status--full')).toHaveCount(0);
    await row.scrollIntoViewIfNeeded();
    const before = new URL(page.url());
    await row.click();
    const panel = page.locator('.glp');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.arena-game-card')).toBeVisible();
    const cta = panel.locator('button[data-zone="primaryAction"]');
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAccessibleName(/^(Join Game|Join Lightning|Not Open Yet)$/i);
    await expect(panel.getByRole('button', { name: /^(Join|Leave) Waitlist$/i })).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe(before.pathname);
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    expect(new URL(page.url()).pathname).toBe(before.pathname);
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

// This is the ordinary must-move game, distinct from Lightning. Read only:
// opening a card and refreshing it must never admit a player or buy chips.
for (const width of [393, 1440]) {
  test(`PLO5 1/2 Madness exposes its actual rules at ${width}px`, async ({ page }) => {
    test.setTimeout(210_000);
    expect(
      Boolean(process.env.SP_EMAIL && process.env.SP_PASS),
      'isolated authenticated account required'
    ).toBe(true);
    await page.setViewportSize({ width, height: 900 });
    const moneyCalls: string[] = [];
    const money = new Set([
      'fn_cash_game_join',
      'atomic_table_buyin',
      'fn_lightning_join',
      'fn_lightning_buy_in',
    ]);
    page.on('request', (request) => {
      const name = new URL(request.url()).pathname.split('/').at(-1)!;
      if (money.has(name)) moneyCalls.push(name);
    });
    const memberClub = process.env.E2E_LIGHTNING_CLUB_ID || '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
    const offer = diamondEntryRead(page);
    await page.goto(`clubs/${memberClub}`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:\/|\?|$)/);
    await prepareCashLobbyActions(page);
    await openLobbyGameSection(page, 'ALL');
    const all = page.getByRole('tab', { name: 'ALL', exact: true });
    await expect(all).toBeVisible({ timeout: 45_000 });
    await settleDiamondSpinsOffer(page, offer);
    await all.click();
    const row = page
      .locator(
        '[data-testid="lobby-game-row"][data-kind="cash"]:visible, .club-home__games .lt-row[data-kind="cash"]:visible'
      )
      .filter({ hasText: /PLO5/ })
      .filter({ hasText: /1\s*\/\s*2/ })
      .filter({ hasText: /Madness/ })
      .filter({ hasNotText: /Lightning/ })
      .first();
    await expect(row, 'the member lobby must expose the running ordinary Madness game').toBeVisible(
      { timeout: 45000 }
    );
    await expect(row).toContainText('50% Minimum VPIP');
    await expect(row).toContainText('Big Blind Ante');
    const details = row.getByRole('button', { name: /^Details:/ });
    if (await details.count()) await details.click();
    else await row.click();
    const panel = page
      .getByRole('dialog')
      .filter({ has: page.locator('.arena-game-card') })
      .first();
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Madness');
    await expect(panel).toContainText('50% Minimum VPIP');
    await expect(panel.getByRole('button', { name: 'Join Lightning', exact: true })).toHaveCount(0);
    const selected = new URL(page.url()).searchParams.get('game');
    expect(selected, 'the selected game must survive refresh').toBeTruthy();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await prepareCashLobbyActions(page);
    await expect(panel).toBeVisible({ timeout: 45000 });
    await expect(panel).toContainText('Madness');
    expect(new URL(page.url()).searchParams.get('game')).toBe(selected);
    expect(moneyCalls, 'reviewing or refreshing Madness must not spend chips').toEqual([]);
  });
}
