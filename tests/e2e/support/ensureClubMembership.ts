import type { Page } from '@playwright/test';

const CLUB_ROUTE_TIMEOUT = 60_000;
const CLUB_ROUTE_ATTEMPTS = 2;
const CLUB_ROUTE_DECISION_SELECTOR =
  '.club-home, button.invite-btn--primary, .invite-pending, .invite-card.error-state, ' +
  '[role="alert"]:has-text("Club access could not be verified"), ' +
  '[role="alert"]:has-text("This Surface Could Not Load")';
const POST_JOIN_DECISION_SELECTOR =
  '.club-home, .invite-pending, .invite-card.error-state, ' +
  '[role="alert"]:has-text("Club access could not be verified"), ' +
  '[role="alert"]:has-text("This Surface Could Not Load")';

async function readableText(locator: ReturnType<Page['locator']>): Promise<string> {
  return ((await locator.textContent({ timeout: 1_000 }).catch(() => '')) || '')
    .replace(/\s+/g, ' ')
    .trim();
}

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
    // The decision selector below is the real application-ready contract.
    // Waiting for DOMContentLoaded first can stall for a full minute when an
    // unrelated production asset is slow even though the SPA route has already
    // committed and can render its lobby/recovery state.
    waitUntil: 'commit',
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
        await page.reload({ waitUntil: 'commit', timeout: CLUB_ROUTE_TIMEOUT });
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
    /* The pre-click selector includes the Join Club button. Reusing it here
       returned immediately while the RPC was still in flight, then the error
       path waited 30 seconds on an absent error card and hid the real state
       behind a locator timeout. After a click, only a terminal destination is
       a decision: lobby, pending approval, or a rendered recovery surface. */
    try {
      await page.locator(POST_JOIN_DECISION_SELECTOR).first().waitFor({
        state: 'visible',
        timeout: CLUB_ROUTE_TIMEOUT,
      });
    } catch (joinError) {
      const visibleCopy = await page
        .locator('body')
        .innerText({ timeout: 5_000 })
        .catch(() => '');
      throw new Error(
        `Club ${clubId} join never reached its lobby, pending state, or recovery surface at ${page.url()}. ` +
          `Visible copy: ${visibleCopy.replace(/\s+/g, ' ').trim().slice(0, 400) || '(none)'}`,
        { cause: joinError }
      );
    }

    if (await lobby.isVisible().catch(() => false)) {
      console.log('[global-setup] dedicated account club membership is active.');
      return true;
    }
    if (await pending.isVisible().catch(() => false)) {
      throw new Error(
        `Club ${clubId} now requires approval; the production E2E account cannot enter its lobby.`
      );
    }

    const errorCopy = (await readableText(error)) || (await readableText(workspaceError));
    throw new Error(`The production E2E club join failed: ${errorCopy || clubId}`);
  }

  throw new Error(`Club ${clubId} preflight exhausted its recovery attempts.`);
}
