import type { Page } from '@playwright/test';

/**
 * Bring a dedicated authenticated account to the same playable state a real
 * player reaches before opening a lobby.
 *
 * The profile gate is intentionally server-backed. Seeding another localStorage
 * flag would make the suite lie about the production account, and closing the
 * modal with DOM tricks would bypass the exact invariant that protects tables.
 * Complete it through the public UI instead, choose a free library avatar, and
 * reload once to prove that both profile writes persisted.
 */
export async function ensurePlayableProfile(page: Page): Promise<boolean> {
  const gate = page.getByRole('heading', { name: 'Complete Your Profile' });
  const gateIsOpen = await gate
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);

  if (!gateIsOpen) return false;

  console.log('[global-setup] completing the dedicated account profile through the live UI.');

  await page.getByRole('button', { name: /^(?:Select|Change) Avatar$/ }).click({
    timeout: 20_000,
  });
  const gallery = page.getByRole('dialog', { name: 'Avatar Gallery' });
  await gallery.waitFor({ state: 'visible', timeout: 30_000 });

  const freeAvatar = gallery.locator('.ag-grid .ag-item:not(.ag-item--locked)').first();
  await freeAvatar.waitFor({ state: 'visible', timeout: 60_000 });
  await freeAvatar.click({ timeout: 20_000 });

  // The tile applies immediately, but Done stays disabled while its durable
  // profile write is in flight. Playwright's click waits for it to be enabled.
  await gallery.locator('button.ag-apply').click({ timeout: 60_000 });
  await gallery.waitFor({ state: 'hidden', timeout: 20_000 });

  const enterArena = page.getByRole('button', { name: 'Enter Arena' });
  await enterArena.click({ timeout: 30_000 });
  await gate.waitFor({ state: 'hidden', timeout: 30_000 });

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  const gateReturned = await gate
    .waitFor({ state: 'visible', timeout: 12_000 })
    .then(() => true)
    .catch(() => false);
  if (gateReturned) {
    throw new Error('Profile onboarding appeared again after its writes reported success.');
  }

  console.log('[global-setup] dedicated account profile is complete and persisted.');
  return true;
}
