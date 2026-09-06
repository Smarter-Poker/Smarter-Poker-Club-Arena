import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Request, type TestInfo } from '@playwright/test';

const MEMBERS_PATH = 'clubs/shark-club/members';

type MembersProbe = {
  startedAt: number;
  pageRpcCalls: number;
  summaryRpcCalls: number;
  pageRpcPending: number;
  summaryRpcPending: number;
  pageRpcSuccessfulCompletions: number;
  summaryRpcSuccessfulCompletions: number;
  responseFailures: Array<{ rpc: 'page' | 'summary'; status: number }>;
  requestFailureCount: number;
  requestAbortCount: number;
  pageErrorCount: number;
  consoleErrorCount: number;
  criticalConsoleErrorCount: number;
  timeline: Array<{
    atMs: number;
    requestId: number;
    rpc: 'page' | 'summary';
    event: 'request' | 'response' | 'finished' | 'aborted' | 'failed';
    status?: number;
  }>;
};

const observedMembersPaths = new WeakMap<Page, MembersProbe>();

function rosterRpc(url: string): 'page' | 'summary' | null {
  if (url.includes('/rpc/ca_club_members_page')) return 'page';
  if (url.includes('/rpc/ca_club_members_summary')) return 'summary';
  return null;
}

function observeMembersPath(page: Page): MembersProbe {
  const probe: MembersProbe = {
    startedAt: Date.now(),
    pageRpcCalls: 0,
    summaryRpcCalls: 0,
    pageRpcPending: 0,
    summaryRpcPending: 0,
    pageRpcSuccessfulCompletions: 0,
    summaryRpcSuccessfulCompletions: 0,
    responseFailures: [],
    requestFailureCount: 0,
    requestAbortCount: 0,
    pageErrorCount: 0,
    consoleErrorCount: 0,
    criticalConsoleErrorCount: 0,
    timeline: [],
  };
  let nextRequestId = 0;
  const requestMeta = new WeakMap<
    Request,
    { requestId: number; rpc: 'page' | 'summary'; status?: number }
  >();
  observedMembersPaths.set(page, probe);
  page.on('request', (request) => {
    const url = request.url();
    const rpc = rosterRpc(url);
    if (!rpc) return;
    const requestId = ++nextRequestId;
    requestMeta.set(request, { requestId, rpc });
    if (rpc === 'page') {
      probe.pageRpcCalls += 1;
      probe.pageRpcPending += 1;
    } else {
      probe.summaryRpcCalls += 1;
      probe.summaryRpcPending += 1;
    }
    probe.timeline.push({
      atMs: Date.now() - probe.startedAt,
      requestId,
      rpc,
      event: 'request',
    });
  });
  page.on('response', (response) => {
    const url = response.url();
    const rpc = rosterRpc(url);
    if (!rpc) return;
    const meta = requestMeta.get(response.request());
    if (!meta) return;
    meta.status = response.status();
    probe.timeline.push({
      atMs: Date.now() - probe.startedAt,
      requestId: meta.requestId,
      rpc,
      event: 'response',
      status: response.status(),
    });
    if (response.status() >= 400) {
      probe.responseFailures.push({ rpc, status: response.status() });
    }
  });
  page.on('requestfinished', (request) => {
    const meta = requestMeta.get(request);
    if (!meta) return;
    if (meta.rpc === 'page') {
      probe.pageRpcPending -= 1;
      if (meta.status && meta.status >= 200 && meta.status < 300) {
        probe.pageRpcSuccessfulCompletions += 1;
      }
    } else {
      probe.summaryRpcPending -= 1;
      if (meta.status && meta.status >= 200 && meta.status < 300) {
        probe.summaryRpcSuccessfulCompletions += 1;
      }
    }
    probe.timeline.push({
      atMs: Date.now() - probe.startedAt,
      requestId: meta.requestId,
      rpc: meta.rpc,
      event: 'finished',
      status: meta.status,
    });
  });
  page.on('requestfailed', (request) => {
    const meta = requestMeta.get(request);
    if (!meta) return;
    const aborted = /abort/i.test(request.failure()?.errorText || '');
    if (meta.rpc === 'page') probe.pageRpcPending -= 1;
    else probe.summaryRpcPending -= 1;
    if (aborted) probe.requestAbortCount += 1;
    else probe.requestFailureCount += 1;
    probe.timeline.push({
      atMs: Date.now() - probe.startedAt,
      requestId: meta.requestId,
      rpc: meta.rpc,
      event: aborted ? 'aborted' : 'failed',
    });
  });
  page.on('pageerror', () => {
    probe.pageErrorCount += 1;
  });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    probe.consoleErrorCount += 1;
    if (
      /ClubMembersPage|ClubRosterService|ca_club_members|ChunkLoadError|loading chunk|dynamically imported|uncaught|(?:Type|Reference|Syntax)Error/i.test(
        message.text()
      )
    ) {
      probe.criticalConsoleErrorCount += 1;
    }
  });
  return probe;
}

