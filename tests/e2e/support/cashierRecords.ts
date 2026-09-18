import { expect, type Locator, type Page } from '@playwright/test';

/** Observe the ledger read caused by this tab before classifying its result. */
export async function openTradeRecord(page: Page, tablist: Locator): Promise<void> {
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes('/rest/v1/rpc/fn_club_trade_ledger'),
      { timeout: 30_000 }
    ),
    tablist.getByRole('tab', { name: 'Trade Record', exact: true }).click(),
  ]);
  await expect(page.getByRole('tabpanel', { name: 'Trade Record' })).toHaveAttribute(
    'aria-busy',
    'false',
    { timeout: 30_000 }
  );
}
