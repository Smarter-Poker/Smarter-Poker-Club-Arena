import type { Page } from '@playwright/test';

type ProfileGateStatus = 'complete' | 'incomplete' | 'unavailable';

async function waitForProfileDecision(page: Page): Promise<ProfileGateStatus> {
  const decision = page.locator(
    '[data-profile-gate-status]:not([data-profile-gate-status="pending"])'
  );
  await decision.waitFor({ state: 'attached', timeout: 60_000 });
  const status = await decision.getAttribute('data-profile-gate-status');
  if (status === 'complete' || status === 'incomplete') return status;
  if (status === 'unavailable') {
    throw new Error('The production profile query did not answer; onboarding state is unknown.');
  }
  throw new Error(`Unexpected production profile gate status: ${String(status)}`);
}

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
  // Do not infer "complete" from an absent modal while the server-backed gate
  // is still deciding, or when its query failed. That race let global setup
  // save an incomplete account, then every worker mounted the modal later.
  const status = await waitForProfileDecision(page);
  const gate = page.getByRole('heading', { name: 'Complete Your Profile' });
  if (status === 'complete') return false;
  await gate.waitFor({ state: 'visible', timeout: 20_000 });

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
  const persistedStatus = await waitForProfileDecision(page);
  if (persistedStatus !== 'complete') {
    throw new Error('Profile onboarding appeared again after its writes reported success.');
  }

  console.log('[global-setup] dedicated account profile is complete and persisted.');
  return true;
}
