import { expect, test, type Page } from '@playwright/test';
import { waitForGameCreationAuthority } from '../support/gameCreationReadiness';

const CLUB_ID = process.env.E2E_TEMPLATE_CLUB_ID || '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';

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
    // Wait for the same caller-bound read that opens GameCreationGuard before
    // starting the unchanged control assertion. The overall 150s test and 90s
    // read budgets stay fixed; a completed denial or failed read is not ready.
    const permission = waitForGameCreationAuthority(page, CLUB_ID, 90_000);
    await Promise.all([
      permission,
      page.goto(`clubs/${CLUB_ID}/create-table/nlh`, { waitUntil: 'domcontentloaded' }),
    ]);
    await expect(page.getByRole('button', { name: 'MTT', exact: true })).toBeVisible();
    const mtt = page.getByRole('button', { name: 'MTT', exact: true });
    const firstRead = read(page, 'table_templates', match);
    // Run 37091537727: the click resolved but the form still showed Regular
    // pressed, so the MTT-only catalog read never started and this waited out
    // its whole 90s budget. The read is caused by the selected format, so
    // prove the selection took before waiting on the read it causes.
    await expect(async () => {
      if ((await mtt.getAttribute('aria-pressed')) !== 'true') await mtt.click();
      await expect(mtt).toHaveAttribute('aria-pressed', 'true', { timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    const first = await firstRead;
    expect(first.ok()).toBe(true);
    expect(Array.isArray(await first.json())).toBe(true);
    const draft = page.getByPlaceholder('Enter Table Name Here...');
    await draft.fill('Unsubmitted Catalog Check');
    const nextRead = read(page, 'table_templates', match);
    // A visible lifecycle signal is one of useVisibleRead's production refresh
    // contracts. Trigger it directly instead of spending a minute waiting for
    // the fallback interval; this still exercises a real authorized read and
    // proves that the in-progress draft survives it.
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    const next = await nextRead;
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
