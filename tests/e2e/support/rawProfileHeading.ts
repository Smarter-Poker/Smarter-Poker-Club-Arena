import type { Page } from '@playwright/test';

/** Capture the same text domain used by Playwright's default toHaveText. */
export async function rawProfileHeading(page: Page): Promise<string> {
  const text = await page.locator('#profile-heading').textContent();
  if (text === null || text.trim() === '') throw new Error('Profile heading has no identity');
  return text.trim();
}
