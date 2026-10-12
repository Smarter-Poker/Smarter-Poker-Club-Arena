import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  deleteServiceRows,
  insertServiceRows,
  readServiceRows,
  requireCustomizationCertificationEnvironment,
} from './support/temporaryCustomizationAccount';

/** Real inbox/feed/mutations, exclusively the workflow's disposable account. */
test('published notifications retain pending signals and confirm durable actions', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const accountPath = process.env.E2E_TEST_ACCOUNT_FILE;
  if (!accountPath) throw new Error('The isolated post-deploy account record is required.');
  const account = JSON.parse(readFileSync(accountPath, 'utf8')) as { id?: string; email?: string };
  if (
    !account.id ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(account.id) ||
    !account.email?.startsWith('ca-customization-cert-postdeploy-') ||
    !account.email.endsWith('@example.invalid') ||
    account.email !== process.env.SP_EMAIL
  )
    throw new Error('Notification proof refuses an account outside its owning workflow.');
  const environment = requireCustomizationCertificationEnvironment();
  const id = randomUUID();
  const query = new URLSearchParams({ id: `eq.${id}`, user_id: `eq.${account.id}` });
  const title = `Notification Proof ${id.slice(0, 8)}`;
  const before = await page.request.get('build-info.json');
  expect(before.ok()).toBe(true);
  const selected = (await before.json()).ca_sha;
  expect(selected).toMatch(/^[a-f0-9]{40}$/);
  let releaseDelete: (() => void) | undefined;
  try {
    console.log('[notification-proof] Create The Reserved Inbox Signal');
    await insertServiceRows(environment, 'notifications', {
      id,
      user_id: account.id,
      type: 'notification_certification',
      title,
      message: 'This Signal Belongs Only To The Disposable Publication Proof Account.',
      action_url: '/hub/club-arena/settings?tab=notifications',
      read: false,
      is_read: false,
    });
    console.log('[notification-proof] Read The Published Inbox');
    await page.goto('notifications', { waitUntil: 'domcontentloaded' });
    const row = page.locator(`[data-notif-id="${id}"]`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    console.log('[notification-proof] Check Mobile And Desktop Fit');
    for (const width of [375, 393, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
        )
      ).toBe(true);
    }
    await page.setViewportSize({ width: 375, height: 900 });
    const pending = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    let deleteCalls = 0;
    await page.route('**/api/notifications/delete', async (route) => {
      const body = route.request().postDataJSON();
      if (body?.id !== id) return route.continue();
      deleteCalls++;
      await pending;
      await route.fulfill({ status: 503, json: { success: false } });
    });
    console.log('[notification-proof] Begin The Delayed Dismissal');
    await row.getByRole('button', { name: `Dismiss ${title}`, exact: true }).click();
    await expect(row).toHaveAttribute('aria-busy', 'true');
    await expect(row.getByRole('button', { name: `Dismiss ${title}`, exact: true })).toBeDisabled();
    await expect(row).toHaveCSS('opacity', '1');
    await expect(row).toBeVisible();
    // Pending UI precedes the authenticated request. Observe its receipt,
    // rather than assuming that rendering has finished the session read.
    await expect
      .poll(() => deleteCalls, {
        timeout: 10_000,
        message: 'The Reserved Dismissal Must Reach Its Owning Route Exactly Once.',
      })
      .toBe(1);
    console.log('[notification-proof] Capture The Pending Signal');
    await page.screenshot({
      path: testInfo.outputPath('notification-pending-mobile.png'),
      fullPage: true,
    });
    console.log('[notification-proof] Refuse The Delayed Dismissal');
    releaseDelete();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Dismissal Could Not Be Confirmed' })
    ).toBeVisible();
    await expect(row).toBeVisible();
    await page.unroute('**/api/notifications/delete');

    console.log('[notification-proof] Refuse The Read Action');
    await page.route('**/api/notifications/mark-read', (route) =>
      route.fulfill({ status: 503, json: { success: false } })
    );
    await page.getByRole('button', { name: 'Mark All Read', exact: true }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Read Status Could Not Be Confirmed' })
    ).toBeVisible();
    await expect(row).toHaveClass(/ca-notif__row--unread/);
    const unchanged = await readServiceRows<{ read: boolean }>(environment, 'notifications', query);
    expect(unchanged).toHaveLength(1);
    expect(unchanged[0].read).toBe(false);
    console.log('[notification-proof] Confirm The Durable Read');
    await page.unroute('**/api/notifications/mark-read');
    await page.getByRole('button', { name: 'Mark All Read', exact: true }).click();
    await expect(row).not.toHaveClass(/ca-notif__row--unread/);
    await expect
      .poll(async () => {
        const rows = await readServiceRows<{ read: boolean }>(environment, 'notifications', query);
        return rows[0]?.read;
      })
      .toBe(true);
    console.log('[notification-proof] Confirm The Read After Reload');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(row).toBeVisible();
    await expect(row).not.toHaveClass(/ca-notif__row--unread/);
    await row.getByRole('button', { name: `Dismiss ${title}`, exact: true }).click();
    console.log('[notification-proof] Confirm The Durable Dismissal');
    await expect(row).toHaveCount(0);
    expect(await readServiceRows(environment, 'notifications', query)).toHaveLength(0);
    console.log('[notification-proof] Confirm Alert Controls And Release Identity');
    await page.getByRole('button', { name: 'Alert Controls', exact: true }).click();
    await expect(page).toHaveURL(/\/settings\?tab=notifications$/);
    const after = await page.request.get('build-info.json');
    expect(after.ok()).toBe(true);
    expect((await after.json()).ca_sha).toBe(selected);
    await testInfo.attach('notification-live-proof', {
      body: JSON.stringify({
        clientSha: selected,
        widths: [375, 393, 1440],
        pendingVisible: true,
        refusalVisible: true,
        readConfirmed: true,
        dismissalConfirmed: true,
      }),
      contentType: 'application/json',
    });
  } finally {
    console.log('[notification-proof] Remove The Reserved Signal');
    releaseDelete?.();
    await deleteServiceRows(environment, 'notifications', query);
    expect(await readServiceRows(environment, 'notifications', query)).toHaveLength(0);
  }
});
