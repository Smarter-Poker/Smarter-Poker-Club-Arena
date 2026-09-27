import { expect, test, type Page } from '@playwright/test';

const CLUB_ID = process.env.E2E_CLUB_ID || 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';

test.describe('Visible catalog production reads', () => {
  test.describe.configure({ timeout: 150_000 });
  test.skip(
    !process.env.SP_EMAIL || !process.env.SP_PASS,
    'Requires the isolated production account'
  );

  const read = (page: Page, table: string, predicate: (url: URL) => boolean) =>
    page.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          response.request().method() === 'GET' &&
          url.pathname === `/rest/v1/${table}` &&
          predicate(url)
        );
      },
      { timeout: 90_000 }
    );

  test('refreshes completed events and a selected recorded standing through real reads', async ({
    page,
  }, info) => {
    const match = (url: URL) =>
      url.searchParams.get('status') === 'eq.COMPLETED' && url.searchParams.get('limit') === '100';
    const initial = read(page, 'tournaments', match);
    await page.goto('tournament-results', { waitUntil: 'domcontentloaded' });
    const first = await initial;
    expect(first.ok()).toBe(true);
    const rows = await first.json();
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length, 'Needs a real completed event to verify standings').toBeGreaterThan(0);
    const current = rows[0];
    const selected = read(
      page,
      'tournament_players',
      (url) => url.searchParams.get('tournament_id') === `eq.${current.id}`
    );
    await page.getByText(current.name, { exact: true }).first().click();
    const standing = await selected;
    expect(standing.ok()).toBe(true);
    expect(Array.isArray(await standing.json())).toBe(true);
    // No browser reload or data write supplies either successor request.
    const nextList = read(page, 'tournaments', match);
    const nextStanding = read(
      page,
      'tournament_players',
      (url) => url.searchParams.get('tournament_id') === `eq.${current.id}`
    );
    const [listRefresh, standingRefresh] = await Promise.all([nextList, nextStanding]);
    expect(listRefresh.ok()).toBe(true);
    expect(standingRefresh.ok()).toBe(true);
    expect(await page.locator('body').innerText()).not.toContain('Could Not Load These Standings');
    await info.attach('archive-read-receipt', {
      contentType: 'application/json',
      body: JSON.stringify({
        tournamentId: current.id,
        initial: first.status(),
        refreshed: listRefresh.status(),
        standings: standingRefresh.status(),
      }),
    });
  });

  test('refreshes the authorized template catalog while preserving an unsaved draft', async ({
    page,
  }, info) => {
    const match = (url: URL) =>
      url.searchParams.get('club_id') === `eq.${CLUB_ID}` &&
      url.searchParams.get('is_deleted') === 'eq.false';
    await page.goto(`clubs/${CLUB_ID}/create-table/nlh`, { waitUntil: 'domcontentloaded' });
    const firstRead = read(page, 'table_templates', match);
    await page.getByRole('button', { name: 'MTT', exact: true }).click();
    const first = await firstRead;
    expect(first.ok()).toBe(true);
    expect(Array.isArray(await first.json())).toBe(true);
    const draft = page.getByPlaceholder('Enter Table Name Here...');
    await draft.fill('Unsubmitted Catalog Check');
    const next = await read(page, 'table_templates', match);
    expect(next.ok()).toBe(true);
    expect(Array.isArray(await next.json())).toBe(true);
    await expect(draft).toHaveValue('Unsubmitted Catalog Check');
    await info.attach('template-read-receipt', {
      contentType: 'application/json',
      body: JSON.stringify({
        clubId: CLUB_ID,
        initial: first.status(),
        refreshed: next.status(),
        saved: false,
      }),
    });
  });
});
