import type { Page } from '@playwright/test';

const CLUB_ROUTE_TIMEOUT = 60_000;
const CLUB_ROUTE_ATTEMPTS = 2;
const CLUB_ROUTE_DECISION_SELECTOR =
  '.club-home, button.invite-btn--primary, .invite-pending, .invite-card.error-state, ' +
  '[role="alert"]:has-text("Club access could not be verified"), ' +
  '[role="alert"]:has-text("This Surface Could Not Load")';

/**
 * Ensure the dedicated production E2E account can enter the club used by the
 * lobby suite. This deliberately uses the public join flow: it proves the same
 * route and RPC a player uses, without a service-role shortcut or a fabricated
 * storage flag.
 *
 * The fixture club is public and does not require approval. If that invariant
 * changes, fail the preflight with the pending/error copy instead of saving a
 * session that will make every lobby assertion time out on the invite page.
 */
export async function ensureClubMembership(
  page: Page,
  baseURL: string,
  clubId: string
): Promise<boolean> {
  const clubUrl = new URL(`clubs/${clubId}`, baseURL).toString();
  await page.goto(clubUrl, {
    waitUntil: 'domcontentloaded',
    timeout: CLUB_ROUTE_TIMEOUT,
  });

  const lobby = page.locator('.club-home');
  const join = page.getByRole('button', { name: 'Join Club', exact: true });
  const pending = page.locator('.invite-pending');
  const error = page.locator('.invite-card.error-state');
  const workspaceError = page
    .getByRole('alert')
    .filter({ hasText: /Club access could not be verified|This Surface Could Not Load/i });
  const routeDecision = page.locator(CLUB_ROUTE_DECISION_SELECTOR).first();

  for (let attempt = 0; attempt < CLUB_ROUTE_ATTEMPTS; attempt++) {
    try {
      await routeDecision.waitFor({ state: 'visible', timeout: CLUB_ROUTE_TIMEOUT });
    } catch (routeError) {
      if (attempt + 1 < CLUB_ROUTE_ATTEMPTS) {
        console.warn(`[global-setup] club route exposed no terminal surface; reloading ${clubId}.`);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: CLUB_ROUTE_TIMEOUT });
        continue;
      }

      const visibleCopy = await page
        .locator('body')
        .innerText({ timeout: 5_000 })
        .catch(() => '');
      throw new Error(
        `Club ${clubId} never exposed its lobby, join flow, or recovery state at ${page.url()}. ` +
          `Visible copy: ${visibleCopy.replace(/\s+/g, ' ').trim().slice(0, 400) || '(none)'}`,
        { cause: routeError }
      );
    }

    if (await lobby.isVisible().catch(() => false)) return false;
    if (await pending.isVisible().catch(() => false)) {
      throw new Error(`The production E2E account is pending approval for club ${clubId}.`);
    }
    if (await error.isVisible().catch(() => false)) {
      throw new Error(
        `The production E2E club preflight failed: ${(await error.textContent())?.trim() || clubId}`
      );
    }
    if (await workspaceError.isVisible().catch(() => false)) {
      if (attempt + 1 < CLUB_ROUTE_ATTEMPTS) {
        console.warn(`[global-setup] retrying the recoverable club workspace read for ${clubId}.`);
        await workspaceError.getByRole('button', { name: 'Try Again' }).click({ timeout: 10_000 });
        await workspaceError.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
        continue;
      }
      throw new Error(
        `The production E2E club workspace could not recover: ` +
          `${(await workspaceError.textContent())?.replace(/\s+/g, ' ').trim() || clubId}`
      );
    }
    if (!(await join.isVisible().catch(() => false))) {
      throw new Error(`Club ${clubId} exposed neither its lobby nor its public Join Club action.`);
    }

    console.log(`[global-setup] joining the dedicated account to E2E club ${clubId}.`);
    await join.click({ timeout: 20_000 });
    await page.locator(CLUB_ROUTE_DECISION_SELECTOR).first().waitFor({
      state: 'visible',
      timeout: CLUB_ROUTE_TIMEOUT,
    });

    if (await lobby.isVisible().catch(() => false)) {
      console.log('[global-setup] dedicated account club membership is active.');
      return true;
    }
    if (await pending.isVisible().catch(() => false)) {
      throw new Error(
        `Club ${clubId} now requires approval; the production E2E account cannot enter its lobby.`
      );
    }

    throw new Error(
      `The production E2E club join failed: ` +
        `${(await error.textContent())?.trim() || (await workspaceError.textContent())?.trim() || clubId}`
    );
  }

  throw new Error(`Club ${clubId} preflight exhausted its recovery attempts.`);
}
