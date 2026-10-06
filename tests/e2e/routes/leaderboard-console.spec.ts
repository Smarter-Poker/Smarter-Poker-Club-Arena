import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// Read-only production coverage. The post-deploy workflow already runs routes/.
// Never publish a program or invoke settlement against a real account here.
//
// Evidence this spec leaves on every run: one LEADERBOARD_PERF line in the job
// log (timings, bytes, counts; names and paths only, never query strings or
// message text). Full-page pictures of the signed-in board are written to the
// test output directory, which the workflow uploads only when the job fails or
// is cancelled.

// The one exclusion the house pattern allows (admin.spec.ts): the browser
// reports a failed subresource on its own; it is not the application speaking.
const SUBRESOURCE = /^Failed to load resource\b|net::ERR_|ERR_BLOCKED_BY_CLIENT/;
const CLUB_ARENA_FILES = '/hub/club-arena/';
const BOARD = '[data-arena-surface="leaderboard-console"]';
const GLOBAL_WEEKLY_PROFIT_CACHE_KEY = 'lb_cache_v2_global_profit_weekly_0';
const LEADERBOARD_CACHE_TTL_MS = 5 * 60 * 1000;

interface Observed {
  consoleErrors: string[];
  pageErrors: number;
  failedArenaFiles: string[];
  otherBadResponses: string[];
  failedOtherRequests: string[];
}

function observe(page: Page): Observed {
  const observed: Observed = {
    consoleErrors: [],
    pageErrors: 0,
    failedArenaFiles: [],
    otherBadResponses: [],
    failedOtherRequests: [],
  };
  page.on('console', (message) => {
    if (message.type() === 'error') observed.consoleErrors.push(message.text());
  });
  page.on('pageerror', () => {
    observed.pageErrors += 1;
  });
  page.on('response', (response) => {
    if (response.status() < 400) return;
    const url = new URL(response.url());
    const where = `${response.status()} ${url.host}${url.pathname}`;
    if (url.pathname.startsWith(CLUB_ARENA_FILES)) observed.failedArenaFiles.push(where);
    else observed.otherBadResponses.push(where);
  });
  page.on('requestfailed', (request) => {
    // A superseded read or a navigation aborts by design; that is not a miss.
    if (/ERR_ABORTED/.test(request.failure()?.errorText || '')) return;
    const url = new URL(request.url());
    if (url.pathname.startsWith(CLUB_ARENA_FILES)) {
      observed.failedArenaFiles.push(`failed ${url.host}${url.pathname}`);
    } else {
      observed.failedOtherRequests.push(`failed ${url.host}${url.pathname}`);
    }
  });
  return observed;
}

async function expectNoSeriousAxeFindings(page: Page, state: string): Promise<void> {
  const results = await new AxeBuilder({ page }).include(BOARD).analyze();
  expect(
    results.violations
      .filter((violation) => ['serious', 'critical'].includes(violation.impact || ''))
      .map((violation) => `${violation.id} (${violation.nodes.length})`),
    `${state}: serious or critical accessibility findings on the leaderboard console`
  ).toEqual([]);
}

async function expectLeaderboardNamesToStartEachWordWithACapital(
  page: Page,
  selector: string,
  state: string
): Promise<void> {
  const names = await page
    .locator(`${BOARD} ${selector}`)
    .evaluateAll((elements) =>
      elements.map((element) => element.firstChild?.textContent?.trim() || '').filter(Boolean)
    );
  const lowercaseWordStarts = names.flatMap((name) =>
    [...name.matchAll(/(?:^|[^A-Za-z0-9])([a-z])/g)].map((match) => match[1])
  );
  expect(lowercaseWordStarts, `${state}: every name word starts with a capital`).toEqual([]);
}

