import type { Page } from '@playwright/test';

/** Reach Arena before asking its server-backed Terms gate for a decision. */
export async function completeCustomizationSignIn(page: Page, protectedURL: string) {
  const destination = new URL(protectedURL);
  await page.waitForURL(
    (url) => url.origin === destination.origin && !url.pathname.includes('/auth'),
    {
      timeout: 45_000,
    }
  );
  if (new URL(page.url()).pathname === '/hub/verify-phone') {
    // This is the supported optional welcome action, not phone verification.
    await Promise.all([
      page.waitForURL((url) => url.pathname !== '/hub/verify-phone', { timeout: 30_000 }),
      page.getByRole('button', { name: 'Skip For Now', exact: true }).click(),
    ]);
  }
  if (page.url() !== destination.toString()) {
    await page.goto(destination.toString(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  }
  await page.waitForURL(destination.toString(), { timeout: 30_000 });
}
