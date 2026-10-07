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

/**
 * HOW LONG THE REAL NOT NOW CLICK MAY WAIT FOR THE PAGE TO HOLD STILL.
 *
 * Playwright's click waits for the control to be stable, which it measures on
 * the page's own animation frames. Production run 36533736673 (WebKit, cash
 * case, 2026-09-29): the Not Now plate's first stability check took 5.0s to
 * answer and the retry took the rest of the old 10s budget, so the click died
 * on "element is not stable" without ever being refused by the card.
 *
 * The card itself is not slow. The real Modal and SpadeConsole (crest diamond,
 * 390x664) settle in 409ms in isolation, and again with the main thread held
 * 180ms of every 200ms; the entrance is one 350ms keyframe run and nothing
 * else moves a plate. What took 5s per check was the page's frame clock while
 * the offer opened over a freshly loaded 466-game lobby on a shared CI runner
 * (its chunks were still arriving in 2-5s responses). A stability check cannot
 * finish faster than the page gives out frames, so a wait shorter than two of
 * those stalls is a wait for the runner, not a finding about the card.
 *
 * TWO STAGES, BECAUSE A COVERED PLATE MUST STILL BE REPORTED FAST. The first
 * stage is the unchanged 10s: a layer that intercepts the pointer is named by
 * Playwright's own call log inside it, and is reported as before (the
 * "unowned layer" case in mobile-lobby-chrome.spec.ts pins that latency).
 * Only a click that ended WITHOUT an interception, which is a control that
 * was never given a settled frame to be judged on, gets the extension. It is
 * still the player's own control, still actionability-checked (visible,
 * enabled, stable, receiving pointer events), never forced, and still fails
 * with its own error when the control never settles.
 */
export const DIAMOND_DECLINE_CLICK_TIMEOUT_MS = 10_000;
export const DIAMOND_DECLINE_STALL_EXTENSION_MS = 20_000;
/** How long the failure report may spend asking a struggling page one question. */
const STALL_PROBE_MS = 3_000;

/** What the page's frame clock did for one second, or why it could not say. */
async function describeFrameClock(control: Locator): Promise<string> {
  const probe = control
    .evaluate(
      (el) =>
        new Promise<string>((resolve) => {
          let frames = 0;
          const started = performance.now();
          const rect = () => {
            const box = el.getBoundingClientRect();
            return `${box.left.toFixed(1)},${box.top.toFixed(1)} ${box.width.toFixed(1)}x${box.height.toFixed(1)}`;
          };
          const first = rect();
          const step = () => {
            frames += 1;
            if (performance.now() - started < 1_000) requestAnimationFrame(step);
            else resolve(`${frames} animation frames in 1s, plate ${first} -> ${rect()}`);
          };
          requestAnimationFrame(step);
        })
    )
    .catch(
      (error: unknown) => `frame clock unreadable (${(error as Error).message.split('\n')[0]})`
    );
  const timeout = new Promise<string>((resolve) =>
    setTimeout(
      () => resolve(`no answer from the page within ${STALL_PROBE_MS}ms (main thread blocked)`),
      STALL_PROBE_MS
    )
  );
  return Promise.race([probe, timeout]);
}

/** Take the invitation's real Not Now door and prove it closed. */
async function declineDiamondInvitation(page: Page): Promise<void> {
  const prompt = diamondInvitation(page);
  const notNow = prompt.getByRole('button', { name: 'Not Now', exact: true });
  const fail = async (error: unknown, waitedMs: number, frameClock: boolean): Promise<never> => {
    // Say what the page was doing, so the next report separates "the card kept
    // moving" from "the page stopped giving out frames" instead of guessing.
    // A covering layer is already named by Playwright's own call log, and its
    // report must not be delayed by a question to the page.
    const clock = frameClock ? ` [${await describeFrameClock(notNow)}]` : '';
    throw new Error(
      `The Diamond Spins Not Now click failed after ${waitedMs}ms: ${(error as Error).message}${clock}`,
      { cause: error }
    );
  };
  try {
    await notNow.click({ timeout: DIAMOND_DECLINE_CLICK_TIMEOUT_MS });
  } catch (first) {
    if (/intercepts pointer events/.test((first as Error).message)) {
      await fail(first, DIAMOND_DECLINE_CLICK_TIMEOUT_MS, false);
    }
    try {
      await notNow.click({ timeout: DIAMOND_DECLINE_STALL_EXTENSION_MS });
    } catch (second) {
      await fail(
        second,
        DIAMOND_DECLINE_CLICK_TIMEOUT_MS + DIAMOND_DECLINE_STALL_EXTENSION_MS,
        !/intercepts pointer events/.test((second as Error).message)
      );
    }
  }
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

interface OwnedDiamondInvitationDismissal extends DiamondInvitationDismissal {
  failure(): { error: unknown } | undefined;
}

const invitationOwners = new WeakMap<Page, OwnedDiamondInvitationDismissal>();

export async function prepareCashLobbyActions(
  page: Page,
  { retainInvitationHandler = true }: { retainInvitationHandler?: boolean } = {}
): Promise<void> {
  const diamondPrompt = diamondInvitation(page);
  if (!retainInvitationHandler) {
    // Readiness can await engine API evidence while an invitation appears.
    // Finish its real action before the short navigation assertions start;
    // otherwise their deadline can abandon the handler during dismissal.
    const owner = invitationOwners.get(page);
    await page.removeLocatorHandler(diamondPrompt);
    // Unregistering prevents future callbacks, but Playwright leaves a
    // callback already running. Drain that original action before deciding
    // whether another real Not Now is needed; never race two declines.
    if (owner) {
      await owner.idle();
      invitationOwners.delete(page);
      const failure = owner.failure();
      if (failure) throw failure.error;
    }
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

export interface DiamondInvitationDismissal {
  /**
   * Resolves once no decline is in flight. The handler's own budget (a 10s
   * Not Now click plus an 8s hidden check) can outlast the action that
   * triggered it: Playwright abandons the wait at that action's timeout and
   * leaves the handler running. A caller that turns a failed action into its
   * verdict waits here first, so the verdict names a decline that was still
   * failing instead of reporting only the action's timeout.
   */
  idle(): Promise<void>;
}

/** The optional offer may cover either the club greeting or a later cash action. */
export async function registerDiamondInvitationDismissal(
  page: Page,
  { onFailure }: DiamondInvitationOptions = {}
): Promise<DiamondInvitationDismissal> {
  const diamondPrompt = diamondInvitation(page);
  let inFlight: Promise<void> = Promise.resolve();
  let failure: { error: unknown } | undefined;
  const handle = async () => {
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
      // Keep the original failure even when global setup owns its collector.
      // Retirement must not turn an already failed decline into success.
      failure ??= { error };
      if (!onFailure) throw error;
      onFailure(error);
    }
  };
  await page.addLocatorHandler(
    diamondPrompt,
    () => {
      const run = handle();
      inFlight = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    },
    // No `times`: a handler that yields to the greeting must run again once
    // the invitation is on top. No wait-after: this handler proves the offer
    // hidden itself when it acts, and must not wait on it when it yields.
    { noWaitAfter: true }
  );
  const owner: OwnedDiamondInvitationDismissal = {
    idle: () => inFlight,
    failure: () => failure,
  };
  invitationOwners.set(page, owner);
  return owner;
}
