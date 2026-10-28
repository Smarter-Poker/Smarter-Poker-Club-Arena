import AxeBuilder from '@axe-core/playwright';
import {
  HISTORY_ADMISSION_MS,
  HISTORY_JOIN_ACK_MS,
  observeHistoryJoin,
} from './support/historyJoinObservation';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type Request, type TestInfo } from '@playwright/test';

// Canonical slug since the Kings Club rebrand (2026-10-21); the legacy
// shark-club path redirects here and is covered by ClubBrandRedirect tests.
const MEMBERS_PATH = 'clubs/kings-club/members';

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
  expect(
    probe.requestAbortCount,
    `Roster request timeline: ${JSON.stringify(probe.timeline)}`
  ).toBe(0);
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
  await expect(page.locator('[data-players-mode="simple"]')).toBeVisible({ timeout: 45_000 });
  const viewportWidth = page.viewportSize()?.width;
  if (viewportWidth !== undefined && viewportWidth <= 430) {
    await expect(page.getByRole('combobox', { name: 'Sort Players' })).toHaveCSS(
      'font-size',
      '16px'
    );
  }
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  // The page hero is gone (Dan 2026-10-17); its title is a hidden h1 and the
  // Advanced desk adds the live totals to the page bar.
  await expect(page.locator('[data-players-mode="advanced"]')).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole('heading', { level: 1, name: 'Player Management' })).toHaveCount(1);
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
  expect(
    probe.requestAbortCount,
    `Roster request timeline: ${JSON.stringify(probe.timeline)}`
  ).toBe(0);
  expect(probe.pageErrorCount).toBe(0);
  expect(probe.criticalConsoleErrorCount).toBe(0);
  return Date.now() - startedAt;
}

async function expectContainedControls(page: Page, frameSelector: string, selector: string) {
  const frame = await page.locator(frameSelector).boundingBox();
  expect(frame, `${frameSelector} must render`).not.toBeNull();
  const controls = await page.locator(selector).all();
  expect(controls.length, `${selector} must execute real control checks`).toBeGreaterThan(0);
  for (const control of controls) {
    const box = await control.boundingBox();
    expect(box, `${selector} must have a rendered box`).not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.x).toBeGreaterThanOrEqual(frame!.x - 0.5);
    expect(box!.x + box!.width).toBeLessThanOrEqual(frame!.x + frame!.width + 0.5);
    expect(
      await control.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
      `${selector} clips its own content`
    ).toBe(true);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    )
  ).toBeLessThanOrEqual(1);
}

