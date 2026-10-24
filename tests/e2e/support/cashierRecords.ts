import { expect, type Locator, type Page } from '@playwright/test';

/** Observe the ledger read caused by this tab before classifying its result. */
export async function openTradeRecord(page: Page, tablist: Locator): Promise<void> {
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes('/rest/v1/rpc/fn_cashier_transaction_history'),
      { timeout: 30_000 }
    ),
    tablist.getByRole('tab', { name: 'Transaction History', exact: true }).click(),
  ]);
  await expect(page.getByRole('tabpanel', { name: 'Transaction History' })).toHaveAttribute(
    'aria-busy',
    'false',
    { timeout: 30_000 }
  );
}
