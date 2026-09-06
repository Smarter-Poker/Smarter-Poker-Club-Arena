import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const MEMBERS_PATH = 'clubs/shark-club/members';

type MembersProbe = {
  pageRpcCalls: number;
  summaryRpcCalls: number;
  responseFailures: string[];
  pageErrors: string[];
};

function observeMembersPath(page: Page): MembersProbe {
  const probe: MembersProbe = {
    pageRpcCalls: 0,
    summaryRpcCalls: 0,
    responseFailures: [],
    pageErrors: [],
  };
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/rpc/ca_club_members_page')) probe.pageRpcCalls += 1;
    if (url.includes('/rpc/ca_club_members_summary')) probe.summaryRpcCalls += 1;
  });
  page.on('response', (response) => {
    const url = response.url();
    if (
      response.status() >= 400 &&
      (url.includes('/rpc/ca_club_members_page') || url.includes('/rpc/ca_club_members_summary'))
    ) {
      probe.responseFailures.push(`${response.status()} ${new URL(url).pathname}`);
    }
  });
  page.on('pageerror', (error) => probe.pageErrors.push(error.message));
  return probe;
}

async function openMembers(page: Page, probe: MembersProbe): Promise<number> {
  const startedAt = Date.now();
  await page.goto(MEMBERS_PATH, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await expect(page).not.toHaveURL(/\/auth(?:\/|\?|$)/, { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Player Command', exact: true })).toBeVisible({
    timeout: 45_000,
  });
  await expect(page.getByRole('list', { name: 'Club Member Directory' })).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Club Member Directory' }).getByRole('listitem').first()
  ).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText('Could Not Load The Roster.', { exact: true })).toHaveCount(0);
  expect(probe.responseFailures).toEqual([]);
  expect(probe.pageErrors).toEqual([]);
  return Date.now() - startedAt;
}

test.describe('Production Shark Club Players', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

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
    await search.fill(firstAlias);
    await expect(directory.getByRole('listitem').first().locator('.member-alias')).toContainText(
      firstAlias,
      { timeout: 30_000 }
    );
    await search.fill('');

    const online = page.getByRole('button', { name: 'Online', exact: true });
    await online.click();
    await expect(online).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(/[?&]view=online(?:&|$)/);

    const allPlayers = page.getByRole('button', { name: 'All Players', exact: true });
    await allPlayers.click();
    await expect(allPlayers).toHaveAttribute('aria-pressed', 'true');
    await expect(page).not.toHaveURL(/[?&]view=/);

    const sort = page.getByRole('combobox', { name: 'Sort Players' });
    await sort.selectOption('name');
    await expect(page).toHaveURL(/[?&]sort=name(?:&|$)/);
    await expect(directory.getByRole('listitem').first()).toBeVisible({ timeout: 30_000 });

    await directory.getByRole('listitem').first().getByRole('button').click();
    await expect(page).toHaveURL(/\/clubs\/shark-club\/members\/[0-9a-f-]{36}(?:[/?#]|$)/i);
    expect(probe.responseFailures).toEqual([]);
    expect(probe.pageErrors).toEqual([]);
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
    expect(probe.pageErrors).toEqual([]);
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

    for (const range of ['Overall', '7 Days', 'Custom']) {
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
    expect(probe.pageErrors).toEqual([]);
  });
});
