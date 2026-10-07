import type { Page } from '@playwright/test';

/** Require committed navigation and real profile content within one existing deadline. */
export async function navigateToRenderedProfile(page: Page, baseURL: string, timeoutMs: number) {
  const target = new URL('profile', baseURL.endsWith('/') ? baseURL : `${baseURL}/`);
  const deadline = Date.now() + timeoutMs;
  // Run37565880099 rendered the profile but lost DOMContentLoaded. Commit is
  // the navigation boundary; the actual heading below is the readiness proof.
  await page.goto(target.href, { waitUntil: 'commit', timeout: timeoutMs });
  const current = new URL(page.url());
  if (current.origin !== target.origin || current.pathname !== target.pathname) {
    throw new Error('Profile navigation did not reach its protected route');
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Profile navigation exhausted its original deadline');
  await page.locator('#profile-heading').waitFor({ state: 'visible', timeout: remaining });
}
