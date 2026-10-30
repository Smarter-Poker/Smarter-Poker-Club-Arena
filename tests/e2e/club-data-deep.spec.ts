import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { isDeepStrictEqual } from 'node:util';

// #6895 made clubs/:clubId/data the PokerBros-style everyday screen and moved
// this full operator report (and its Simple/Advanced modes) to data/advanced.
const CLUB_DATA_PATH = 'clubs/shark-club/data/advanced';
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

/** The count a "Load More Players - N Of M" label prints, or null. */
export function loadMorePlayerCount(label: string | null): number | null {
  const match = /-\s*([\d,]+)\s+Of\b/i.exec(label || '');
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

/** Returning to a sort the operator already expanded paints that sort's cached
 * window (ClubDataPage keeps an expanded ledger across revalidation and caches
 * it per sort), so the label is either the fresh first page or a window that
 * contains it. Either is correct; anything smaller is not. */
async function returnedSortWindow(
  loadMore: ReturnType<Page['getByRole']>,
  firstPage: ObservedPlayerPage
): Promise<number> {
  let shown: number | null = null;
  await expect
    .poll(
      async () => {
        shown = loadMorePlayerCount(await loadMore.textContent());
        return shown !== null && shown >= firstPage.rows.length;
      },
      { timeout: 60_000 }
    )
    .toBe(true);
  return shown!;
}

/** Load More from a restored window continues from that window's own cursor,
 * which this test did not observe, so bind to the sort and a non-null cursor. */
async function observeContinuation(
  page: Page,
  sort: 'winners' | 'losers' | 'hands',
  action: () => Promise<unknown>
): Promise<ObservedPlayerPage> {
  const [request] = await Promise.all([
    page.waitForRequest(
      (candidate) => {
        if (
          candidate.method() !== 'POST' ||
          !candidate.url().includes('/rest/v1/rpc/ca_club_player_page')
        )
          return false;
        const body = candidate.postDataJSON();
        return body?.p_sort === sort && body.p_cursor !== null && body.p_cursor !== undefined;
      },
      { timeout: 60_000 }
    ),
    action(),
  ]);
  const response = await request.response();
  expect(response, 'the requested player page did not return').not.toBeNull();
  expect(response!.ok(), 'the requested player page was refused').toBe(true);
  const result = (await response!.json()) as ObservedPlayerPage;
  playerPageUnion(result);
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
  const workspace = page.getByRole('heading', { name: 'Club Data', exact: true });
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
  // Modes persist for this actor; select the mode whose behavior we verify.
  await page.getByRole('button', { name: 'Simple', exact: true }).click();
  await expect(page.locator('[data-club-data-mode="simple"]')).toBeVisible();
  await page.getByRole('button', { name: /^Advanced(?: \([\d,]+\))?$/ }).click();
  await expect(page.getByRole('heading', { name: 'Read The Room', exact: true })).toBeVisible();
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
      if (request.method() !== 'POST' || !request.url().includes('/rest/v1/rpc/ca_club_player_'))
        return;
      try {
        const payload = request.postDataJSON();
        notePlayerPage({
          phase: 'requested',
          rpc: new URL(request.url()).pathname.split('/').pop(),
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
        !response.url().includes('/rest/v1/rpc/ca_club_player_')
      )
        return;
      try {
        const request = response.request().postDataJSON();
        const payload = await response.json();
        notePlayerPage({
          phase: 'response',
          rpc: new URL(response.url()).pathname.split('/').pop(),
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
          playerCount: payload?.player_count,
          errorCode: payload?.code,
        });
      } catch {
        notePlayerPage({ status: response.status(), unreadableResponse: true });
      }
    });
    page.on('requestfailed', (request) => {
      if (request.url().includes('/rest/v1/rpc/ca_club_player_')) {
        notePlayerPage({
          rpc: new URL(request.url()).pathname.split('/').pop(),
          transportFailure: request.failure()?.errorText || 'unknown',
        });
      }
    });
    const playersList = page.getByRole('list', { name: 'Players' });
    try {
      await page.getByRole('tab', { name: 'Players' }).click();
      await expect(playersList.getByRole('listitem').first()).toBeVisible({ timeout: 60_000 });
    } catch (error) {
      await testInfo.attach('player-first-load-receipts', {
        body: JSON.stringify({ receipts: playerPageReceipts }, null, 2),
        contentType: 'application/json',
      });
      throw error;
    }
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
      await returnedSortWindow(loadMorePlayers, winners);
      firstLosers = await observePlayerPage(page, 'losers', null, () => biggestLosers.click());
      await expect(biggestLosers).toHaveAttribute('aria-pressed', 'true');
      await expect(playersList).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
      const returnedLosers = await returnedSortWindow(loadMorePlayers, firstLosers);
      if (returnedLosers === firstLosers.rows.length) {
        const continuation = await observePlayerPage(page, 'losers', firstLosers.next_cursor, () =>
          loadMorePlayers.click()
        );
        expandedPlayerCount = playerPageUnion(firstLosers, continuation).length;
        expect(expandedPlayerCount).toBeGreaterThan(firstLosers.rows.length);
        await expect(loadMorePlayers).toContainText(
          `- ${expandedPlayerCount.toLocaleString()} Of`,
          { timeout: 60_000 }
        );
      } else if (await loadMorePlayers.isVisible()) {
        // The restored window continues from its own cursor and must grow.
        const continuation = await observeContinuation(page, 'losers', () =>
          loadMorePlayers.click()
        );
        expect(continuation.rows.length, 'the continuation returned no player').toBeGreaterThan(0);
        await expect
          .poll(async () => loadMorePlayerCount(await loadMorePlayers.textContent()) ?? 0, {
            timeout: 60_000,
          })
          .toBeGreaterThan(returnedLosers);
      }
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

// Read-only acceptance for the repaired page-channel admission/recovery owner.
// Financial action and report contracts already have their own certificates.
test('keeps Cashier, Players and Club Data realtime connected in both modes and viewport sizes', async ({
  page,
}, testInfo) => {
  test.setTimeout(6 * (60_000 + 80_000 + 70_000) + 60_000);
  const base = String(testInfo.project.use.baseURL);
  const surfaces = [
    {
      path: 'cashier',
      root: '[data-cashier-mode]',
      prefixes: ['realtime:cashier-member-authority:'],
      button: true,
    },
    {
      path: 'members',
      root: '[data-players-mode]',
      prefixes: [
        'realtime:club-members-sync-',
        'realtime:club-roster-wallet:',
        'realtime:club-members-audit-',
      ],
      button: true,
    },
    {
      // #6895: these realtime channels belong to the full report at data/advanced;
      // the everyday screen at data re-reads on a timer and opens none of them.
      path: 'data/advanced',
      root: '[data-club-data-mode]',
      prefixes: [
        'realtime:club-data-tables-',
        'realtime:club-data-tournaments-',
        'realtime:club-data-invoices-',
        'realtime:club-data-members-',
      ],
      button: true,
    },
  ];
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const surface of surfaces) {
      const joins = new Map<string, string>();
      const filters = new Map<string, Array<Record<string, unknown>>>();
      const acknowledged = new Set<string>();
      const interruptions: string[] = [];
      let observing = false;
      const matches = (topic: string) =>
        surface.prefixes.some((prefix) => topic.startsWith(prefix));
      const onSocket = (socket: import('@playwright/test').WebSocket) => {
        const decode = (payload: string | Buffer) => {
          const value = JSON.parse(String(payload));
          return Array.isArray(value)
            ? { ref: value[1], topic: value[2], event: value[3], payload: value[4] }
            : value;
        };
        const topics = new Set<string>();
        socket.on('framesent', (frame) => {
          try {
            const message = decode(frame.payload);
            if (!matches(String(message.topic))) return;
            if (message.event === 'phx_leave') {
              acknowledged.delete(message.topic);
              if (observing) interruptions.push(message.topic + ': binding retired');
              return;
            }
            if (message.event !== 'phx_join') return;
            if (observing) interruptions.push(message.topic + ': join restarted');
            topics.add(message.topic);
            joins.set(message.topic, String(message.ref));
            filters.set(message.topic, message.payload?.config?.postgres_changes ?? []);
            acknowledged.delete(message.topic);
          } catch {
            /* Non-JSON frames cannot acknowledge a join. */
          }
        });
        socket.on('framereceived', (frame) => {
          try {
            const message = decode(frame.payload);
            if (!matches(String(message.topic))) return;
            if (message.event === 'phx_reply' && joins.get(message.topic) === String(message.ref)) {
              const expected = filters.get(message.topic) ?? [];
              const received = message.payload?.response?.postgres_changes;
              const bindingsMatch = expected.every(
                (filter) =>
                  Array.isArray(received) &&
                  received.some((binding) =>
                    Object.entries(filter).every(([key, value]) => binding[key] === value)
                  )
              );
              if (message.payload?.status === 'ok' && bindingsMatch)
                acknowledged.add(message.topic);
              else if (observing)
                interruptions.push(message.topic + ': join refused or bindings mismatched');
            }
            if (message.event === 'phx_error' || message.event === 'phx_close') {
              acknowledged.delete(message.topic);
              if (observing) interruptions.push(message.topic + ': ' + message.event);
            }
          } catch {
            /* Non-JSON frames cannot acknowledge a join. */
          }
        });
        socket.on('close', () => {
          for (const topic of topics) acknowledged.delete(topic);
          if (observing && topics.size) interruptions.push('socket closed');
        });
      };
      page.on('websocket', onSocket);
      try {
        await page.goto(new URL('clubs/shark-club/' + surface.path, base).toString());
        await expect(page.locator(surface.root)).toBeVisible({ timeout: 60_000 });
        // The previous surface visit may have saved Advanced. Normalize through
        // its real control before observing the unchanged two-mode feed proof.
        if (
          (await page.locator(surface.root).getAttribute(surface.root.slice(1, -1))) !== 'simple'
        ) {
          await page
            .getByRole(surface.button ? 'button' : 'radio', { name: 'Simple', exact: true })
            .click();
        }
        await expect(page.locator(surface.root)).toHaveAttribute(
          surface.root.slice(1, -1),
          'simple',
          { timeout: 60_000 }
        );
        const allJoined = () =>
          surface.prefixes.every((prefix) =>
            [...acknowledged].some((topic) => topic.startsWith(prefix))
          );
        await expect
          .poll(allJoined, {
            timeout: 80_000,
            message: surface.path + ' requires actual join acknowledgments',
          })
          .toBe(true);
        observing = true;
        const observeMode = async (mode: string) => {
          await expect(page.locator(surface.root)).toHaveAttribute(surface.root.slice(1, -1), mode);
          const start = Date.now();
          // 35 seconds in each mode spans multiple native SDK heartbeats and
          // the existing 60-second report refresh across the two-mode window.
          await page.waitForTimeout(35_000);
          expect(allJoined(), surface.path + ' lost an acknowledged feed').toBe(true);
          expect(interruptions, surface.path + ' interrupted during observation').toEqual([]);
          const geometry = await page.evaluate(() => ({
            width: document.documentElement.clientWidth,
            scroll: document.documentElement.scrollWidth,
          }));
          expect(geometry.scroll).toBe(geometry.width);
          await testInfo.attach(surface.path + '-' + width + '-' + mode + '-realtime', {
            body: JSON.stringify({
              width,
              mode,
              observedMs: Date.now() - start,
              acknowledgedTopics: [...acknowledged],
              interruptions,
              geometry,
            }),
            contentType: 'application/json',
          });
        };
        await observeMode('simple');
        await page
          .getByRole(surface.button ? 'button' : 'radio', { name: /^Advanced(?: \([\d,]+\))?$/ })
          .click();
        await observeMode('advanced');
      } finally {
        observing = false;
        page.off('websocket', onSocket);
      }
    }
  }
});
