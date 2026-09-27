import { readFileSync } from 'node:fs';
import { expect, test, type Page, type Response } from '@playwright/test';

const unionClub = process.env.E2E_CLUB_ID || 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const standaloneClub = process.env.E2E_TEMPLATE_CLUB_ID || '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
function reservedAccount() {
  const path = process.env.E2E_TEST_ACCOUNT_FILE;
  if (!path) throw new Error('Existing reserved production account is required');
  const account = JSON.parse(readFileSync(path, 'utf8'));
  expect(account.email).toBe(process.env.SP_EMAIL);
  expect(account.email).toMatch(/^ca-customization-cert-postdeploy-.*@example\.invalid$/);
  expect(account.id).toMatch(/^[0-9a-f-]{36}$/i);
  return account;
}
const rpc = (page: Page, name: string) =>
  page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/rest/v1/rpc/${name}`,
    { timeout: 60_000 }
  );
const row = async (response: Response) => {
  expect(response.ok()).toBe(true);
  const data = await response.json();
  const value = Array.isArray(data) ? data[0] : data;
  expect(value).toBeTruthy();
  return value;
};

test.describe('Scoped money observers use actual read results', () => {
  test.skip(
    !process.env.SP_EMAIL || !process.env.SP_PASS,
    'Requires the existing reserved production account'
  );

  for (const [kind, clubId] of [
    ['union', unionClub],
    ['standalone', standaloneClub],
  ]) {
    test(`BBJ facts render the authorized ${kind} club pool response`, async ({ page }, info) => {
      test.setTimeout(90_000);
      reservedAccount();
      const poolRead = page.waitForResponse(
        (response) => {
          const url = new URL(response.url());
          return (
            response.request().method() === 'GET' &&
            url.pathname === '/rest/v1/bbj_pools' &&
            !!url.searchParams.get('select')?.includes('main_balance')
          );
        },
        { timeout: 60_000 }
      );
      const clubRead = page.waitForResponse(
        (response) => {
          const url = new URL(response.url());
          return (
            response.request().method() === 'GET' &&
            url.pathname === '/rest/v1/clubs' &&
            url.searchParams.get('id') === `eq.${clubId}` &&
            url.searchParams.get('select') === 'union_id'
          );
        },
        { timeout: 60_000 }
      );
      const facts = rpc(page, 'fn_bbj_pool_facts');
      const mine = rpc(page, 'fn_bbj_my_contribution');
      const promo = rpc(page, 'fn_bbj_promo_facts');
      await page.goto(`clubs/${clubId}/jackpot`, { waitUntil: 'domcontentloaded' });
      const [clubResponse, poolResponse, factsResponse, mineResponse, promoResponse] =
        await Promise.all([clubRead, poolRead, facts, mine, promo]);
      const club = await row(clubResponse);
      const pool = await row(poolResponse);
      const poolUrl = new URL(poolResponse.url());
      expect(kind === 'union' ? typeof club.union_id === 'string' : club.union_id === null).toBe(
        true
      );
      expect(poolUrl.searchParams.get(kind === 'union' ? 'union_id' : 'club_id')).toBe(
        `eq.${kind === 'union' ? club.union_id : clubId}`
      );
      for (const response of [factsResponse, mineResponse, promoResponse]) {
        expect(response.request().postDataJSON().p_pool_id).toBe(pool.id);
        expect(response.request().postDataJSON()).not.toHaveProperty('p_user_id');
      }
      const fact = await row(factsResponse);
      const own = await row(mineResponse);
      const promotional = await row(promoResponse);
      expect(mineResponse.request().postDataJSON().p_days).toBe(90);
      expect(typeof own.attributed_chips).toBe('number');
      expect(Number.isFinite(own.attributed_chips)).toBe(true);
      expect(promotional.is_operator).toBe(true);
      expect(typeof promotional.purse_available).toBe('number');
      expect(Number.isFinite(promotional.purse_available)).toBe(true);
      expect(typeof fact.hands_contributed).toBe('number');
      expect(typeof fact.total_contributed).toBe('number');
      expect(Number.isFinite(Number(fact.hands_contributed))).toBe(true);
      expect(Number.isFinite(Number(fact.total_contributed))).toBe(true);
      const value = (label: string) =>
        page
          .locator('.bbj-page__row')
          .filter({
            has: page.getByText(label, { exact: true }),
          })
          .locator('.bbj-page__row-value');
      await expect(value('Hands Contributed')).toHaveText(
        Number(fact.hands_contributed).toLocaleString('en-US')
      );
      await expect(value('Total Collected')).toHaveText(
        `${Number(fact.total_contributed).toLocaleString('en-US')} Chips`
      );
      if (own.attributed_chips > 0) {
        await expect(value('Your Contribution (90D)')).toHaveText(
          `${Math.round(own.attributed_chips).toLocaleString('en-US')} Chips`
        );
      } else {
        await expect(page.getByText('Your Contribution (90D)', { exact: true })).toHaveCount(0);
      }
      await expect(value('The Promo Slice')).toHaveText(
        `${Math.round(promotional.purse_available).toLocaleString('en-US')} Chips`
      );
      await expect(page.getByText('Could Not Load The Jackpot', { exact: true })).toHaveCount(0);
      await info.attach(`bbj-${kind}-facts-read`, {
        contentType: 'application/json',
        body: JSON.stringify({
          clubId,
          unionId: club.union_id,
          poolId: pool.id,
          status: factsResponse.status(),
          hands: fact.hands_contributed,
          chips: fact.total_contributed,
          ownReadSucceeded: own !== null,
          promoReadSucceeded: promotional !== null,
          moneyCommands: false,
        }),
      });
    });
  }

  test('rakeback discovers the signed-in owner through both bounded reads while the page stays open', async ({
    page,
  }, info) => {
    test.setTimeout(150_000);
    const account = reservedAccount();
    const read = (limit: number) =>
      page.waitForResponse(
        (response) => {
          const url = new URL(response.url());
          return (
            response.request().method() === 'GET' &&
            url.pathname === '/rest/v1/rakeback_periods' &&
            url.searchParams.get('user_id') === `eq.${account.id}` &&
            url.searchParams.get('limit') === String(limit)
          );
        },
        { timeout: 90_000 }
      );
    const firstHistory = read(12);
    const firstReady = read(1);
    await page.goto('rakeback', { waitUntil: 'domcontentloaded' });
    const initial = await Promise.all([firstHistory, firstReady]);
    for (const response of initial) expect(response.ok()).toBe(true);
    // No route transition, write or local balance event supplies these reads.
    const refreshed = await Promise.all([read(12), read(1)]);
    const values = await Promise.all(
      refreshed.map(async (response) => {
        expect(response.ok()).toBe(true);
        const rows = await response.json();
        expect(Array.isArray(rows)).toBe(true);
        expect(rows.every((entry: { user_id: string }) => entry.user_id === account.id)).toBe(true);
        expect(rows.length).toBeLessThanOrEqual(
          Number(new URL(response.url()).searchParams.get('limit'))
        );
        return rows;
      })
    );
    const readyUrl = new URL(refreshed[1].url());
    expect(readyUrl.searchParams.get('status')).toBe('eq.pending');
    expect(readyUrl.searchParams.get('rakeback_earned')).toBe('gt.0');
    expect(readyUrl.searchParams.get('club_id')).toBe('not.is.null');
    expect(readyUrl.searchParams.get('period_end')).toMatch(/^lt\.\d{4}-\d{2}-\d{2}$/);
    const summary = page.getByLabel('Rakeback Engine Live Summary');
    const earnings = values[0].reduce(
      (sum: number, entry: { rakeback_earned: number }) => sum + entry.rakeback_earned,
      0
    );
    await expect(
      summary
        .locator('div')
        .filter({ has: page.getByText('Recent Earnings', { exact: true }) })
        .locator('dd')
    ).toHaveText(earnings.toLocaleString('en-US'));
    await expect(
      page.getByText('Rakeback Data Could Not Be Refreshed. Please Try Again.', { exact: true })
    ).toHaveCount(0);
    await info.attach('rakeback-visible-read', {
      contentType: 'application/json',
      body: JSON.stringify({
        owner: account.id,
        initial: initial.map((response) => response.status()),
        refreshed: refreshed.map((response) => response.status()),
        rows: values.map((entries) => entries.length),
        externalPayoutInduced: false,
      }),
    });
  });
});
