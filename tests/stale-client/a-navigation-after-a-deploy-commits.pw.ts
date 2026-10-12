/**
 * A NAVIGATION RIGHT AFTER A DEPLOY COMMITS (2026-10-07).
 *
 * Post-Deploy E2E run 37620236888 failed in global setup: the first navigation
 * after a client publish sent no request for two minutes ("did not commit
 * after 2 attempts"). The tab had just reloaded onto the new release, and its
 * new service worker activated itself (skipWaiting at install) while the tab
 * was being navigated away. With these two builds that shape hung about half
 * of the time. public/sw-bus.js now waits for its tab instead, and this file
 * replays the exact sequence: an open tab, a deploy, a reload, then a
 * navigation inside the window in which the new worker used to activate.
 */
import { expect, test } from '@playwright/test';
import { newBackend, signIn } from './mock-backend';

test.skip(
  !process.env.STALE_CLIENT_DIST_B,
  'needs the build under test: see playwright.stale-client.config.ts'
);

for (const [attempt, afterReloadMs] of [100, 300, 300, 500, 700, 1000].entries()) {
  test(`a navigation ${afterReloadMs}ms after the post-deploy reload commits (#${attempt + 1})`, async ({
    page,
    request,
  }) => {
    expect((await request.get('/__deploy?to=a&pool=keep')).ok()).toBe(true);
    await signIn(page, newBackend());
    await page.goto('notifications', { waitUntil: 'domcontentloaded' });
    await expect
      .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 30_000 })
      .toBe(true);
    await page.waitForTimeout(3_000);

    expect((await request.get('/__deploy?to=b&pool=keep')).ok()).toBe(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(afterReloadMs);

    const started = Date.now();
    await page.goto('clubs/a41434bb-8d0c-400a-8f0d-e8b3d65afed4', {
      waitUntil: 'commit',
      timeout: 15_000,
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(new URL(page.url()).pathname).toMatch(/^\/hub\/club-arena\/clubs\//);
  });
}
