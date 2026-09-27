import { expect, type Page } from '@playwright/test';

/** A rendered heading can precede the account's asynchronous preference read. */
export async function readProfileInterfaceMode(
  page: Page,
  timeoutMs: number
): Promise<'dark' | 'light'> {
  let mode: string | null = null;
  await expect
    .poll(
      async () => {
        mode = await page.locator('html').getAttribute('data-theme');
        return mode;
      },
      { timeout: timeoutMs, message: 'The account interface mode never became ready' }
    )
    .toMatch(/^(?:dark|light)$/);
  if (mode !== 'dark' && mode !== 'light') throw new Error('Account interface mode unavailable');
  return mode;
}