for (const width of [393, 1440]) {
  test(`Leaderboard Console Is Painted And Reachable At ${width}px`, async ({ page }, testInfo) => {
    const keep = (name: string) =>
      page.screenshot({
        path: testInfo.outputPath(`leaderboard-${name}-${width}.png`),
        fullPage: true,
      });
    const observed = observe(page);
    await page.addInitScript(() => {
      const metrics = { lcp: null as number | null, cls: 0 };
      (window as unknown as { __lbMetrics: typeof metrics }).__lbMetrics = metrics;
      performance.setResourceTimingBufferSize(1000);
      new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const last = entries[entries.length - 1];
        if (last) metrics.lcp = last.startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as (PerformanceEntry & {
          hadRecentInput: boolean;
          value: number;
        })[]) {
          if (!entry.hadRecentInput) metrics.cls += entry.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
    });

    await page.setViewportSize({ width, height: 900 });
    const started = Date.now();
    await page.goto('leaderboard');
    const board = page.locator(BOARD);
    await expect(board).toBeVisible({ timeout: 30000 });
    const consoleVisibleMs = Date.now() - started;
    await expect(board.getByRole('tabpanel')).toHaveAttribute('aria-busy', 'false', {
      timeout: 30000,
    });
    const firstReadyMs = Date.now() - started;
    // The painted art is fetched by CSS once the console renders; give the
    // three default slices time to finish before reading the timeline.
    await page.waitForFunction(
      () =>
        performance
          .getEntriesByType('resource')
          .filter((entry) =>
            /\/spade-console-v1\/(top|mid|bottom-foot)\.png$/.test(new URL(entry.name).pathname)
          ).length >= 3,
      null,
      { timeout: 15000 }
    );
    const firstLoad = await page.evaluate(() => {
      const navigation = performance.getEntriesByType('navigation')[0] as
        | PerformanceNavigationTiming
        | undefined;
      const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      const file = (entry: PerformanceResourceTiming) =>
        new URL(entry.name).pathname.split('/').pop() || '';
      const pick = (pattern: RegExp) =>
        resources
          .filter((entry) => pattern.test(new URL(entry.name).pathname))
          .map((entry) => [file(entry), entry.transferSize, Math.round(entry.duration)] as const);
      const metrics = (window as unknown as { __lbMetrics?: { lcp: number | null; cls: number } })
        .__lbMetrics;
      return {
        domContentLoadedMs: navigation ? Math.round(navigation.domContentLoadedEventEnd) : null,
        loadMs: navigation ? Math.round(navigation.loadEventEnd) : null,
        lcpMs:
          metrics && typeof metrics.lcp === 'number' && Number.isFinite(metrics.lcp)
            ? Math.round(metrics.lcp)
            : null,
        cls: metrics ? Number(metrics.cls.toFixed(3)) : null,
        resourceCount: resources.length,
        transferBytes: resources.reduce((sum, entry) => sum + (entry.transferSize || 0), 0),
        leaderboardChunks: pick(/\/Leaderboard(Page|Service)-[^/]+\.(js|css)$/),
        consoleArt: pick(/\/spade-console-v1\/[^/]+\.png$/),
        dataReads: resources
          .filter((entry) => /\/rest\/v1\//.test(new URL(entry.name).pathname))
          .map(
            (entry) =>
              [
                new URL(entry.name).pathname.replace(/^.*\/rest\/v1\//, ''),
                Math.round(entry.duration),
              ] as const
          ),
      };
    });
    // Broad guardrails derived from healthy production observations. They catch
    // a severe regression without treating small runner/network variance as a
    // failure.
    expect(firstReadyMs, 'the first usable board should load within 12 seconds').toBeLessThan(
      12_000
    );
    expect(
      firstLoad.lcpMs,
      'the browser must report a largest-contentful-paint entry'
    ).not.toBeNull();
    expect(firstLoad.lcpMs ?? 0, 'the LCP measurement must be greater than zero').toBeGreaterThan(
      0
    );
    expect(
      firstLoad.lcpMs ?? Number.POSITIVE_INFINITY,
      'the board should paint its main content within 8 seconds'
    ).toBeLessThan(8_000);
    if (firstLoad.cls !== null) {
      expect(firstLoad.cls, 'the board should avoid disruptive layout shifts').toBeLessThan(0.15);
    }
    expect(
      firstLoad.transferBytes,
      'the full leaderboard route should stay below 12 MiB'
    ).toBeLessThan(12 * 1024 * 1024);
    // The board painted from the real art and the real route chunk.
    expect(firstLoad.leaderboardChunks.map(([name]) => name).join(' ')).toMatch(/LeaderboardPage-/);
    expect(firstLoad.consoleArt.map(([name]) => name).sort()).toEqual(
      expect.arrayContaining(['bottom-foot.png', 'mid.png', 'top.png'])
    );

    await expect(board.locator('.sc')).toHaveCount(1);
    await expect(board.locator('.sc__head')).toHaveCSS(
      'background-image',
      /spade-console-v1\/top\.png/
    );
    await expect(board.getByRole('heading', { name: 'Leaderboards', level: 1 })).toBeAttached();
    await expect(board.getByRole('tab', { name: 'Rankings' })).toHaveAttribute(
      'aria-selected',
      'true'
    );

    // Keyboard-only visitors can move and activate the same primary views.
    const tabs = board.getByRole('tab');
    await tabs.first().focus();
    await page.keyboard.press('ArrowRight');
    await expect(tabs.nth(1)).toBeFocused();
    await expect(tabs.nth(1)).toHaveCSS('outline-style', 'solid');
    await page.keyboard.press('Enter');
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowLeft');
    // Ensure the reverse arrow transition is complete before Enter activates the focused tab.
    await expect(tabs.first()).toBeFocused();
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');

    for (const label of ['Global', 'My Clubs', 'Hands Played']) {
      const control = board.getByRole('button', { name: label, exact: true });
      const size = await control.boundingBox();
      expect(size?.width, `${label} target width`).toBeGreaterThanOrEqual(44);
      expect(size?.height, `${label} target height`).toBeGreaterThanOrEqual(44);
    }

    await board.getByRole('button', { name: 'Global', exact: true }).click();
    await expect(board.getByRole('button', { name: 'Global', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await expect(board.getByRole('tab', { name: 'Tournament Stats' })).toHaveCount(0);
    await expect(board.locator('.lb-prize-program')).toHaveCount(0);
    await board.getByRole('button', { name: 'Hands Played', exact: true }).click();
    await expect(board.getByRole('button', { name: 'Hands Played', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await expect(board.getByRole('tabpanel')).toHaveAttribute('aria-busy', 'false', {
      timeout: 30000,
    });
    await expect(board.locator('.lb-error-state')).toHaveCount(0);
    await expectLeaderboardNamesToStartEachWordWithACapital(page, '.entry-name', 'Rankings');

    const geometry = await board.evaluate((root) => ({
      width: root.querySelector('.sc')!.getBoundingClientRect().width,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      clipped: [...root.querySelectorAll<HTMLElement>('.sc-zone > span')]
        .filter((el) => el.scrollWidth > el.clientWidth + 2)
        .map((el) => el.textContent),
    }));
    expect(geometry.width).toBeLessThanOrEqual(1000);
    expect(geometry.overflow).toBe(false);
    expect(geometry.clipped).toEqual([]);
    await expect(board.locator('.lb-hero, .podium-crown, .podium-bar, .empty-icon')).toHaveCount(0);
    await expectNoSeriousAxeFindings(page, 'Global Hands Played');
    await keep('global-hands');

    await board.getByRole('button', { name: 'My Clubs', exact: true }).click();
    await board.getByRole('tab', { name: 'Tournament Stats' }).click();
    await expect(board.getByText('All Recorded Tournaments', { exact: true })).toBeVisible();
    await expectLeaderboardNamesToStartEachWordWithACapital(
      page,
      '.player-name',
      'Tournament Stats'
    );
    await expect(board.getByRole('button', { name: 'Previous Period' })).toHaveCount(0);
    await expect(board.locator('.lb-prize-program, .lb-settlement-card')).toHaveCount(0);
    await expectNoSeriousAxeFindings(page, 'My Clubs Tournament Stats');
    await keep('my-clubs-tournaments');

    // Back to the club's own Rankings: the prize program, rules and settlement
    // live here. Read only; nothing is asserted about this account's data.
    await board.getByRole('tab', { name: 'Rankings' }).click();
    await expect(board.getByRole('tabpanel')).toHaveAttribute('aria-busy', 'false', {
      timeout: 30000,
    });
    await expect(board.locator('.lb-error-state')).toHaveCount(0);
    await expectNoSeriousAxeFindings(page, 'My Clubs Rankings');
    await keep('my-clubs-rankings');

    const appConsoleErrors = observed.consoleErrors.filter((text) => !SUBRESOURCE.test(text));
    console.log(
      'LEADERBOARD_PERF ' +
        JSON.stringify({
          width,
          consoleVisibleMs,
          firstReadyMs,
          ...firstLoad,
          appConsoleErrors: appConsoleErrors.length,
          subresourceConsoleErrors: observed.consoleErrors.length - appConsoleErrors.length,
          pageErrors: observed.pageErrors,
          failedArenaFiles: observed.failedArenaFiles.length,
          otherBadResponses: observed.otherBadResponses,
          failedOtherRequests: observed.failedOtherRequests,
        })
    );

    // Nothing the application says, nothing it throws, and nothing of its own
    // it fails to load, across every state above.
    expect(observed.pageErrors, 'uncaught exceptions on the leaderboard').toBe(0);
    expect(appConsoleErrors, 'the application logged errors on the leaderboard').toEqual([]);
    expect(observed.failedArenaFiles, 'Club Arena files that failed to load').toEqual([]);
    expect(observed.otherBadResponses, 'failed non-Club Arena requests on the leaderboard').toEqual(
      []
    );
    expect(
      observed.failedOtherRequests,
      'non-Club Arena requests that failed on the leaderboard'
    ).toEqual([]);
  });
}

test('Leaderboard Cache Paints Before Real Revalidation And Expires Safely', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 900 });
  await page.goto('leaderboard');
  const board = page.locator(BOARD);
  await expect(board).toBeVisible({ timeout: 30000 });
  await expect(board.getByRole('tabpanel')).toHaveAttribute('aria-busy', 'false', {
    timeout: 30000,
  });

  // Use only this browser context's global weekly record. The reserved E2E
  // browser context is disposable; no server-side data is written or changed.
  const cacheKey = await page.evaluate((key) => {
    sessionStorage.removeItem(key);
    return key;
  }, GLOBAL_WEEKLY_PROFIT_CACHE_KEY);
  const isLeaderboardRefresh = (response: { url(): string }) =>
    new URL(response.url()).pathname.endsWith('/rpc/fn_global_leaderboard_period');

  const coldStartedAt = Date.now();
  const coldResponse = page.waitForResponse(isLeaderboardRefresh, { timeout: 30000 });
  await board.getByRole('button', { name: 'Global', exact: true }).click();
  await expect(board.getByRole('button', { name: 'Global', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await coldResponse;
  const coldRpcResponseMs = Date.now() - coldStartedAt;
  await expect(board.getByRole('tabpanel')).toHaveAttribute('aria-busy', 'false', {
    timeout: 30000,
  });
  const coldFirstReadyMs = Date.now() - coldStartedAt;

  const cached = await page.evaluate((key) => {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const record = JSON.parse(raw) as { version?: number; storedAt?: number; entries?: unknown[] };
    return {
      version: record.version,
      storedAt: record.storedAt,
      entryCount: Array.isArray(record.entries) ? record.entries.length : -1,
    };
  }, cacheKey);
  expect(cached?.version, 'cold API data should populate the scoped session cache').toBe(2);
  expect(
    cached?.entryCount,
    'the cache record should contain a valid ranked result'
  ).toBeGreaterThan(0);

  let releaseWarmRefresh!: () => void;
  let notifyWarmRequest!: () => void;
  const warmGate = new Promise<void>((resolve) => {
    releaseWarmRefresh = resolve;
  });
  const warmRequestSeen = new Promise<void>((resolve) => {
    notifyWarmRequest = resolve;
  });
  await page.route('**/rest/v1/rpc/fn_global_leaderboard_period**', async (route) => {
    notifyWarmRequest();
    await warmGate;
    await route.continue();
  });

  const warmStartedAt = Date.now();
  const warmResponse = page.waitForResponse(isLeaderboardRefresh, { timeout: 30000 });
  let warmCachedPaintMs = 0;
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await warmRequestSeen;
    await expect(board.getByRole('tabpanel')).toHaveAttribute('aria-busy', 'false');
    warmCachedPaintMs = Date.now() - warmStartedAt;
    const sameCacheStillPresent = await page.evaluate(
      (key) => sessionStorage.getItem(key) !== null,
      cacheKey
    );
    expect(sameCacheStillPresent, 'the warm reload should reuse its own cached record').toBe(true);
  } finally {
    releaseWarmRefresh();
    await page.unroute('**/rest/v1/rpc/fn_global_leaderboard_period**');
  }
  await warmResponse;
  const warmRpcResponseMs = Date.now() - warmStartedAt;
  await expect(board.getByRole('tabpanel')).toHaveAttribute('aria-busy', 'false', {
    timeout: 30000,
  });

  await page.evaluate(
    ({ key, ttlMs }) => {
      const raw = sessionStorage.getItem(key);
      if (!raw) throw new Error('Expected the warm leaderboard cache record');
      const record = JSON.parse(raw) as { storedAt: number };
      record.storedAt = Date.now() - ttlMs - 1;
      sessionStorage.setItem(key, JSON.stringify(record));
    },
    { key: cacheKey, ttlMs: LEADERBOARD_CACHE_TTL_MS }
  );

  let releaseExpiredRefresh!: () => void;
  let notifyExpiredRequest!: () => void;
  const expiredGate = new Promise<void>((resolve) => {
    releaseExpiredRefresh = resolve;
  });
  const expiredRequestSeen = new Promise<void>((resolve) => {
    notifyExpiredRequest = resolve;
  });
  await page.route('**/rest/v1/rpc/fn_global_leaderboard_period**', async (route) => {
    notifyExpiredRequest();
    await expiredGate;
    await route.continue();
  });

  const expiredStartedAt = Date.now();
  const expiredResponse = page.waitForResponse(isLeaderboardRefresh, { timeout: 30000 });
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expiredRequestSeen;
    await expect(board.getByRole('tabpanel')).toHaveAttribute('aria-busy', 'true');
    const expiredKeyWasRemoved = await page.evaluate(
      (key) => sessionStorage.getItem(key) === null,
      cacheKey
    );
    expect(expiredKeyWasRemoved, 'an expired record must be evicted before revalidation').toBe(
      true
    );
  } finally {
    releaseExpiredRefresh();
    await page.unroute('**/rest/v1/rpc/fn_global_leaderboard_period**');
  }
  await expiredResponse;
  await expect(board.getByRole('tabpanel')).toHaveAttribute('aria-busy', 'false', {
    timeout: 30000,
  });
  const expiredFirstReadyMs = Date.now() - expiredStartedAt;

  console.log(
    'LEADERBOARD_CACHE_PERF ' +
      JSON.stringify({
        width: 393,
        coldFirstReadyMs,
        coldRpcResponseMs,
        warmCachedPaintMs,
        warmRpcResponseMs,
        expiredFirstReadyMs,
        rpcHeldUntilCachedPaint: true,
        expiredRecordEvictedBeforeRefresh: true,
      })
  );
});
