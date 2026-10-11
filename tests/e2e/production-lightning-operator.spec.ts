/** Read-only Lightning cold loads. Never submit an operator decision. */
import { expect, test } from '@playwright/test';

const club = process.env.E2E_CLUB_ID || 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const overviewRpc = '/rest/v1/rpc/fn_lightning_operator_overview';
const clusterRpc = '/rest/v1/rpc/fn_lightning_operator_cluster';

for (const width of [393, 1440]) {
  test(`Lightning operator cold load at ${width}px preserves read ownership and cancel`, async ({
    page,
  }, info) => {
    test.setTimeout(90_000);
    expect(
      Boolean(process.env.SP_EMAIL && process.env.SP_PASS),
      'isolated authenticated account required'
    ).toBe(true);
    await page.setViewportSize({ width, height: 900 });
    const writes: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (
        path === '/rest/v1/rpc/fn_lightning_operator_control' ||
        path === '/rest/v1/rpc/fn_lightning_operator_signal_review'
      )
        writes.push(path);
    });
    const overview = page.waitForResponse((r) => new URL(r.url()).pathname === overviewRpc);
    await page.goto(`clubs/${club}/lightning`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:\/|\?|$)/);
    const response = await overview;
    expect(response.status()).toBe(200);
    expect(response.request().postDataJSON().p_club_id).toBe(club);
    const body = await response.json();
    expect(body.ok).not.toBe(false);
    expect(Array.isArray(body.clusters)).toBe(true);
    expect(body.clusters.length, 'real Lightning-capable cluster required').toBeGreaterThan(0);
    await expect(page.locator('#lightning-operations-title')).toHaveText('Lightning');
    await expect(page.getByText(/Updates On Lightning Events/)).toBeVisible();
    const record = page.locator('[data-cluster-id]').first();
    await expect(record).toBeVisible();
    const cluster = await record.getAttribute('data-cluster-id');
    expect(cluster).toMatch(/^[0-9a-f-]{36}$/);
    // A new document with the selected cluster has no SPA overview state.
    const detail = page.waitForResponse((r) => new URL(r.url()).pathname === clusterRpc);
    await page.goto(`clubs/${club}/lightning?cluster=${cluster}`, {
      waitUntil: 'domcontentloaded',
    });
    const detailResponse = await detail;
    expect(detailResponse.status()).toBe(200);
    expect(detailResponse.request().postDataJSON().p_cluster_id).toBe(cluster);
    expect((await detailResponse.json()).ok).not.toBe(false);
    await expect(page.locator('#lightning-controls')).toHaveText('Operator Controls');
    const worker = page.getByRole('group', { name: 'Worker Mode', exact: true });
    await expect(worker).toBeVisible();
    await expect(worker.getByRole('button')).toHaveCount(3);
    const available = worker.locator('button:enabled').first();
    await expect(available).toBeVisible();
    await available.click();
    const dialog = page.locator('[data-control-dialog="set_worker_mode"]');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
    await info.attach(`lightning-${width}-confirmation.png`, {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
      )
    ).toBe(true);
    expect(writes, 'opening and canceling a decision must never write').toEqual([]);
    await info.attach(`lightning-${width}-operator.png`, {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    const build = await page.request.get('build-info.json', {
      headers: { 'Cache-Control': 'no-cache' },
    });
    expect(build.ok()).toBe(true);
    const provenance = await build.json();
    if (process.env.LIVE_SHA)
      expect(provenance.ca_sha ?? provenance.sha ?? provenance.commit).toBe(process.env.LIVE_SHA);
  });
}
