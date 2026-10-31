import type { Page } from '@playwright/test';

/** Read the profile's exact identity, excluding independent nested streak badges. */
export async function rawProfileHeading(page: Page): Promise<string> {
  const text = await page.locator('#profile-heading').evaluate((heading) =>
    Array.from(heading.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('')
      .trim()
  );
  if (text === '') throw new Error('Profile heading has no identity');
  return text;
}
