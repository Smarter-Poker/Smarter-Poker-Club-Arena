import { expect, test, type Response } from '@playwright/test';

const clubId = process.env.E2E_CLUB_ID || 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const tableResponse = (response: Response, table: string) => {
  const url = new URL(response.url());
  return url.pathname.endsWith(`/rest/v1/${table}`) && response.request().method() === 'GET';
};

test.describe('Visible achievement and rate history readers', () => {
  test.skip(
    !process.env.SP_EMAIL || !process.env.SP_PASS,
    'Reserved authenticated production fixture is required.'
  );

  test('reads the signed-in achievement progress again while the page stays visible', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    const reads: Response[] = [];
    page.on('response', (response) => {
      if (tableResponse(response, 'training_user_achievements')) reads.push(response);
    });
    await page.goto('achievements', { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:\/|\?|$)/, { timeout: 30_000 });
    await expect(
      page.getByRole('heading', { name: 'Achievement Archive', exact: true })
    ).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => reads.length, { timeout: 90_000 }).toBeGreaterThanOrEqual(2);
    const first = reads[0];
    const ownerFilter = new URL(first.url()).searchParams.get('user_id');
    expect(ownerFilter).toMatch(/^eq\.[0-9a-f-]{36}$/);
    for (const response of [first, reads.at(-1)!]) {
      expect(response.status()).toBe(200);
      const url = new URL(response.url());
      expect(url.searchParams.get('user_id')).toBe(ownerFilter);
      expect(url.searchParams.get('select')).toBe('id,achievement_id,user_id,progress,unlocked_at');
      const rows = await response.json();
      expect(Array.isArray(rows)).toBe(true);
      for (const row of rows) expect(`eq.${row.user_id}`).toBe(ownerFilter);
    }
    await expect(
      page.getByRole('button', { name: 'Open Getting Started', exact: true })
    ).toBeVisible();
    await expect(
      page.getByText('Achievement progress could not be loaded.', { exact: true })
    ).toHaveCount(0);
    // Read-only proof: no unlock, reward, financial command or fixture mutation.
  });

  test('reads both club-scoped rate histories again without a WAL subscription', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const reads = new Map<string, Response[]>([
      ['commission_rate_audit', []],
      ['rake_rate_audit', []],
    ]);
    page.on('response', (response) => {
      for (const [table, list] of reads) if (tableResponse(response, table)) list.push(response);
    });
    await page.goto(`rate-audit?club=${clubId}`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:\/|\?|$)/, { timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'Rate Audit Trail', exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect
      .poll(() => Math.min(...[...reads.values()].map((list) => list.length)), { timeout: 60_000 })
      .toBeGreaterThanOrEqual(2);
    let expectedCount = 0;
    for (const list of reads.values()) {
      for (const response of [list[0], list.at(-1)!]) {
        expect(response.status()).toBe(200);
        const url = new URL(response.url());
        expect(url.searchParams.get('club_id')).toBe(`eq.${clubId}`);
        expect(url.searchParams.get('limit')).toBe('100');
        expect(Array.isArray(await response.json())).toBe(true);
      }
      expectedCount += (await list.at(-1)!.json()).length;
    }
    await expect(page.getByText(`${expectedCount} Changes`, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
  });
});
