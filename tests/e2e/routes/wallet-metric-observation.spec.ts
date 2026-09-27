import { test, expect } from '@playwright/test';
import { walletPlayableAmount } from '../support/walletPlayableAmount';

// Actual browser locator semantics, without an account or financial mutation.
test('wallet totals remain exact when the header repeats Playable Now', async ({ browser }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const page = await context.newPage();
    await page.setContent(`
      <header><dl><div><dt>Playable Now</dt><dd>0</dd></div></dl></header>
      <section aria-labelledby="vault-hero-title">
        <h2 id="vault-hero-title">All Wallets Combined</h2>
        <dl><div><dt>Playable Now</dt><dd>37.5</dd></div></dl>
      </section>
    `);
    const priorLocator = page
      .getByText('Playable Now', { exact: true })
      .locator('..')
      .locator('dd');
    await expect(priorLocator).toHaveCount(2);
    await expect(priorLocator.textContent()).rejects.toThrow('strict mode violation');
    const actualTotal = walletPlayableAmount(page);
    await expect(actualTotal).toHaveText('37.5');
    await actualTotal.evaluate((node) => {
      node.textContent = '38';
    });
    await expect(actualTotal).not.toHaveText('37.5');
    await expect(actualTotal).toHaveText('38');
    // A missing totals section must remain a missing result, not select the header.
    await page
      .getByRole('region', { name: 'All Wallets Combined', exact: true })
      .evaluate((node) => node.remove());
    await expect(walletPlayableAmount(page)).toHaveCount(0);
  } finally {
    await context.close();
  }
});
