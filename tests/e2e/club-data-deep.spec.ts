import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { isDeepStrictEqual } from 'node:util';

const CLUB_DATA_PATH = 'clubs/shark-club/data';
type ClubDataAccess = 'authorized' | 'restricted';

interface ObservedPlayerPage {
  rows: Array<{ user_id: string; hands?: number }>;
  next_cursor: Record<string, unknown> | null;
}

/** The live ranking can move between requests. Bind the rendered count to the
 * actual identities returned for this query, including cross-page duplicates. */
export function playerPageUnion(...pages: ObservedPlayerPage[]): string[] {
  const union = new Set<string>();
  for (const page of pages) {
    if (!page || !Array.isArray(page.rows)) throw new Error('Player page has no rows');
    const ids = page.rows.map((row) => row?.user_id);
    if (ids.some((id) => typeof id !== 'string' || !id))
      throw new Error('Player page has an invalid identity');
    if (new Set(ids).size !== ids.length) throw new Error('Player page repeated an identity');
    for (const id of ids) union.add(id);
  }
  return [...union];
}

async function observePlayerPage(
  page: Page,
  sort: 'winners' | 'losers' | 'hands',
  cursor: Record<string, unknown> | null,
  action: () => Promise<unknown>
): Promise<ObservedPlayerPage> {
  // Capture the request before the gesture, so an older response or another
  // sort's background read cannot certify this page.
  const [request] = await Promise.all([
    page.waitForRequest(
      (candidate) => {
        if (
          candidate.method() !== 'POST' ||
          !candidate.url().includes('/rest/v1/rpc/ca_club_player_page')
        )
          return false;
        const body = candidate.postDataJSON();
        return body?.p_sort === sort && isDeepStrictEqual(body.p_cursor, cursor);
      },
      { timeout: 60_000 }
    ),
    action(),
  ]);
  const response = await request.response();
  expect(response, 'the requested player page did not return').not.toBeNull();
  expect(response!.ok(), 'the requested player page was refused').toBe(true);
  const result = (await response!.json()) as ObservedPlayerPage;
  playerPageUnion(result); // Validate identities before using them as an oracle.
  return result;
}

async function openClubData(page: Page, testInfo: TestInfo): Promise<ClubDataAccess> {
  const configuredBase = String(testInfo.project.use.baseURL || 'http://localhost:5173/');
  const base = new URL(configuredBase);
  test.skip(
    ['localhost', '127.0.0.1'].includes(base.hostname) &&
      (!process.env.SP_EMAIL || !process.env.SP_PASS),
    'local Hub authentication is not configured'
  );

  await page.goto(new URL(CLUB_DATA_PATH, configuredBase).toString());
  await page.waitForLoadState('domcontentloaded');
  const gate = page.getByRole('heading', { name: /This Tool Is Restricted/i });
  const workspace = page.getByRole('heading', { name: /Read The Room/i });
  await expect
    .poll(
      async () =>
        page.url().includes('/auth') || (await workspace.count()) > 0 || (await gate.count()) > 0,
      { timeout: 60_000 }
    )
    .toBe(true);
  test.skip(page.url().includes('/auth'), 'authenticated Club Data session is not configured');

  if ((await gate.count()) > 0) {
    await expect(gate).toBeVisible();
    await expect(
      page.getByText(/Current Club Role Does Not Include Finance Access/i)
    ).toBeVisible();
    return 'restricted';
  }

  await expect(workspace).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-page="club-data"]')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Games' }).getByRole('listitem').first()).toBeVisible(
    {
      timeout: 60_000,
    }
  );
  return 'authorized';
}

async function requireAuthorizedClubData(page: Page, testInfo: TestInfo): Promise<void> {
  const access = await openClubData(page, testInfo);
  test.skip(
    access === 'restricted',
    'the dedicated production account is a normal member without club-finance access'
  );
}

