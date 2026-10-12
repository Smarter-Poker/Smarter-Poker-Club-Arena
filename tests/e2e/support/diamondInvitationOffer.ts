import { expect, type Page, type Response } from '@playwright/test';
import { prepareCashLobbyActions } from './cashLobbyOverlays';

/**
 * THE DIAMOND SPINS OFFER IS SETTLED BEFORE THE LOBBY IS MEASURED (2026-09-30).
 *
 * DiamondBustPrompt (src/components/games/DiamondBustPrompt.tsx) opens over the
 * shared chip lobby on the answer to one read, `fn_diamond_games_entry`, when the
 * viewer is out of chips and holds at least 25 Diamonds. The post-deploy
 * certificate account is exactly that viewer: zero chips and the welcome grant of
 * 500 Diamonds. The read answers whenever the database does - under load, seconds
 * after the lobby is already interactive - so the offer opens in the middle of
 * whatever the spec happens to be doing.
 *
 * The locator handler that prepareCashLobbyActions registers declines it through
 * Not Now, but a Playwright handler runs inside the action or assertion that met
 * the overlay and is abandoned at that action's deadline. Post-Deploy E2E runs
 * 36541808365, 36622883035, 36642628863 and 36679411337 (29-30 September) all
 * failed production-mobile-lobby-chrome.spec.ts the same way: the offer opened
 * during the 5-second aria-selected assertion after the ALL tab click, the
 * handler's Not Now click (a 10s + 20s budget, because a WebKit runner's frame
 * clock stalls) was still waiting when that assertion expired, and the test ended
 * with "locator.click: Test ended" before the sticky-row contract it exists for
 * was ever measured.
 *
 * So the spec listens for that read before it navigates and, once the lobby is
 * up, settles the offer at a point of its own choosing. Not offered: nothing to
 * do. Offered: wait until the invitation has opened (or the handler has already
 * declined it), then retire the handler and take the real Not Now door with its
 * whole budget (declineDiamondInvitationIfShown). Nothing is forced, skipped or
 * seeded: the player's own control closes the invitation, a covering layer is
 * still named, and an invitation that will not close still fails the run with its
 * own error.
 */
export const DIAMOND_ENTRY_READ = '/rest/v1/rpc/fn_diamond_games_entry';
export const DIAMOND_ENTRY_READ_TIMEOUT_MS = 60_000;
export const DIAMOND_OFFER_RENDER_TIMEOUT_MS = 15_000;
/** DiamondBustPrompt's `entry.diamonds >= 25`: the smallest Diamond Spins entry. */
export const DIAMOND_SPINS_SMALLEST_ENTRY = 25;

/**
 * Start listening BEFORE navigating: the read leaves as soon as the club
 * resolves, and a listener attached afterwards can only miss it. The returned
 * promise is already marked handled, so a test that skips before awaiting it
 * (signed out) does not leave an unhandled rejection behind.
 */
export function diamondEntryRead(page: Page): Promise<Response | null> {
  const read = page
    .waitForResponse((response) => new URL(response.url()).pathname === DIAMOND_ENTRY_READ, {
      timeout: DIAMOND_ENTRY_READ_TIMEOUT_MS,
    })
    .then(
      (response) => response,
      () => null
    );
  return read;
}

/** DiamondBustPrompt's own eligibility, read from the answer it acts on. */
export function offersDiamondSpins(status: number, body: unknown): boolean {
  if (status < 200 || status >= 300 || !body || typeof body !== 'object') return false;
  const entry = body as Record<string, unknown>;
  return (
    entry.ok === true &&
    entry.bust_prompt === true &&
    entry.member_chips === 0 &&
    typeof entry.diamonds === 'number' &&
    entry.diamonds >= DIAMOND_SPINS_SMALLEST_ENTRY
  );
}

export type DiamondOfferState = 'open' | 'declined' | 'pending';

/**
 * Where the offer stands, read with page.evaluate. That is neither an action nor
 * an assertion, so the registered handler cannot start a decline here that a
 * short deadline would then abandon.
 */
export function readDiamondOfferState(page: Page): Promise<DiamondOfferState> {
  return page.evaluate((): DiamondOfferState => {
    if (document.querySelector('[role="dialog"][aria-label="Diamond Spins"]')) return 'open';
    try {
      for (let index = 0; index < sessionStorage.length; index += 1) {
        const key = sessionStorage.key(index) ?? '';
        if (key.startsWith('diamond-spins-bust:') && sessionStorage.getItem(key) === 'dismissed') {
          return 'declined';
        }
      }
    } catch {
      /* An unreadable session store cannot prove a decline. */
    }
    return 'pending';
  });
}

/**
 * Settle the Diamond Spins offer the entry read made, before any short assertion
 * or scroll measurement can run into it. A lobby that never asked (no answer in
 * 60s) keeps the registered handler exactly as before this helper existed.
 */
export async function settleDiamondSpinsOffer(
  page: Page,
  read: Promise<Response | null>
): Promise<'not offered' | 'declined' | 'unknown'> {
  const response = await read;
  if (!response) return 'unknown';
  const body: unknown = await response.json().catch(() => null);
  if (!offersDiamondSpins(response.status(), body)) return 'not offered';
  await expect
    .poll(() => readDiamondOfferState(page), {
      timeout: DIAMOND_OFFER_RENDER_TIMEOUT_MS,
      message:
        'fn_diamond_games_entry offered Diamond Spins, but the invitation neither opened nor was declined',
    })
    .not.toBe('pending');
  // Retires the handler, then declines through Not Now if the invitation is
  // still open, with the full two-stage click budget and the 8s hidden check.
  await prepareCashLobbyActions(page, { retainInvitationHandler: false });
  return 'declined';
}
