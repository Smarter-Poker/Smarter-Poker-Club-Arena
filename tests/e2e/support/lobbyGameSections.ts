import type { Page, Locator } from '@playwright/test';

/** Opening a section is a browse action; it never joins or buys in. */
export async function openLobbyGameSection(scope: Page | Locator, tab: string) {
  const family = ['MTT', 'SPINS', 'HEADS UP'].includes(tab) ? 'Tournaments' : 'Cash Games';
  const button = scope.getByRole('button', { name: family, exact: true });
  await button.waitFor({ state: 'visible', timeout: 45_000 });
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
}