async function completeNextPageRead(
  probe: MembersProbe,
  action: () => Promise<unknown>,
  operation: string
) {
  const callsBefore = probe.pageRpcCalls;
  const completionsBefore = probe.pageRpcSuccessfulCompletions;
  await action();
  await expect
    .poll(() => probe.pageRpcCalls, {
      message: `${operation} did not issue a directory RPC`,
      timeout: 45_000,
    })
    .toBeGreaterThan(callsBefore);
  await expect
    .poll(() => probe.pageRpcSuccessfulCompletions, {
      message: `${operation} did not finish a successful 2xx directory RPC`,
      timeout: 45_000,
    })
    .toBeGreaterThan(completionsBefore);
  await expect
    .poll(() => probe.pageRpcPending, {
      message: `${operation} left a directory RPC pending`,
      timeout: 5_000,
    })
    .toBe(0);
  expect(probe.responseFailures).toEqual([]);
  expect(probe.requestFailureCount).toBe(0);
  expect(probe.requestAbortCount).toBe(0);
}

async function attachMembersProbe(page: Page, probe: MembersProbe, testInfo: TestInfo) {
  const safeCount = async (selector: string) =>
    page
      .locator(selector)
      .count()
      .catch(() => 0);
  const snapshot = {
    ...probe,
    elapsedMs: Date.now() - probe.startedAt,
    ui: {
      ariaBusy: await page
        .locator('.members-list')
        .getAttribute('aria-busy', { timeout: 1_000 })
        .catch(() => null),
      connectionStatusCount: await safeCount('.members-connection-status'),
      loadingStatusCount: await safeCount('.members-slow'),
      errorStatusCount: await safeCount('.members-error'),
      renderedRows: await page
        .getByRole('list', { name: 'Club Member Directory' })
        .getByRole('listitem')
        .count()
        .catch(() => 0),
    },
  };
  await testInfo.attach('club-members-rpc-probe', {
    body: JSON.stringify(snapshot, null, 2),
    contentType: 'application/json',
  });
}

async function openMembers(page: Page, probe: MembersProbe): Promise<number> {
  const startedAt = Date.now();
  await page.goto(MEMBERS_PATH, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await expect(page).not.toHaveURL(/\/auth(?:\/|\?|$)/, { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Player Command', exact: true })).toBeVisible({
    timeout: 45_000,
  });
  await expect(page.getByRole('list', { name: 'Club Member Directory' })).toBeVisible();
  await expect
    .poll(() => probe.pageRpcSuccessfulCompletions, {
      message: 'the initial directory RPC did not finish successfully',
      timeout: 45_000,
    })
    .toBeGreaterThanOrEqual(1);
  await expect
    .poll(() => probe.summaryRpcSuccessfulCompletions, {
      message: 'the initial summary RPC did not finish successfully',
      timeout: 45_000,
    })
    .toBeGreaterThanOrEqual(1);
  await expect(
    page.getByRole('list', { name: 'Club Member Directory' }).getByRole('listitem').first()
  ).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText('Could Not Load The Roster.', { exact: true })).toHaveCount(0);
  expect(probe.responseFailures).toEqual([]);
  expect(probe.requestFailureCount).toBe(0);
  expect(probe.requestAbortCount).toBe(0);
  expect(probe.pageErrorCount).toBe(0);
  expect(probe.criticalConsoleErrorCount).toBe(0);
  return Date.now() - startedAt;
}

