import type { Locator, Page } from '@playwright/test';

/** Read the persistent wallet total, distinct from the repeated header summary. */
export function walletPlayableAmount(page: Page): Locator {
  return page
    .getByRole('region', { name: 'All Wallets Combined', exact: true })
    .getByText('Playable Now', { exact: true })
    .locator('..')
    .locator('dd');
}