test.describe('Club Data production experience', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  test('renders the exact role-scoped Club Data decision', async ({ page }, testInfo) => {
    const access = await openClubData(page, testInfo);
    if (access === 'restricted') {
      await expect(page.locator('[data-page="club-data"]')).toHaveCount(0);
      return;
    }
    await expect(page.getByRole('heading', { name: 'Data Integrity' })).toBeVisible();
  });

  test('reflows without horizontal loss from desktop through 320px and 200% text', async ({
    page,
  }, testInfo) => {
    await requireAuthorizedClubData(page, testInfo);
    await expect(page.getByRole('heading', { name: 'Data Integrity' })).toBeVisible();
    await expect(page.getByText('12 / 12')).toBeVisible({ timeout: 60_000 });
    for (const viewport of [
      { width: 1280, height: 900 },
      { width: 768, height: 1024 },
      { width: 393, height: 852 },
      { width: 390, height: 844 },
      { width: 320, height: 568 },
    ]) {
      await page.setViewportSize(viewport);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth
        )
      ).toBeLessThanOrEqual(1);
      expect(
        await page
          .locator('[data-page="club-data"]')
          .evaluate((root) => root.scrollWidth - root.clientWidth)
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

  test('keeps every visible control touch-safe and every text input iOS-safe', async ({
    page,
  }, testInfo) => {
    await requireAuthorizedClubData(page, testInfo);
    await page.setViewportSize({ width: 390, height: 844 });
    const shortTargets = await page
      .locator('[data-page="club-data"] button:visible')
      .evaluateAll((buttons) =>
        buttons
          .map((button) => {
            const rect = button.getBoundingClientRect();
            const target = getComputedStyle(button, '::after');
            const targetWidth = Number.parseFloat(target.width);
            const targetHeight = Number.parseFloat(target.height);
            return {
              label: button.getAttribute('aria-label') || (button.textContent || '').trim(),
              width: Math.max(rect.width, Number.isFinite(targetWidth) ? targetWidth : 0),
              height: Math.max(rect.height, Number.isFinite(targetHeight) ? targetHeight : 0),
            };
          })
          .filter((button) => button.width < 44 || button.height < 44)
      );
    expect(shortTargets).toEqual([]);

    const undersizedInputs = await page
      .locator('[data-page="club-data"] input:visible, [data-page="club-data"] select:visible')
      .evaluateAll((controls) =>
        controls
          .map((control) => ({
            label: control.getAttribute('aria-label') || control.getAttribute('placeholder') || '',
            fontSize: Number.parseFloat(getComputedStyle(control).fontSize),
          }))
          .filter((control) => control.fontSize < 16)
      );
    expect(undersizedInputs).toEqual([]);
  });

  test('supports the complete arrow-key tab flow with visible focus', async ({
    page,
  }, testInfo) => {
    await requireAuthorizedClubData(page, testInfo);
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

  test('operates sorting, pagination, players, and a verified manual refresh', async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    await requireAuthorizedClubData(page, testInfo);
    const gamesList = page.getByRole('list', { name: 'Games' });
    await expect(gamesList.getByRole('listitem').first()).toBeVisible();

    const highestFee = page.getByRole('button', { name: 'Highest Fee' });
    await highestFee.click();
    await expect(highestFee).toHaveAttribute('aria-pressed', 'true');
    await expect(gamesList.getByRole('listitem').first()).toBeVisible({ timeout: 60_000 });
    // The preceding rows remain visible while the ranked ledger is being
    // replaced. Visibility alone therefore does not mean the new sort is
    // ready, and clicking its disabled continuation can consume this test's
    // entire timeout without identifying the failed read.
    await expect(gamesList).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });

    const loadMoreGames = page.getByRole('button', { name: /Load More Games/i });
    await expect(loadMoreGames).toBeVisible({ timeout: 60_000 });
    await expect(loadMoreGames).toBeEnabled({ timeout: 60_000 });
    const before = (await loadMoreGames.textContent()) || '';
    await loadMoreGames.click();
    await expect
      .poll(
        async () =>
          (await loadMoreGames.count()) === 0 || (await loadMoreGames.textContent()) !== before,
        { timeout: 60_000 }
      )
      .toBe(true);

    // Keep a bounded, identity-free receipt if player pagination stalls. The
    // failure screenshot alone cannot distinguish a refused/slow request from
    // a successful page that the UI later discarded.
    const playerPageReceipts: Array<Record<string, unknown>> = [];
    const notePlayerPage = (receipt: Record<string, unknown>) => {
      playerPageReceipts.push({ at: new Date().toISOString(), ...receipt });
      if (playerPageReceipts.length > 25) playerPageReceipts.shift();
    };
    page.on('request', (request) => {
      if (
        request.method() !== 'POST' ||
        !request.url().includes('/rest/v1/rpc/ca_club_player_page')
      )
        return;
      try {
        const payload = request.postDataJSON();
        notePlayerPage({
          phase: 'requested',
          sort: payload?.p_sort,
          continuation: Boolean(payload?.p_cursor),
          limit: payload?.p_limit,
        });
      } catch {
        notePlayerPage({ phase: 'requested', unreadableRequest: true });
      }
    });
    page.on('response', async (response) => {
      if (
        response.request().method() !== 'POST' ||
        !response.url().includes('/rest/v1/rpc/ca_club_player_page')
      )
        return;
      try {
        const request = response.request().postDataJSON();
        const payload = await response.json();
        notePlayerPage({
          phase: 'response',
          status: response.status(),
          sort: request?.p_sort,
          continuation: Boolean(request?.p_cursor),
          limit: request?.p_limit,
          rows: Array.isArray(payload?.rows) ? payload.rows.length : null,
          uniqueRows: Array.isArray(payload?.rows)
            ? new Set(payload.rows.map((row: { user_id?: string }) => row.user_id)).size
            : null,
          hasMore: payload?.has_more,
          hasCursor: Boolean(payload?.next_cursor),
          errorCode: payload?.code,
        });
      } catch {
        notePlayerPage({ status: response.status(), unreadableResponse: true });
      }
    });
    page.on('requestfailed', (request) => {
      if (request.url().includes('/rest/v1/rpc/ca_club_player_page')) {
        notePlayerPage({ transportFailure: request.failure()?.errorText || 'unknown' });
      }
    });
    await page.getByRole('tab', { name: 'Players' }).click();
    const playersList = page.getByRole('list', { name: 'Players' });
    await expect(playersList.getByRole('listitem').first()).toBeVisible({ timeout: 60_000 });
    const biggestLosers = page.getByRole('button', { name: 'Biggest losers' });
    let firstLosers = await observePlayerPage(page, 'losers', null, () => biggestLosers.click());
    await expect(biggestLosers).toHaveAttribute('aria-pressed', 'true');
    await expect(playersList.getByRole('listitem').first()).toBeVisible({ timeout: 60_000 });
    await expect(playersList).toHaveAttribute('aria-busy', 'false');
    const loadMorePlayers = page.getByRole('button', { name: /Load More Players/i });
    let expandedPlayerCount = 0;
    if (await loadMorePlayers.isVisible()) {
      await expect(loadMorePlayers).toContainText(
        `- ${firstLosers.rows.length.toLocaleString()} Of`
      );
      expect(firstLosers.next_cursor, 'the first page has no continuation identity').not.toBeNull();
      const before = (await loadMorePlayers.textContent()) || '';
      try {
        const continuation = await observePlayerPage(page, 'losers', firstLosers.next_cursor, () =>
          loadMorePlayers.click()
        );
        expandedPlayerCount = playerPageUnion(firstLosers, continuation).length;
        expect(expandedPlayerCount, 'the continuation added no new player').toBeGreaterThan(
          firstLosers.rows.length
        );
        await expect(loadMorePlayers).toContainText(
          `- ${expandedPlayerCount.toLocaleString()} Of`,
          {
            timeout: 60_000,
          }
        );
      } catch (error) {
        await testInfo.attach('player-pagination-receipts', {
          body: JSON.stringify({ before, receipts: playerPageReceipts }, null, 2),
          contentType: 'application/json',
        });
        throw error;
      }
    }

    if (expandedPlayerCount) {
      const biggestWinners = page.getByRole('button', { name: 'Biggest winners' });
      const winners = await observePlayerPage(page, 'winners', null, () => biggestWinners.click());
      await expect(biggestWinners).toHaveAttribute('aria-pressed', 'true');
      await expect(loadMorePlayers).toContainText(`- ${winners.rows.length.toLocaleString()} Of`, {
        timeout: 60_000,
      });
      firstLosers = await observePlayerPage(page, 'losers', null, () => biggestLosers.click());
      await expect(biggestLosers).toHaveAttribute('aria-pressed', 'true');
      await expect(loadMorePlayers).toContainText(
        `- ${firstLosers.rows.length.toLocaleString()} Of`,
        {
          timeout: 60_000,
        }
      );
      const continuation = await observePlayerPage(page, 'losers', firstLosers.next_cursor, () =>
        loadMorePlayers.click()
      );
      expandedPlayerCount = playerPageUnion(firstLosers, continuation).length;
      expect(expandedPlayerCount).toBeGreaterThan(firstLosers.rows.length);
      await expect(loadMorePlayers).toContainText(`- ${expandedPlayerCount.toLocaleString()} Of`, {
        timeout: 60_000,
      });
    }

    const refresh = page.getByRole('button', { name: /Refresh Club Ledger/i });
    await refresh.click();
    await expect(refresh).toBeEnabled({ timeout: 60_000 });
    await expect(page.getByRole('heading', { name: 'Data Integrity' })).toBeVisible();
    await expect(playersList.getByRole('listitem').first()).toBeVisible();
    if (expandedPlayerCount) {
      // refreshAll calls loadPlayers(true); preserveExpandedClubDataRows keeps
      // this exact expanded window while re-reading the first page and totals.
      // Unlike switching sorts above, refresh must not reset its cardinality.
      await expect(loadMorePlayers).toContainText(`- ${expandedPlayerCount.toLocaleString()} Of`);
    }

    // The live union projection belongs to the union-root game scope while
    // this route is scoped to the member club. The hands reader must bridge
    // those scopes, and the virtual list must expose rows beyond its first
    // mounted window rather than collapsing its measured spacer in flexbox.
    const mostHands = page.getByRole('button', { name: 'Most Hands' });
    const handsPage = await observePlayerPage(page, 'hands', null, () => mostHands.click());
    expect(
      handsPage.rows.some((row) => Number.isSafeInteger(row.hands) && Number(row.hands) > 0),
      'the club-scoped player projection returned no recorded hands'
    ).toBe(true);
    await expect(mostHands).toHaveAttribute('aria-pressed', 'true');
    await expect(playersList.getByRole('listitem').first()).toBeVisible({ timeout: 60_000 });

    const mountedStart = await playersList
      .getByRole('listitem')
      .evaluateAll((rows) =>
        Math.max(...rows.map((row) => Number(row.getAttribute('aria-posinset') || 0)))
      );
    expect(mountedStart).toBeLessThan(handsPage.rows.length);
    await playersList.evaluate((list) => {
      list.scrollTop = list.scrollHeight;
      list.dispatchEvent(new Event('scroll'));
    });
    await expect
      .poll(
        () =>
          playersList
            .getByRole('listitem')
            .evaluateAll((rows) =>
              Math.max(...rows.map((row) => Number(row.getAttribute('aria-posinset') || 0)))
            ),
        { timeout: 60_000 }
      )
      .toBeGreaterThanOrEqual(handsPage.rows.length);
  });

  test('keeps verified rows through the 60-second recovery heartbeat', async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    await requireAuthorizedClubData(page, testInfo);
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
    await expect(page.getByText(/Loaded [\d,]+ Of [\d,]+ Games/i)).toBeVisible();
    if (expandedCount) await expect(loadMore).toContainText(`- ${expandedCount} Of`);
  });

  test('passes axe and remains operable in forced colors with reduced motion', async ({
    page,
  }, testInfo) => {
    await requireAuthorizedClubData(page, testInfo);
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
