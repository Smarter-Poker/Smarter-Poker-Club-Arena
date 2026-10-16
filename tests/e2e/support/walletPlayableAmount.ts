import type { Locator, Page } from '@playwright/test';

/** Independent expected text for the persisted available-chip amount. */
export function expectedPlayableWalletFigure(amount: number): string {
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Invalid available wallet amount');
  if (amount < 1_000_000)
    return amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const unit = amount >= 1_000_000_000 ? 1_000_000_000 : 1_000_000;
  return `${Math.floor((amount / unit) * 10) / 10}${unit === 1_000_000 ? 'M' : 'B'}`;
}

/** Read the persistent wallet total, distinct from the repeated header summary. */
export function walletPlayableAmount(page: Page): Locator {
  return page
    .getByRole('region', { name: 'All Wallets Combined', exact: true })
    .getByText('Playable Now', { exact: true })
    .locator('..')
    .locator('dd');
}
