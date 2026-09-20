import { expect, type Page } from '@playwright/test';

export async function prepareCashLobbyActions(
  page: Page,
  { retainInvitationHandler = true }: { retainInvitationHandler?: boolean } = {}
): Promise<void> {
  const diamondPrompt = page.getByRole('dialog', { name: 'Diamond Spins', exact: true });
  if (!retainInvitationHandler) {
    // Readiness can await engine API evidence while an invitation appears.
    // Finish its real action before the short navigation assertions start;
    // otherwise their deadline can abandon the handler during dismissal.
    await page.removeLocatorHandler(diamondPrompt);
    if (await diamondPrompt.isVisible()) {
      await diamondPrompt.getByRole('button', { name: 'Not Now', exact: true }).click();
      await expect(diamondPrompt).toBeHidden({ timeout: 8_000 });
    }
    // The initial selection phase already handled the club greeting.
    return;
  }
  const close = page.getByRole('button', { name: 'Close Club Message' });
  // Finish this optional probe before registering an action handler. Its short,
  // caught timeout must not abandon a still-running Diamond dismissal.
  const clubMessageVisible = await close
    .waitFor({ state: 'visible', timeout: 2_000 })
    .then(() => true)
    .catch(() => false);

  await registerDiamondInvitationDismissal(page);

  if (clubMessageVisible) {
    await close.click();
    await expect(close, 'the club message blocked the live-table selector').toBeHidden({
      timeout: 8_000,
    });
  }
}

/** The optional offer may cover either the club greeting or a later cash action. */
export async function registerDiamondInvitationDismissal(page: Page): Promise<void> {
  const diamondPrompt = page.getByRole('dialog', { name: 'Diamond Spins', exact: true });
  await page.addLocatorHandler(
    diamondPrompt,
    async () => {
      await diamondPrompt.getByRole('button', { name: 'Not Now', exact: true }).click();
      await expect(diamondPrompt).toBeHidden({ timeout: 8_000 });
    },
    { times: 1 }
  );
}
