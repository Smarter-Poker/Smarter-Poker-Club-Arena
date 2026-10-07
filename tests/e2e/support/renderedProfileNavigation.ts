import type { Page } from '@playwright/test';

/** Use the existing profile control and require content within one original deadline. */
export async function navigateToRenderedProfile(page: Page, baseURL: string, timeoutMs: number) {
  const target = new URL('profile', baseURL.endsWith('/') ? baseURL : `${baseURL}/`);
  const deadline = Date.now() + timeoutMs;
  const remaining = () => {
    const budget = deadline - Date.now();
    if (budget <= 0) throw new Error('Profile navigation exhausted its original deadline');
    return budget;
  };
  const studio = page.getByRole('dialog', { name: 'Make The Table Yours', exact: true });
  if (await studio.isVisible()) {
    await studio
      .getByRole('button', { name: 'Close Table Studio', exact: true })
      .click({ timeout: remaining() });
    await studio.waitFor({ state: 'hidden', timeout: remaining() });
  }
  // The real GlobalHeader uses React Router. A document reload discards the
  // reader's current app and can lose its commit notification after rendering.
  await page
    .getByRole('button', { name: 'My Profile', exact: true })
    .click({ timeout: remaining() });
  await page.waitForURL((url) => url.origin === target.origin && url.pathname === target.pathname, {
    timeout: remaining(),
  });
  const current = new URL(page.url());
  if (current.origin !== target.origin || current.pathname !== target.pathname) {
    throw new Error('Profile navigation did not reach its protected route');
  }
  await page.locator('#profile-heading').waitFor({ state: 'visible', timeout: remaining() });
}