test.describe('Production Kings Club Players', () => {
  // Each case receives its own browser context. Only the roster export creates
  // its established audit receipt; no financial or member changes are submitted.
  // Keep one worker, but report every case when a sibling fails.
  test.describe.configure({ mode: 'default', timeout: 120_000 });

  test.afterEach(async ({ page }, testInfo) => {
    const probe = observedMembersPaths.get(page);
    if (!probe) return;
    await attachMembersProbe(page, probe, testInfo);
    observedMembersPaths.delete(page);
  });

  test('loads the real roster once and completes search, filter, sort, and player navigation', async ({
    page,
  }, testInfo) => {
    // Preserve the current page channel budget while qualifying admission separately.
    test.setTimeout(120_000 + HISTORY_ADMISSION_MS + HISTORY_JOIN_ACK_MS);
    const historyJoin = observeHistoryJoin(page);
    const historySignals: Record<string, unknown>[] = [];
    const rosterReadiness: boolean[] = [];
    page.on('websocket', (socket) =>
      socket.on('framereceived', (frame) => {
        try {
          const parsed = JSON.parse(String(frame.payload));
          const message = Array.isArray(parsed)
            ? { topic: parsed[2], event: parsed[3], payload: parsed[4] }
            : parsed;
          if (
            message.type === 'PRIVATE_RECORD_STATUS' &&
            String(message.topic).startsWith('club-roster:')
          )
            rosterReadiness.push(message.ready === true);
          if (!String(message.topic).startsWith('realtime:player-history:')) return;
          if (message.event === 'broadcast' && message.payload?.event === 'history_changed')
            historySignals.push(message.payload.payload);
        } catch {
          /* Non-JSON transport frames carry no history receipt. */
        }
      })
    );
    const probe = observeMembersPath(page);
    const readyMs = await openMembers(page, probe);
    await expect
      .poll(() => rosterReadiness.includes(true), {
        message: 'the serving engine never authorized the private roster subscription',
        timeout: 45_000,
      })
      .toBe(true);
    await expect(page.locator('.club-members-page')).toHaveAttribute(
      'data-roster-connection',
      'live',
      { timeout: 45_000 }
    );

    expect(
      readyMs,
      'the Players page did not become usable inside the release budget'
    ).toBeLessThan(45_000);
    expect(probe.pageRpcCalls, 'the directory RPC never ran').toBeGreaterThanOrEqual(1);
    expect(probe.summaryRpcCalls, 'the summary RPC never ran').toBeGreaterThanOrEqual(1);

    // No hero, no hero artwork: the totals print in the page bar beside the "?".
    await expect(page.locator('.members-hero, .members-hero__art')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Page Help' })).toBeVisible();

    const summary = page.locator('[aria-label="Player Management Live Summary"]');
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

    const filter = page.getByRole('combobox', { name: 'Filter Players', exact: true });
    await completeNextPageRead(probe, () => filter.selectOption('online'), 'Online filter');
    await expect(filter).toHaveValue('online');
    await expect(page).toHaveURL(/[?&]view=online(?:&|$)/);

    await completeNextPageRead(probe, () => filter.selectOption('all'), 'All Players filter');
    await expect(filter).toHaveValue('all');
    await expect(page).not.toHaveURL(/[?&]view=/);

    const sort = page.getByRole('combobox', { name: 'Sort Players' });
    await completeNextPageRead(probe, () => sort.selectOption('name'), 'name sort');
    await expect(page).toHaveURL(/[?&]sort=name(?:&|$)/);
    await expect(directory.getByRole('listitem').first()).toBeVisible({ timeout: 30_000 });

    await expect(page.getByRole('note', { name: 'Export Scope' })).toContainText(
      'All Matching Players Across Every Page'
    );
    await expect(page.getByRole('status', { name: 'Roster Operations' })).toBeVisible();
    const history = page.locator('.player-history');
    const initialHistory = page.waitForResponse((response) =>
      response.url().includes('/rpc/ca_club_player_history')
    );
    let historyTopic = '';
    try {
      await historyJoin.observation.qualify(async () => {
        await history.locator('summary').click();
        const initialHistoryResponse = await initialHistory;
        expect(initialHistoryResponse.ok()).toBe(true);
        const historyScope = await initialHistoryResponse.json();
        historyTopic = `realtime:player-history:${historyScope.club_id}`;
        return historyTopic;
      });
    } catch (error) {
      await testInfo.attach('player-history-join-phase', {
        body: JSON.stringify(historyJoin.observation.result(historyTopic, performance.now())),
        contentType: 'application/json',
      });
      throw error;
    } finally {
      historyJoin.dispose();
    }
    const exportResponse = page.waitForResponse((response) =>
      response.url().includes('/rpc/ca_club_members_export')
    );
    const exportDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export CSV', exact: true }).click();
    const response = await exportResponse;
    expect(response.ok()).toBe(true);
    const receipt = await response.json();
    expect(receipt.success).toBe(true);
    expect(receipt.row_count).toBeGreaterThan(0);
    const operation = page.getByRole('status', { name: 'Export Operation' });
    await expect(operation).toHaveAttribute('data-operation-state', 'success');
    await expect(operation).toContainText(receipt.audit_id);
    await expect(operation).toContainText(receipt.row_count.toLocaleString());
    const requestScope = response.request().postDataJSON();
    expect(requestScope).toMatchObject({ p_filter: 'all', p_sort: 'name', p_user_ids: null });
    const download = await exportDownload;
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    const csv = await readFile(downloadPath!, 'utf8');
    const header = csv
      .replace(/^\uFEFF/, '')
      .split('\r\n')[0]
      .split(',');
    for (const field of [
      'export_club_id',
      'export_scope',
      'export_filter',
      'export_sort',
      'export_row_count',
      'export_requested_at_utc',
      'export_completed_at_utc',
      'export_audit_id',
      'export_activity_period',
      'export_units',
    ]) {
      expect(header).toContain(field);
    }
    expect(csv).toContain(requestScope.p_club_id);
    expect(csv).toContain(receipt.audit_id);
    expect(csv).toContain('all_matching');
    expect(csv).toContain('All Recorded Activity');
    expect(csv).toContain('Club Chips');
    await expect(
      history.getByRole('status').filter({ hasText: 'New Changes Are Available' })
    ).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(
        () =>
          historySignals.some(
            (value) =>
              value.club_id === requestScope.p_club_id && value.action === 'export_club_roster'
          ),
        { timeout: 15_000 }
      )
      .toBe(true);
    const signal = historySignals.find(
      (value) => value.club_id === requestScope.p_club_id && value.action === 'export_club_roster'
    );
    expect(signal).toBeTruthy();
    expect(Object.keys(signal!).sort()).toEqual(['action', 'club_id', 'id', 'target_id']);
    await history.getByRole('combobox', { name: 'History Type' }).selectOption('exports');
    await expect(history.getByRole('list', { name: 'Recorded Changes' })).toContainText(
      receipt.audit_id,
      { timeout: 15_000 }
    );
    await expect(history.getByRole('alert')).toHaveCount(0);
    await history.locator('summary').click();

    await directory.getByRole('listitem').first().getByRole('button').click();
    await expect(page).toHaveURL(/\/clubs\/kings-club\/members\/[0-9a-f-]{36}(?:[/?#]|$)/i);
    expect(probe.responseFailures).toEqual([]);
    expect(probe.requestFailureCount).toBe(0);
    expect(
      probe.requestAbortCount,
      `Roster request timeline: ${JSON.stringify(probe.timeline)}`
    ).toBe(0);
    expect(probe.pageErrorCount).toBe(0);
    expect(probe.criticalConsoleErrorCount).toBe(0);
  });

  test('restores the roster workspace and virtual position after visiting a Player Record', async ({
    page,
  }) => {
    const probe = observeMembersPath(page);
    await openMembers(page, probe);
    const sort = page.getByRole('combobox', { name: 'Sort Players' });
    await completeNextPageRead(probe, () => sort.selectOption('name'), 'workspace name sort');
    await page
      .locator('.members-columns summary')
      .filter({ hasText: /^Columns$/ })
      .click();
    const fees = page.getByRole('checkbox', { name: 'Fees', exact: true });
    await fees.uncheck();
    await page
      .locator('.members-columns summary')
      .filter({ hasText: /^Columns$/ })
      .click();
    const viewport = page.locator('.members-viewport');
    await viewport.evaluate((node) => {
      node.scrollTop = 448;
      node.dispatchEvent(new Event('scroll'));
    });
    await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBe(448);
    const directory = page.getByRole('list', { name: 'Club Member Directory' });
    // Production must keep the roster window bounded and update its slice
    // after a real scroll, without replacing the exact DOM return position.
    await expect.poll(() => directory.getByRole('listitem').count()).toBeLessThanOrEqual(16);
    await viewport.evaluate((node) => {
      node.scrollTop = 1230;
      node.dispatchEvent(new Event('scroll'));
    });
    await expect
      .poll(() => directory.getByRole('listitem').first().getAttribute('aria-posinset'))
      .toBe('6');
    await expect.poll(() => directory.getByRole('listitem').count()).toBeLessThanOrEqual(16);
    await viewport.evaluate((node) => {
      node.scrollTop = 448;
      node.dispatchEvent(new Event('scroll'));
    });
    await expect
      .poll(() => directory.getByRole('listitem').first().getAttribute('aria-posinset'))
      .toBe('1');
    const row = directory.getByRole('listitem').nth(5);
    const alias = ((await row.locator('.member-alias').textContent()) || '').trim();
    expect(alias).not.toBe('');
    // Locator clicks can scroll a nested roster before its click handler saves
    // the return position. Activate the actual button from keyboard focus while
    // preserving the position this case is intended to verify.
    await row.getByRole('button').evaluate((node) => node.focus({ preventScroll: true }));
    await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBe(448);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Player Record', exact: true })).toBeVisible();
    await expect(page.locator('#mm-player-name')).toContainText(alias);
    const savedPositions = await page.evaluate(() =>
      Object.keys(sessionStorage)
        .filter((key) => key.startsWith('roster_position_v1_'))
        .map((key) => JSON.parse(sessionStorage.getItem(key)!).viewportTop)
    );
    expect(savedPositions).toEqual([448]);
    await page.locator('.mm-back').click();
    await page.getByRole('button', { name: 'Advanced', exact: true }).click();
    await expect(sort).toHaveValue('name');
    await expect
      .poll(() => viewport.evaluate((node) => node.scrollTop), { timeout: 30_000 })
      .toBe(448);
    await page
      .locator('.members-columns summary')
      .filter({ hasText: /^Columns$/ })
      .click();
    await expect(fees).not.toBeChecked();
    await page
      .locator('.members-columns summary')
      .filter({ hasText: /^Columns$/ })
      .click();
    await expect(page.getByRole('region', { name: 'Selected Players' })).toHaveCount(0);

    const search = page.getByRole('searchbox', { name: 'Search Club Members' });
    await completeNextPageRead(probe, () => search.fill(alias), 'workspace saved search');
    await expect(directory.getByRole('listitem').first().locator('.member-alias')).toContainText(
      alias
    );
    await directory.getByRole('listitem').first().getByRole('button').click();
    await expect(page.getByRole('heading', { name: 'Player Record', exact: true })).toBeVisible();
    await expect(page.locator('#mm-player-name')).toContainText(alias);
    await page.locator('.mm-back').click();
    await page.getByRole('button', { name: 'Advanced', exact: true }).click();
    await expect(search).toHaveValue(alias);
    await expect(sort).toHaveValue('name');
    await expect(directory.getByRole('listitem').first().locator('.member-alias')).toContainText(
      alias
    );
    expect(probe.responseFailures).toEqual([]);
    expect(probe.requestFailureCount).toBe(0);
    expect(probe.pageErrorCount).toBe(0);
    expect(probe.criticalConsoleErrorCount).toBe(0);
  });

  test('keeps roster surfaces and controls inside the actual page at desktop and phone widths', async ({
    page,
  }) => {
    const probe = observeMembersPath(page);
    await openMembers(page, probe);
    const originalViewport = page.viewportSize();
    for (const width of [1449, 375, 393]) {
      await page.setViewportSize({ width, height: 812 });
      const frame = await page.locator('.club-members-page').boundingBox();
      expect(frame, 'the roster page must have a rendered containing block').not.toBeNull();
      for (const selector of [
        '.members-page-bar',
        '.members-console',
        '.members-list',
        '.members-count[role="status"]',
        '.members-search',
        '.members-search input',
        '.members-view-filter',
        '.members-view-filter select',
        '.members-sort',
        '.members-toolbar',
      ]) {
        const elements = await page.locator(selector).all();
        expect(elements.length, `${selector} must render at ${width}px`).toBeGreaterThan(0);
        for (const element of elements) {
          const box = await element.boundingBox();
          expect(box, `${selector} must render at ${width}px`).not.toBeNull();
          expect(box!.width).toBeGreaterThan(0);
          expect(
            box!.x,
            `${selector} clips at the left page edge at ${width}px`
          ).toBeGreaterThanOrEqual(frame!.x - 0.5);
          expect(
            box!.x + box!.width,
            `${selector} clips at the right page edge at ${width}px`
          ).toBeLessThanOrEqual(frame!.x + frame!.width + 0.5);
        }
      }
      const consoleFrame = await page.locator('.members-console').boundingBox();
      expect(consoleFrame).not.toBeNull();
      for (const control of await page
        .locator(
          '.members-search input, .members-view-filter select, .members-sort select, .members-columns, .members-export, .members-select-loaded'
        )
        .all()) {
        const box = await control.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(consoleFrame!.x);
        expect(box!.x + box!.width).toBeLessThanOrEqual(consoleFrame!.x + consoleFrame!.width);
        expect(
          await control.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
          'a roster control clips its own content'
        ).toBe(true);
      }
      // Permission-specific controls are checked whenever the actual viewer
      // can see them; the required search and sort checks always execute.
      for (const control of await page
        .locator('.members-export, .members-select-loaded, .members-columns, .member-row__open')
        .all()) {
        const box = await control.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(frame!.x - 0.5);
        expect(box!.x + box!.width).toBeLessThanOrEqual(frame!.x + frame!.width + 0.5);
      }
    }
    if (originalViewport) await page.setViewportSize(originalViewport);
    expect(probe.responseFailures).toEqual([]);
    expect(probe.requestFailureCount).toBe(0);
    expect(
      probe.requestAbortCount,
      `Roster request timeline: ${JSON.stringify(probe.timeline)}`
    ).toBe(0);
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
      page.getByRole('combobox', { name: 'Filter Players', exact: true }),
      // The manual Refresh button was removed in #7600; the roster syncs live.
      page.getByRole('combobox', { name: 'Sort Players', exact: true }),
    ]) {
      const box = await control.boundingBox();
      expect(box, 'a primary Players control has no rendered box').not.toBeNull();
      expect(
        box!.height,
        'a primary Players control is below the 44px touch floor'
      ).toBeGreaterThanOrEqual(44);
    }

    const chromeText = (
      await page.locator('.members-page-bar, .members-console').allInnerTexts()
    ).join('\n');
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
    expect(
      probe.requestAbortCount,
      `Roster request timeline: ${JSON.stringify(probe.timeline)}`
    ).toBe(0);
    expect(probe.pageErrorCount).toBe(0);
    expect(probe.criticalConsoleErrorCount).toBe(0);
  });

  test('wires the live Player Record and Statistics subpages without unsafe writes', async ({
    page,
  }) => {
    const probe = observeMembersPath(page);
    await openMembers(page, probe);

    const clubHistory = page.locator('.player-history');
    await clubHistory.locator('summary').click();
    await expect(
      clubHistory
        .getByRole('status')
        .filter({ hasText: /Recorded Changes Loaded|No Recorded Changes Match/ })
    ).toBeVisible({ timeout: 15_000 });
    await expect(clubHistory.getByRole('alert')).toHaveCount(0);
    await clubHistory.getByRole('combobox', { name: 'History Type' }).selectOption('exports');
    await expect(
      clubHistory
        .getByRole('status')
        .filter({ hasText: /Recorded Changes Loaded|No Recorded Changes Match/ })
    ).toBeVisible({ timeout: 15_000 });
    await expect(clubHistory.getByRole('alert')).toHaveCount(0);
    await clubHistory.locator('summary').click();

    const directory = page.getByRole('list', { name: 'Club Member Directory' });
    await directory.getByRole('listitem').first().getByRole('button').click();
    await expect(page).toHaveURL(/\/clubs\/kings-club\/members\/[0-9a-f-]{36}(?:[/?#]|$)/i);
    await expect(page.getByRole('heading', { name: 'Player Record', exact: true })).toBeVisible({
      timeout: 45_000,
    });
    await expect(page.locator('#mm-player-name')).toBeVisible();
    await expect(page.getByRole('status', { name: 'Displayed Activity Scope' })).toContainText(
      'Recorded Activity'
    );
    const playerHistory = page.locator('.player-history');
    await playerHistory.locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect(
      playerHistory
        .getByRole('status')
        .filter({ hasText: /Recorded Changes Loaded|No Recorded Changes Match/ })
    ).toBeVisible({ timeout: 15_000 });
    await expect(playerHistory.getByRole('alert')).toHaveCount(0);
    await expect(playerHistory).toContainText('Missing Records Are Not Reconstructed');
    await expect(playerHistory.getByRole('option', { name: 'Exports', exact: true })).toHaveCount(
      0
    );
    await playerHistory.getByLabel('History From', { exact: true }).fill('2026-01-01');
    await expect(playerHistory).toContainText('Draft Dates Are Not Applied');

    const activityGuide = page.locator('[aria-label="Activity Metric Definitions"]');
    await activityGuide.locator('summary').click();
    await expect(activityGuide).toContainText('MTT Winnings Is Tournament Money');

    const credentialArt = page.locator('.mm-credential__art');
    await expect(credentialArt).toBeVisible();
    await expect
      .poll(() =>
        credentialArt.evaluate(
          (image: HTMLImageElement) => image.complete && image.naturalWidth > 0
        )
      )
      .toBe(true);

    // The identity must remain readable beside a long role at phone widths.
    // These are real rendered boxes on the published page, not CSS string pins.
    const originalViewport = page.viewportSize();
    for (const width of [375, 393]) {
      await page.setViewportSize({ width, height: 812 });
      const boxes = await Promise.all(
        ['.mm-avatar', '.role-badge', '.mm-presence', '.mm-player-id', '#mm-player-name'].map(
          (selector) => page.locator(`.mm-credential ${selector}`).boundingBox()
        )
      );
      for (let i = 0; i < boxes.length; i++) {
        expect(boxes[i], `identity field ${i} has no rendered box at ${width}px`).not.toBeNull();
        expect(boxes[i]!.x).toBeGreaterThanOrEqual(0);
        expect(boxes[i]!.x + boxes[i]!.width).toBeLessThanOrEqual(width);
        for (let j = 0; j < i; j++) {
          const a = boxes[i]!;
          const b = boxes[j]!;
          const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
          const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
          expect(
            overlapX > 0.5 && overlapY > 0.5,
            `identity fields ${i}/${j} overlap at ${width}px`
          ).toBe(false);
        }
      }
    }
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    await page.locator('.mm-range__custom input[type="date"]').first().fill('2026-01-01');
    await expect(page.locator('.mm-range__draft')).toContainText('Draft Dates Not Applied');
    await expect(page.getByRole('status', { name: 'Displayed Activity Scope' })).toContainText(
      'Recorded Activity'
    );
    for (const width of [375, 393, 768]) {
      await page.setViewportSize({ width, height: 812 });
      await expectContainedControls(
        page,
        '.mm-range',
        '.mm-range__tabs button, .mm-range__custom input, .mm-range__confirm'
      );
      await expectContainedControls(page, '.member-mgmt-page', '.mm-nav__row');
      await expectContainedControls(
        page,
        '.player-history',
        '.player-history summary, .player-history input, .player-history select, .player-history button'
      );
      await expectContainedControls(page, '.member-mgmt-page', '.member-mgmt-page > *');
      await expectContainedControls(
        page,
        '.mm-metric-guide',
        '.mm-metric-guide summary, .mm-metric-guide p'
      );
    }
    await page.getByRole('button', { name: 'Overall', exact: true }).click();
    if (originalViewport) await page.setViewportSize(originalViewport);

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
    ).toBeAttached({
      timeout: 45_000,
    });

    // Dan 2026-10-17: the statistics hero and its felt art are gone; the page
    // opens on its back door, its "?" and its instrument controls.
    await expect(page.locator('.ps-hero__art')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Page Help' })).toBeVisible();

    // Player Statistics owns a calendar-oriented range selector. Keep this
    // production contract aligned with the controls the page actually ships,
    // rather than the older Member Management range labels.
    for (const range of ['Overall', 'Day', '7 Days', 'Month', 'Custom']) {
      const control = page.getByRole('button', { name: range, exact: true });
      await control.click();
      await expect(control).toHaveAttribute('aria-pressed', 'true');
    }
    await expect(page.locator('.ps-range__custom input[type="date"]')).toHaveCount(2);
    await expect(page.getByRole('status', { name: 'Displayed Performance Scope' })).toContainText(
      'UTC'
    );
    const performanceGuide = page.locator('[aria-label="Performance Metric Definitions"]');
    await performanceGuide.locator('summary').click();
    await expect(performanceGuide).toContainText('Hands With A Positive Net Result');
    await page.locator('.ps-range__custom input[type="date"]').first().fill('2026-01-01');
    await expect(page.locator('.ps-range__draft')).toContainText('Draft Dates Not Applied');

    for (const width of [375, 393, 768]) {
      await page.setViewportSize({ width, height: 812 });
      await expectContainedControls(
        page,
        '.ps-controls',
        '.ps-range__tabs button, .ps-range__custom input, .ps-range__confirm, .ps-variant select'
      );
      await expect(page.getByRole('combobox', { name: 'Game', exact: true })).toBeVisible();
      await expectContainedControls(page, '.player-stats-page', '.player-stats-page > *');
      await expectContainedControls(
        page,
        '.ps-metric-guide',
        '.ps-metric-guide summary, .ps-metric-guide p'
      );
    }
    if (originalViewport) await page.setViewportSize(originalViewport);

    const statisticsAxe = await new AxeBuilder({ page }).include('.player-stats-page').analyze();
    expect(
      statisticsAxe.violations.filter((violation) =>
        ['serious', 'critical'].includes(violation.impact || '')
      )
    ).toEqual([]);
    expect(probe.responseFailures).toEqual([]);
    expect(probe.requestFailureCount).toBe(0);
    expect(
      probe.requestAbortCount,
      `Roster request timeline: ${JSON.stringify(probe.timeline)}`
    ).toBe(0);
    expect(probe.pageErrorCount).toBe(0);
    expect(probe.criticalConsoleErrorCount).toBe(0);
  });

  test('keeps linked Vault Help and section tabs keyboard accessible on phones', async ({
    page,
  }) => {
    const probe = observeMembersPath(page);
    await openMembers(page, probe);
    await page
      .getByRole('list', { name: 'Club Member Directory' })
      .getByRole('listitem')
      .first()
      .getByRole('button')
      .click();
    await expect(page.getByRole('heading', { name: 'Player Record', exact: true })).toBeVisible();
    await page.getByRole('button', { name: /Promo Vault Review/ }).click();
    await expect(page.getByRole('heading', { name: 'Promo Vault', exact: true })).toBeVisible();
    const help = page.getByRole('button', { name: 'How The Promo Vault Works', exact: true });
    const items = page.getByRole('tab', { name: 'Items', exact: true });
    const records = page.getByRole('tab', { name: 'Records', exact: true });
    for (const width of [375, 393]) {
      await page.setViewportSize({ width, height: 812 });
      await items.click();
      await expect(items).toHaveAttribute('tabindex', '0');
      await expect(records).toHaveAttribute('tabindex', '-1');
      await items.press('ArrowRight');
      await expect(records).toBeFocused();
      await expect(records).toHaveAttribute('aria-selected', 'true');
      const panelId = await records.getAttribute('aria-controls');
      expect(panelId).toBeTruthy();
      await expect(page.getByRole('tabpanel', { name: 'Records', exact: true })).toHaveAttribute(
        'id',
        panelId!
      );
      await records.press('Home');
      await expect(items).toBeFocused();
      await items.press('End');
      await expect(records).toBeFocused();
      await records.press('ArrowLeft');
      await expect(items).toBeFocused();
      await help.click();
      const dialog = page.getByRole('dialog', { name: 'How The Promo Vault Works', exact: true });
      const close = dialog.getByRole('button', { name: 'Got It', exact: true });
      await expect(close).toBeFocused();
      await expectContainedControls(page, '.pv-dialog', '.pv-dialog button');
      await expect
        .poll(
          () =>
            close.evaluate((button) => {
              const rect = button.getBoundingClientRect();
              // Sample the face, retaining all four straight edges; rounded corners are void.
              const points = [
                [rect.width / 2, 2],
                [2, rect.height / 2],
                [rect.width / 2, rect.height / 2],
                [rect.width - 2, rect.height / 2],
                [rect.width / 2, rect.height - 2],
                [rect.width / 4, rect.height / 4],
                [(rect.width * 3) / 4, rect.height / 4],
                [rect.width / 4, (rect.height * 3) / 4],
                [(rect.width * 3) / 4, (rect.height * 3) / 4],
              ];
              return points.every(
                ([x, y]) =>
                  document.elementFromPoint(rect.left + x, rect.top + y)?.closest('button') ===
                  button
              );
            }),
          { message: 'The footer must not cover any part of the Vault Help action.' }
        )
        .toBe(true);
      await close.press('Tab');
      await expect(close).toBeFocused();
      await close.press('Shift+Tab');
      await expect(close).toBeFocused();
      await close.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(help).toBeFocused();
      const buy = page.getByRole('button', { name: 'Buy More Time Bank', exact: true });
      await buy.click();
      const purchase = page.getByRole('dialog', { name: 'Buy Time Bank', exact: true });
      await expect(purchase.getByRole('spinbutton', { name: 'Quantity To Buy' })).toBeFocused();
      const cancel = purchase.getByRole('button', { name: 'Cancel', exact: true });
      await expect
        .poll(
          () =>
            cancel.evaluate((button) => {
              const rect = button.getBoundingClientRect();
              // Sample the face, retaining all four straight edges; rounded corners are void.
              const points = [
                [rect.width / 2, 2],
                [2, rect.height / 2],
                [rect.width / 2, rect.height / 2],
                [rect.width - 2, rect.height / 2],
                [rect.width / 2, rect.height - 2],
                [rect.width / 4, rect.height / 4],
                [(rect.width * 3) / 4, rect.height / 4],
                [rect.width / 4, (rect.height * 3) / 4],
                [(rect.width * 3) / 4, (rect.height * 3) / 4],
              ];
              return points.every(
                ([x, y]) =>
                  document.elementFromPoint(rect.left + x, rect.top + y)?.closest('button') ===
                  button
              );
            }),
          { message: 'The footer must not cover any part of the Vault Cancel action.' }
        )
        .toBe(true);
      await cancel.click();
      await expect(purchase).toHaveCount(0);
      await expect(buy).toBeFocused();
      await help.click();
      await close.click();
      await expect(dialog).toHaveCount(0);
      await expect(help).toBeFocused();
    }
    expect(probe.pageErrorCount).toBe(0);
    expect(probe.criticalConsoleErrorCount).toBe(0);
  });
});
