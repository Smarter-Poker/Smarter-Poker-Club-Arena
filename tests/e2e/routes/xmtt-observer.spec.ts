import { readFileSync } from 'node:fs';
import { expect, test, type Response } from '@playwright/test';

const clubId = process.env.E2E_CLUB_ID || 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const listRead = (response: Response) => {
  const url = new URL(response.url());
  return (
    response.request().method() === 'GET' &&
    url.pathname === '/rest/v1/tournaments' &&
    url.searchParams.get('limit') === '50' &&
    url.searchParams.get('offset') === '0' &&
    url.searchParams.get('tournament_type') === 'in.(MTT,XMTT)'
  );
};

test('XMTT reads a bounded visible page and retains authoritative event counts', async ({
  page,
}, info) => {
  test.setTimeout(30_000);
  test.skip(
    !process.env.SP_EMAIL || !process.env.SP_PASS,
    'Requires the reserved production account'
  );
  const fixturePath = process.env.E2E_TEST_ACCOUNT_FILE;
  if (!fixturePath) throw new Error('The existing reserved account record is required.');
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  expect(fixture.email).toBe(process.env.SP_EMAIL);
  expect(fixture.email).toMatch(/^ca-customization-cert-postdeploy-.*@example\.invalid$/);
  expect(fixture.id).toMatch(/^[0-9a-f-]{36}$/i);
  const positions: Response[] = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (
      response.request().method() === 'GET' &&
      url.pathname === '/rest/v1/tournament_waitlists' &&
      url.searchParams.get('select') === 'tournament_id,position'
    )
      positions.push(response);
  });
  const initial = page.waitForResponse(listRead);
  await page.goto(`xmtt?club=${clubId}`, { waitUntil: 'domcontentloaded' });
  const response = await initial;
  expect(response.ok()).toBe(true);
  const range = response.headers()['content-range'];
  expect(range).toMatch(/^\d+-\d+\/\d+$/);
  const total = Number(range.split('/')[1]);
  const rows = await response.json();
  expect(rows.length).toBe(Math.min(50, total));
  expect(
    rows.length,
    'The production read needs existing events, never synthetic entries'
  ).toBeGreaterThan(0);
  const cards = page.locator('[data-tournament-id]');
  await expect(cards).toHaveCount(rows.length);
  await expect(page.locator('[data-xmtt-total]')).toHaveAttribute('data-xmtt-total', String(total));
  await expect.poll(() => positions.length).toBe(1);
  expect(positions[0].ok()).toBe(true);
  const positionUrl = new URL(positions[0].url());
  expect(positionUrl.searchParams.get('user_id')).toBe(`eq.${fixture.id}`);
  expect(positionUrl.searchParams.get('limit')).toBe(String(rows.length + 1));
  const ids = positionUrl.searchParams.get('tournament_id')!.slice(4, -1).split(',');
  expect(ids.sort()).toEqual(rows.map((row: { id: string }) => row.id).sort());
  if (total > 50) {
    const next = page.waitForResponse(
      (r) =>
        listRead(r) === false &&
        new URL(r.url()).pathname === '/rest/v1/tournaments' &&
        new URL(r.url()).searchParams.get('offset') === '50'
    );
    await page.getByRole('button', { name: 'Load More', exact: true }).click();
    const nextResponse = await next;
    expect(nextResponse.ok()).toBe(true);
    const extra = await nextResponse.json();
    await expect(cards).toHaveCount(50 + extra.length);
  } else {
    await expect(page.getByRole('button', { name: 'Load More', exact: true })).toHaveCount(0);
  }
  await info.attach('xmtt-read-bound', {
    body: JSON.stringify({
      total,
      initialRows: rows.length,
      renderedRows: await cards.count(),
      ownerScoped: true,
    }),
    contentType: 'application/json',
  });
  // Only reads and explicit list expansion. No register, waitlist, seat or financial command.
});
