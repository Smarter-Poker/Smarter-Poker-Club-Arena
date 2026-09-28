import { expect, type Locator, type Page } from '@playwright/test';

/**
 * TWO LOBBY DOORS, ONE STACK (2026-09-28).
 *
 * The club lobby can open two optional full-screen doors for the same player:
 * the club's entry message (ClubEntryMessage) and the Diamond Spins invitation
 * (DiamondBustPrompt). Both are the shared Modal, which portals a
 * `.ca-modal-portal` at z-index 1000 onto document.body. Equal z-index means
 * DOM order decides the top layer, and DOM order is whichever of their two
 * independent reads answered LAST. Either door can therefore sit above the
 * other, and a new certificate account (zero chips, welcome diamonds, never
 * dismissed the greeting) gets both.
 *
 * The old handler assumed the invitation was always on top. When the greeting
 * answered second it covered the invitation, the handler clicked a Not Now the
 * pointer could never reach, and every retry reported the greeting's button
 * intercepting it until the run died. The invitation's owner now reads the
 * real stack before acting: when the greeting is above it, the greeting's own
 * owner (the action that triggered this handler) goes first, and the handler
 * runs again at the next action, when the invitation is the top layer.
 *
 * Nothing here is dismissed by force or skipped. Each door is closed through
 * its real player control, and an invitation that does not close after Not Now
 * still fails the run with its own error.
 */
export const DIAMOND_INVITATION = { role: 'dialog', name: 'Diamond Spins' } as const;
/** ClubEntryMessage labels its dialog `Club Message From ${clubName}`. */
export const CLUB_ENTRY_MESSAGE_NAME = /^Club Message From /;

export function diamondInvitation(page: Page): Locator {
  return page.getByRole('dialog', { name: DIAMOND_INVITATION.name, exact: true });
}

export interface CoveringLayer {
  /** Accessible name of the dialog that owns the covering element, if any. */
  dialog: string | null;
  /** Short markup of the element the pointer meets instead. */
  element: string;
}

/**
 * What the pointer meets at the centre of `control`, or null when it meets the
 * control itself (or the control's own dialog layer, which the click's own
 * actionability wait already handles during an entrance animation).
 */
export async function layerCovering(control: Locator): Promise<CoveringLayer | null> {
  return control.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    if (!hit || hit === el || el.contains(hit)) return null;
    const own = el.closest('[role="dialog"]');
    const ownPortal = el.closest('.ca-modal-portal');
    if ((own && own.contains(hit)) || (ownPortal && ownPortal.contains(hit))) return null;
    const hitDialog =
      hit.closest('[role="dialog"]') ??
      hit.closest('.ca-modal-portal')?.querySelector('[role="dialog"]') ??
      null;
    return {
      dialog: hitDialog?.getAttribute('aria-label') ?? null,
      element: hit.outerHTML.replace(/\s+/g, ' ').slice(0, 200),
    };
  });
}

/** Take the invitation's real Not Now door and prove it closed. */
async function declineDiamondInvitation(page: Page): Promise<void> {
  const prompt = diamondInvitation(page);
  await prompt.getByRole('button', { name: 'Not Now', exact: true }).click({ timeout: 10_000 });
  await expect(prompt, 'the Diamond Spins invitation stayed open after Not Now').toBeHidden({
    timeout: 8_000,
  });
}

/**
 * For a caller that has already retired the handler: decline an invitation
 * that is still open. Whatever covers it now has no owner, so name it.
 */
export async function declineDiamondInvitationIfShown(page: Page): Promise<void> {
  const prompt = diamondInvitation(page);
  if (!(await prompt.isVisible())) return;
  const cover = await layerCovering(prompt.getByRole('button', { name: 'Not Now', exact: true }));
  if (cover) {
    throw new Error(
      `The Diamond Spins invitation is covered by ${
        cover.dialog ? `the "${cover.dialog}" dialog` : 'an unowned layer'
      } (${cover.element})`
    );
  }
  await declineDiamondInvitation(page);
}

export async function prepareCashLobbyActions(
  page: Page,
  { retainInvitationHandler = true }: { retainInvitationHandler?: boolean } = {}
): Promise<void> {
  const diamondPrompt = diamondInvitation(page);
  if (!retainInvitationHandler) {
    // Readiness can await engine API evidence while an invitation appears.
    // Finish its real action before the short navigation assertions start;
    // otherwise their deadline can abandon the handler during dismissal.
    await page.removeLocatorHandler(diamondPrompt);
    await declineDiamondInvitationIfShown(page);
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
    // If the invitation sits beneath the greeting, its handler yields here and
    // this X goes first; the invitation is declined at the next action.
    await close.click();
    await expect(close, 'the club message blocked the live-table selector').toBeHidden({
      timeout: 8_000,
    });
  }
}

export interface DiamondInvitationOptions {
  /**
   * Where a failed decline is reported. Playwright runs locator handlers from
   * an event listener, so a handler that throws becomes an unhandled
   * rejection: inside a test it fails that test, but in global setup it
   * terminates Node and hides the error of the action that was actually
   * running. Global setup passes a collector and rethrows from its own flow.
   * The default rethrows, so a spec still fails loudly.
   */
  onFailure?: (error: unknown) => void;
}

/** The optional offer may cover either the club greeting or a later cash action. */
export async function registerDiamondInvitationDismissal(
  page: Page,
  { onFailure }: DiamondInvitationOptions = {}
): Promise<void> {
  const diamondPrompt = diamondInvitation(page);
  await page.addLocatorHandler(
    diamondPrompt,
    async () => {
      try {
        const cover = await layerCovering(
          diamondPrompt.getByRole('button', { name: 'Not Now', exact: true })
        );
        if (cover?.dialog && CLUB_ENTRY_MESSAGE_NAME.test(cover.dialog)) {
          // The greeting answered after the offer and is the top layer. Its
          // owner is the action that triggered this handler; let it act. The
          // action's own intercept check still fails loudly if nobody does.
          return;
        }
        await declineDiamondInvitation(page);
      } catch (error) {
        if (!onFailure) throw error;
        onFailure(error);
      }
    },
    // No `times`: a handler that yields to the greeting must run again once
    // the invitation is on top. No wait-after: this handler proves the offer
    // hidden itself when it acts, and must not wait on it when it yields.
    { noWaitAfter: true }
  );
}
