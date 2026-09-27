import { test, expect } from '@playwright/test';
import { rawProfileHeading } from '../support/rawProfileHeading';

// Real browser CSS/text semantics only. No app, auth, network or financial fixture.
test('profile isolation compares one text domain while preserving identity changes', async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const page = await context.newPage();
    await page.setContent(
      '<h1 id="profile-heading" style="text-transform:uppercase">Certtheme722616</h1>'
    );
    const heading = page.locator('#profile-heading');
    expect(await heading.innerText()).toBe('CERTTHEME722616');
    const unchanged = await rawProfileHeading(page);
    expect(unchanged).toBe('Certtheme722616');
    await expect(heading).toHaveText(unchanged);
    // The comparison still refuses a different identity; no case-insensitive
    // matcher, ignored assertion or normalization of account names is added.
    await heading.evaluate((node) => {
      node.textContent = 'AnotherPlayer';
    });
    await expect(heading).not.toHaveText(unchanged);
    await heading.evaluate((node) => {
      node.textContent = '';
    });
    await expect(rawProfileHeading(page)).rejects.toThrow('Profile heading has no identity');
  } finally {
    await context.close();
  }
});
