import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const CLUB_DATA_PATH = 'clubs/shark-club/data';

test.describe('Club Data production experience', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  test.beforeEach(async ({ page }, testInfo) => {
    const configuredBase = String(testInfo.project.use.baseURL || 'http://localhost:5173/');
    const base = new URL(configuredBase);
    test.skip(
      ['localhost', '127.0.0.1'].includes(base.hostname) &&
        (!process.env.SP_EMAIL || !process.env.SP_PASS),
      'local Hub authentication is not configured'
    );

    await page.goto(new URL(CLUB_DATA_PATH, configuredBase).toString());
    await page.waitForLoadState('domcontentloaded');
    await expect
      .poll(
        async () =>
          page.url().includes('/auth') ||
          (await page.getByRole('heading', { name: /Read The Room/i }).count()) > 0,
        { timeout: 60_000 }
      )
      .toBe(true);
    test.skip(page.url().includes('/auth'), 'authenticated Club Data session is not configured');
    await expect(page.getByRole('heading', { name: /Read The Room/i })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.locator('[data-page="club-data"]')).toBeVisible();
  });

  test('reflows without horizontal loss from desktop through 320px and 200% text', async ({
    page,
  }) => {
    await expect(page.getByRole('heading', { name: 'Data Integrity' })).toBeVisible();
    await expect(page.getByText('12 / 12')).toBeVisible({ timeout: 60_000 });
    for (const viewport of [
      { width: 1280, height: 900 },
      { width: 768, height: 1024 },
      { width: 390, height: 844 },
      { width: 320, height: 568 },
    ]) {
      await page.setViewportSize(viewport);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth
        )
      ).toBeLessThanOrEqual(1);
    }

    await page.evaluate(() => document.documentElement.style.setProperty('font-size', '200%'));
    await page.setViewportSize({ width: 320, height: 568 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      )
    ).toBeLessThanOrEqual(1);
    await expect(page.getByRole('button', { name: /Refresh Club Ledger/i })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Games' })).toBeVisible();
  });

  test('keeps every visible control touch-safe and every text input iOS-safe', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const shortTargets = await page
      .locator('[data-page="club-data"] button:visible')
      .evaluateAll((buttons) =>
        buttons
          .map((button) => {
            const rect = button.getBoundingClientRect();
            return {
              label: button.getAttribute('aria-label') || (button.textContent || '').trim(),
              width: rect.width,
              height: rect.height,
            };
          })
          .filter((button) => button.width < 44 || button.height < 44)
      );
    expect(shortTargets).toEqual([]);

    const undersizedInputs = await page
      .locator('[data-page="club-data"] input:visible')
      .evaluateAll((inputs) =>
        inputs
          .map((input) => ({
            label: input.getAttribute('aria-label') || input.getAttribute('placeholder') || '',
            fontSize: Number.parseFloat(getComputedStyle(input).fontSize),
          }))
          .filter((input) => input.fontSize < 16)
      );
    expect(undersizedInputs).toEqual([]);
  });

  test('supports the complete arrow-key tab flow with visible focus', async ({ page }) => {
    const games = page.getByRole('tab', { name: 'Games' });
    const players = page.getByRole('tab', { name: 'Players' });
    await games.focus();
    await page.keyboard.press('ArrowRight');
    await expect(players).toBeFocused();
    await expect(players).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowLeft');
    await expect(games).toBeFocused();
    await expect(games).toHaveAttribute('aria-selected', 'true');
  });

  test('operates sorting, pagination, players, and a verified manual refresh', async ({ page }) => {
    test.setTimeout(180_000);
    const gamesList = page.getByRole('list', { name: 'Games' });
    await expect(gamesList.getByRole('listitem').first()).toBeVisible();

    const highestFee = page.getByRole('button', { name: 'Highest Fee' });
    await highestFee.click();
    await expect(highestFee).toHaveAttribute('aria-pressed', 'true');
    await expect(gamesList.getByRole('listitem').first()).toBeVisible({ timeout: 60_000 });

    const loadMoreGames = page.getByRole('button', { name: /Load More Games/i });
    if (await loadMoreGames.isVisible()) {
      const before = (await loadMoreGames.textContent()) || '';
      await loadMoreGames.click();
      await expect
        .poll(
          async () =>
            (await loadMoreGames.count()) === 0 || (await loadMoreGames.textContent()) !== before,
          { timeout: 60_000 }
        )
        .toBe(true);
    }

    await page.getByRole('tab', { name: 'Players' }).click();
    const playersList = page.getByRole('list', { name: 'Players' });
    await expect(playersList.getByRole('listitem').first()).toBeVisible({ timeout: 60_000 });
    const biggestLosers = page.getByRole('button', { name: 'Biggest losers' });
    await biggestLosers.click();
    await expect(biggestLosers).toHaveAttribute('aria-pressed', 'true');
    await expect(playersList.getByRole('listitem').first()).toBeVisible({ timeout: 60_000 });
    const loadMorePlayers = page.getByRole('button', { name: /Load More Players/i });
    let expandedPlayerCount = '';
    if (await loadMorePlayers.isVisible()) {
      const before = (await loadMorePlayers.textContent()) || '';
      await loadMorePlayers.click();
      await expect
        .poll(async () => (await loadMorePlayers.textContent()) || '', { timeout: 60_000 })
        .not.toBe(before);
      expandedPlayerCount =
        ((await loadMorePlayers.textContent()) || '').match(/- ([\d,]+) Of/i)?.[1] || '';
    }

    if (expandedPlayerCount) {
      const biggestWinners = page.getByRole('button', { name: 'Biggest winners' });
      await biggestWinners.click();
      await expect(biggestWinners).toHaveAttribute('aria-pressed', 'true');
      await expect(loadMorePlayers).toContainText('- 100 Of', { timeout: 60_000 });
      await biggestLosers.click();
      await expect(biggestLosers).toHaveAttribute('aria-pressed', 'true');
      await expect(loadMorePlayers).toContainText('- 100 Of', { timeout: 60_000 });
      await loadMorePlayers.click();
      await expect(loadMorePlayers).toContainText(`- ${expandedPlayerCount} Of`, {
        timeout: 60_000,
      });
    }

    const refresh = page.getByRole('button', { name: /Refresh Club Ledger/i });
    await refresh.click();
    await expect(refresh).toBeEnabled({ timeout: 60_000 });
    await expect(page.getByRole('heading', { name: 'Data Integrity' })).toBeVisible();
    await expect(playersList.getByRole('listitem').first()).toBeVisible();
    if (expandedPlayerCount) {
      await expect(loadMorePlayers).toContainText(`- ${expandedPlayerCount} Of`);
    }
  });

  test('keeps verified rows through the 60-second recovery heartbeat', async ({ page }) => {
    test.setTimeout(180_000);
    const gamesList = page.getByRole('list', { name: 'Games' });
    const firstRow = gamesList.getByRole('listitem').first();
    await expect(firstRow).toBeVisible();
    const identity = (await firstRow.textContent()) || '';
    const loadMore = page.getByRole('button', { name: /Load More Games/i });
    let expandedCount = '';
    if (await loadMore.isVisible()) {
      const before = (await loadMore.textContent()) || '';
      await loadMore.click();
      await expect
        .poll(async () => (await loadMore.textContent()) || '', { timeout: 60_000 })
        .not.toBe(before);
      expandedCount = ((await loadMore.textContent()) || '').match(/- ([\d,]+) Of/i)?.[1] || '';
    }

    await page.waitForTimeout(65_000);

    await expect(page.getByText(/Could Not Load Club Data\./i)).toHaveCount(0);
    await expect(gamesList.getByRole('listitem').first()).toContainText(identity.slice(0, 12));
    await expect(page.getByText(/Showing [\d,]+ Of [\d,]+ Games/i)).toBeVisible();
    if (expandedCount) await expect(loadMore).toContainText(`- ${expandedCount} Of`);
  });

  test('passes axe and remains operable in forced colors with reduced motion', async ({ page }) => {
    const normal = await new AxeBuilder({ page }).include('[data-page="club-data"]').analyze();
    expect(
      normal.violations.filter((violation) =>
        ['serious', 'critical'].includes(violation.impact || '')
      )
    ).toEqual([]);

    await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
    await expect(page.getByRole('button', { name: /Refresh Club Ledger/i })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Games' })).toBeVisible();
  });
});
