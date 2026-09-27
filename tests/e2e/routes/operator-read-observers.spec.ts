import { expect, test, type Response } from '@playwright/test';

const clubId = process.env.E2E_CLUB_ID || 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const heatmapProjection =
  'id,name,status,current_players,max_players,small_blind,big_blind,game_variant';

test('the visible operator heatmap refreshes through its scoped narrow read', async ({ page }) => {
  test.skip(
    !process.env.SP_EMAIL || !process.env.SP_PASS,
    'The existing reserved production staff fixture is required.'
  );
  test.setTimeout(120_000);
  const reads: Response[] = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (
      url.pathname.endsWith('/rest/v1/tables') &&
      response.request().method() === 'GET' &&
      url.searchParams.get('select')?.replace(/\s/g, '') === heatmapProjection
    )
      reads.push(response);
  });
  await page.goto(`admin?club=${clubId}`, { waitUntil: 'domcontentloaded' });
  await expect(page).not.toHaveURL(/\/auth(?:\/|\?|$)/, { timeout: 30_000 });
  await page
    .getByRole('tablist', { name: 'Operations Views' })
    .getByRole('tab', { name: 'Analytics', exact: true })
    .click({ timeout: 30_000 });
  await expect(
    page.getByRole('heading', { name: 'Table Heatmap - God View', exact: true })
  ).toBeVisible();
  await expect.poll(() => reads.length, { timeout: 45_000 }).toBeGreaterThanOrEqual(2);
  const last = reads.at(-1)!;
  for (const response of [reads[0], last]) {
    expect(response.status()).toBe(200);
    const url = new URL(response.url());
    expect(url.searchParams.get('or')).toMatch(
      new RegExp(`^\\(club_id\\.eq\\.${clubId}(,union_id\\.eq\\.[0-9a-f-]{36})?\\)$`)
    );
    expect(url.searchParams.get('is_deleted')).toBe('eq.false');
    expect(Array.isArray(await response.json())).toBe(true);
  }
  const rows = await last.json();
  if (rows.length) {
    const active = rows.filter((row: any) => row.status !== 'deleted' && row.status !== 'closed');
    await expect(page.getByText(`${active.length} Active Tables`, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Density', exact: true })).toBeVisible();
  } else {
    await expect(
      page.getByText('No Tables Available For God View.', { exact: true })
    ).toBeVisible();
  }
  await expect(
    page.getByText('Table Activity Could Not Be Refreshed.', { exact: false })
  ).toHaveCount(0);
  // Existing staff identity and read-only navigation. No seat, wallet or game command.
});