test.describe('Production Shark Club Players', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  test.afterEach(async ({ page }, testInfo) => {
    const probe = observedMembersPaths.get(page);
    if (!probe) return;
    await attachMembersProbe(page, probe, testInfo);
    observedMembersPaths.delete(page);
  });

  test('loads the real roster once and completes search, filter, sort, and player navigation', async ({
    page,
  }) => {
    const probe = observeMembersPath(page);
    const readyMs = await openMembers(page, probe);

    expect(
      readyMs,
      'the Players page did not become usable inside the release budget'
    ).toBeLessThan(45_000);
    expect(probe.pageRpcCalls, 'the directory RPC never ran').toBeGreaterThanOrEqual(1);
    expect(probe.summaryRpcCalls, 'the summary RPC never ran').toBeGreaterThanOrEqual(1);

    const art = page.locator('.members-hero__art');
    await expect(art).toBeVisible();
    expect(
      await art.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
      'the roster hero artwork did not decode'
    ).toBe(true);

    const summary = page.locator('[aria-label="Roster Summary"]');
    await expect(summary.getByText('Total Members', { exact: true })).toBeVisible();
    await expect(summary.getByText('Online Now', { exact: true })).toBeVisible();
    await expect(summary.getByText('At Tables', { exact: true })).toBeVisible();
    await expect(summary.getByText('Agents', { exact: true })).toBeVisible();

    const directory = page.getByRole('list', { name: 'Club Member Directory' });
    const firstRow = directory.getByRole('listitem').first();
    const firstAlias = ((await firstRow.locator('.member-alias').textContent()) || '').trim();
    expect(firstAlias).not.toBe('');

    const search = page.getByRole('searchbox', { name: 'Search Club Members' });
    await completeNextPageRead(probe, () => search.fill(firstAlias), 'member search');
    await expect(directory.getByRole('listitem').first().locator('.member-alias')).toContainText(
      firstAlias,
      { timeout: 30_000 }
    );
    await completeNextPageRead(probe, () => search.fill(''), 'clearing member search');

    const online = page.getByRole('button', { name: 'Online', exact: true });
    await completeNextPageRead(probe, () => online.click(), 'Online filter');
    await expect(online).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(/[?&]view=online(?:&|$)/);

    const allPlayers = page.getByRole('button', { name: 'All Players', exact: true });
    await completeNextPageRead(probe, () => allPlayers.click(), 'All Players filter');
    await expect(allPlayers).toHaveAttribute('aria-pressed', 'true');
    await expect(page).not.toHaveURL(/[?&]view=/);

    const sort = page.getByRole('combobox', { name: 'Sort Players' });
    await completeNextPageRead(probe, () => sort.selectOption('name'), 'name sort');
    await expect(page).toHaveURL(/[?&]sort=name(?:&|$)/);
    await expect(directory.getByRole('listitem').first()).toBeVisible({ timeout: 30_000 });

    await directory.getByRole('listitem').first().getByRole('button').click();
    await expect(page).toHaveURL(/\/clubs\/shark-club\/members\/[0-9a-f-]{36}(?:[/?#]|$)/i);
    expect(probe.responseFailures).toEqual([]);
    expect(probe.requestFailureCount).toBe(0);
    expect(probe.requestAbortCount).toBe(0);
    expect(probe.pageErrorCount).toBe(0);
    expect(probe.criticalConsoleErrorCount).toBe(0);
  });

  test('keeps the complete Players control surface usable at 375px', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const probe = observeMembersPath(page);
    await openMembers(page, probe);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(1);

    const search = page.getByRole('searchbox', { name: 'Search Club Members' });
    expect(
      await search.evaluate((input) => Number.parseFloat(getComputedStyle(input).fontSize))
    ).toBe(16);

    for (const control of [
      page.getByRole('button', { name: 'All Players', exact: true }),
      page.getByRole('button', { name: 'Online', exact: true }),
      page.getByRole('button', { name: 'Refresh', exact: true }),
    ]) {
      const box = await control.boundingBox();
      expect(box, 'a primary Players control has no rendered box').not.toBeNull();
      expect(
        box!.height,
        'a primary Players control is below the 44px touch floor'
      ).toBeGreaterThanOrEqual(44);
    }

    const chromeText = (await page.locator('.members-hero, .members-console').allInnerTexts()).join(
      '\n'
    );
    expect(chromeText, 'em dash punctuation is forbidden in player UI copy').not.toContain(
      '\u2014'
    );
    await expect(page.getByRole('heading', { name: 'Find A Player', exact: true })).toBeVisible();
    await expect(search).toHaveAttribute('placeholder', 'Search Name, Number, Club, Or Upline');

    const axe = await new AxeBuilder({ page }).include('.club-members-page').analyze();
    expect(
      axe.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact || ''))
    ).toEqual([]);
    expect(probe.responseFailures).toEqual([]);
    expect(probe.requestFailureCount).toBe(0);
    expect(probe.requestAbortCount).toBe(0);
    expect(probe.pageErrorCount).toBe(0);
    expect(probe.criticalConsoleErrorCount).toBe(0);
  });

  test('wires the live Player Record and Statistics subpages without unsafe writes', async ({
    page,
  }) => {
    const probe = observeMembersPath(page);
    await openMembers(page, probe);

    const directory = page.getByRole('list', { name: 'Club Member Directory' });
    await directory.getByRole('listitem').first().getByRole('button').click();
    await expect(page).toHaveURL(/\/clubs\/shark-club\/members\/[0-9a-f-]{36}(?:[/?#]|$)/i);
    await expect(page.getByRole('heading', { name: 'Player Record', exact: true })).toBeVisible({
      timeout: 45_000,
    });
    await expect(page.locator('#mm-player-name')).toBeVisible();

    const credentialArt = page.locator('.mm-credential__art');
    await expect(credentialArt).toBeVisible();
    await expect
      .poll(() =>
        credentialArt.evaluate(
          (image: HTMLImageElement) => image.complete && image.naturalWidth > 0
        )
      )
      .toBe(true);

    const roleOption = page.locator('.mm-roles__option:not([disabled])').first();
    if (await roleOption.count()) {
      await roleOption.click();
      const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
      await expect(cancel).toBeVisible();
      await cancel.click();
      await expect(cancel).toHaveCount(0);
    }

    const recordAxe = await new AxeBuilder({ page }).include('.member-mgmt-page').analyze();
    expect(
      recordAxe.violations.filter((violation) =>
        ['serious', 'critical'].includes(violation.impact || '')
      )
    ).toEqual([]);

    await page.getByRole('button', { name: /Player Statistics/i }).click();
    await expect(page).toHaveURL(/\/members\/[0-9a-f-]{36}\/statistics(?:[/?#]|$)/i);
    await expect(
      page.getByRole('heading', { name: 'Player Performance', exact: true })
    ).toBeVisible({
      timeout: 45_000,
    });

    const statisticsArt = page.locator('.ps-hero__art');
    await expect(statisticsArt).toBeVisible();
    await expect
      .poll(() =>
        statisticsArt.evaluate(
          (image: HTMLImageElement) => image.complete && image.naturalWidth > 0
        )
      )
      .toBe(true);

    // These are the four product modes promised by PlayerStatisticsPage:
    // rolling 1/7/30-day windows plus an explicit custom span. The old canary
    // waited for "Overall" and "7 Days", neither of which exists on this
    // club-scoped page, and consumed the full test timeout after the page had
    // loaded successfully. Exercise every real control instead.
    for (const range of ['Day', 'Week', 'Month', 'Custom']) {
      const control = page.getByRole('button', { name: range, exact: true });
      await control.click();
      await expect(control).toHaveAttribute('aria-pressed', 'true');
    }
    await expect(page.locator('.ps-range__custom input[type="date"]')).toHaveCount(2);

    const statisticsAxe = await new AxeBuilder({ page }).include('.player-stats-page').analyze();
    expect(
      statisticsAxe.violations.filter((violation) =>
        ['serious', 'critical'].includes(violation.impact || '')
      )
    ).toEqual([]);
    expect(probe.responseFailures).toEqual([]);
    expect(probe.requestFailureCount).toBe(0);
    expect(probe.requestAbortCount).toBe(0);
    expect(probe.pageErrorCount).toBe(0);
    expect(probe.criticalConsoleErrorCount).toBe(0);
  });
});
