/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  SEAT-FIRST ENTRY — the first real-browser coverage of "I want to play"
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-28: "I STILL CAN'T EVEN SIT DOWN AND PLAY, IT NEVER WORKS,
 * NEVER REGISTERS WITHOUT ERRORS, AND THE SPIN ANIMATION NEVER PLAYS!!!"
 *
 * Rounds 13 and 14 fixed two halves of that, and BOTH were invisible to every
 * test in the repo, because both are things a real browser does over time:
 *
 *   ROUND 14 — there were TWO competing 60-second buy-in timers on this
 *   sheet. The duplicate called `navigate('/hub/club-arena')` while the
 *   router's basename ALREADY is /hub/club-arena, so it resolved to
 *   /hub/club-arena/hub/club-arena — a dead route. A player reading the
 *   confirmation for a minute was silently thrown onto a blank page. The
 *   surviving timer now closes the sheet and returns to a REAL destination,
 *   and the sheet says out loud how long the seat is held.
 *
 *   ROUND 9 — the multiplier ladder on the sheet, priced at this stake, so a
 *   player can see what they are buying before they buy it.
 *
 * A vitest spec can assert that this JSX exists. It cannot assert that the
 * countdown COUNTS, that the sheet is reachable by clicking, or that the seat
 * underneath is hit-testable — jsdom lays nothing out and no timer it runs is
 * a real second. That is what this file is for.
 *
 * ─── IT MUST NOT SPEND A SINGLE CHIP ─────────────────────────────────────────
 *
 * CLAUDE.md section 11.5 is binding: on 2026-08-25 an agent verified a money
 * guard by CALLING it against production and 48 real chips left a member
 * wallet. CI runs this suite against production SIGNED IN as a real player.
 *
 * The seat-first flow is safe to walk right up to the edge of, because the
 * debit is on exactly one line: `commitSeatFirstBuyIn`, wired to the "Buy In"
 * button and nothing else. Opening the panel, navigating to the table, and
 * clicking an empty seat all cost nothing — the sheet's own header says it:
 * "Nothing above this sheet spends money."
 *
 * So this spec opens the sheet and CANCELS it. `.seat-buyin-confirm__btn--go`
 * is asserted to exist and is NEVER clicked. If you are editing this file and
 * find yourself reaching for that locator's `.click()`, stop — that is a real
 * buy-in on a real account, and section 11.5 was written in the aftermath of
 * exactly that instinct.
 */

import { test, expect, type Page } from '@playwright/test';
import { expectRoute } from './routes/utils';

/**
 * A CLUB, deliberately - not a union.
 *
 * The spin fleet is created against the UNION (`tournaments.club_id` holds
 * the union's id, `fade0000-…-0001`), and the first draft of this file
 * pointed straight at that id on exactly that reasoning. `/clubs/<union-id>`
 * REDIRECTS to `/unions/<id>`, a different page with no lobby on it at all:
 * no `.club-home`, no rows, no game-type tabs. Every spec skipped, and a
 * suite that can only skip is the failure this directory has been caught by
 * twice before.
 *
 * A member club's lobby is the surface that shows them - ClubHomePage
 * resolves its club's `union_id` and subscribes to union-wide tournaments,
 * which is exactly how a player reaches these games.
 */
const CLUB_ID = process.env.E2E_CLUB_ID || 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const LOBBY = `clubs/${CLUB_ID}`;

/** The sheet, and the two controls that decide whether money moves. */
const SHEET = '.seat-buyin-confirm';
const CONFIRM = '.seat-buyin-confirm__btn--go';
const CANCEL = '.seat-buyin-confirm__btn--ghost';

/**
 * Say why, out loud, whenever this file declines to assert something.
 *
 * A skip with no reason is the worst outcome a production-facing spec can
 * produce: it is indistinguishable from a pass in the summary line, and the
 * first three runs of this file skipped all five specs for THREE different
 * reasons - a union id that has no lobby, a game-type tab that was never
 * clicked, and a CTA whose accessible name is uppercased. Each cost a full
 * round trip to diagnose because the log said only "5 skipped".
 */
function why(step: string, detail = ''): void {
  console.log(`[seat-first] ${step}${detail ? `: ${detail}` : ''}`);
}

/** Wait until the lobby has rows or has said it is empty. */
async function lobbySettled(page: Page): Promise<void> {
  await page
    .locator('.club-home__games .lt-row:not(.lt-row--skeleton), .empty-tables')
    .first()
    .waitFor({ state: 'visible', timeout: 45000 })
    .catch(() => {
      /* the assertions below report the real state */
    });
}

/**
 * Open the game lobby panel for the first joinable SPIN in this club and
 * press its CTA, which navigates to the table. Returns false when the club
 * has no joinable spin right now — an empty schedule is a fact about
 * production at this instant, not a regression.
 *
 * Deliberately accepts ONLY "Join Spin". "Watch" and "Return To Game" reach
 * the same table by the same handler but describe a player who is already in
 * or cannot enter, and neither offers the seat sheet this file is about.
 */
async function openSpinTable(page: Page): Promise<boolean> {
  const ok = await expectRoute(page, LOBBY);
  if (!ok) return false;
  await lobbySettled(page);

  /* SELECT THE SPINS TAB FIRST. Found by RUNNING this file rather than by
     reading it: the lobby opens on a game-type tab that is not SPINS, so the
     row selector below matched nothing and all five specs SKIPPED — signed
     in, against a club holding 33 joinable spins. A suite that can only skip
     reports green and proves nothing, which is the failure mode this
     directory has already been caught by twice. */
  const spinsTab = page.locator('.game-bar__type', { hasText: /^SPINS$/ });
  if (
    await spinsTab
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    await spinsTab.first().click();
    await page
      .locator('.club-home__games .lt-row[data-kind="spin"]:not(.lt-row--skeleton)')
      .first()
      .waitFor({ state: 'visible', timeout: 20000 })
      .catch(() => {
        /* an empty spin tab is a fact about this instant, reported below */
      });
  }

  const rows = page.locator('.club-home__games .lt-row[data-kind="spin"]:not(.lt-row--skeleton)');
  const n = await rows.count();
  why('spin rows on the SPINS tab', String(n));
  if (n === 0) return false;

  /* THREE rows, not six, and short waits on each. This loop is inside the
     test's own timeout, so a generous budget per row does not make the spec
     more thorough - it makes it die mid-helper with "browser has been
     closed" instead of reporting the honest "no joinable spin". Measured
     against production: a row that is going to open its panel does so in
     well under 6s, and seat-first entry reaches the table in under 12s. */
  for (let i = 0; i < Math.min(n, 6); i++) {
    await rows.nth(i).click();
    const panel = page.locator('.glp');
    if (!(await panel.isVisible({ timeout: 6000 }).catch(() => false))) continue;

    /* CASE-INSENSITIVE, and that is not defensive vagueness - the panel
       renders the CTA through a text-transform, so its accessible name is
       literally "JOIN SPIN". A `/^Join Spin$/` matched nothing against a
       lobby holding 44 live spins, and every spec skipped. Playwright does
       not fold case for a RegExp name; the `i` is what makes this match the
       button a player actually sees. */
    const join = panel.getByRole('button', { name: /^\s*join spin\s*$/i });
    if ((await join.count()) === 0) {
      why(
        `row ${i} offers no Join Spin`,
        (await panel.locator('button').allInnerTexts()).join(' | ')
      );
      await page.keyboard.press('Escape');
      await panel.waitFor({ state: 'hidden', timeout: 4000 }).catch(() => {});
      continue;
    }
    await join.first().click();
    // Seat-first entry lands on the TABLE, not on a registration screen.
    const landed = await page
      .waitForURL(/\/table\/[0-9a-f-]{36}/i, { timeout: 12000 })
      .then(() => true)
      .catch(() => false);
    if (landed) return true;
    why(`row ${i} did not reach a table`, page.url());
  }
  return false;
}

/**
 * Click the first seat that offers to be sat in and wait for the sheet.
 *
 * The empty seat renders in TWO forms and only one of them is clickable:
 * `seat--empty-locked` has no onClick, no tabIndex and no role at all (a seat
 * the player may not take is removed from the interaction model rather than
 * accepting the click and rejecting it downstream). So this targets the
 * role="button" form, which is the one a player can actually use.
 */
async function openSeatSheet(page: Page): Promise<boolean> {
  const sittable = page.getByRole('button', { name: /Seat \d+: open - click to sit/ });
  const appeared = await sittable
    .first()
    .waitFor({ state: 'visible', timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) {
    why('no sittable seat on this table', page.url());
    return false;
  }

  await sittable.first().click();
  const open = await page
    .locator(SHEET)
    .waitFor({ state: 'visible', timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  if (!open) {
    why('clicked an open seat but no buy-in sheet appeared', page.url());

    /* THE ONE THING THAT IS NEVER ACCEPTABLE HERE, asserted even though the
       spec is about to skip. A spin whose seats have gone must give the
       player nothing, or tell them so - it must NEVER offer the CASH buy-in
       modal, which prices seats off the table's blinds and on 2026-08-30 was
       offering 800 to 4,000 chips on a game whose buy-in is one chip. That
       is the defect this run found; see noCashPriceOnATournamentSeat. */
    await expect(
      page.locator('.buy-in-modal'),
      'a tournament seat offered the CASH buy-in modal'
    ).toHaveCount(0);
  }
  return open;
}

/** Always leave the felt as we found it — and never by pressing Buy In. */
async function cancelSheet(page: Page): Promise<void> {
  const cancel = page.locator(CANCEL);
  if (await cancel.isVisible().catch(() => false)) {
    await cancel.click();
    await expect(page.locator(SHEET)).toHaveCount(0);
  }
}

test.describe('Seat-first entry', () => {
  /* Production, signed in, over a real network; one spec deliberately watches
     a clock for ~10 seconds, and the lobby walk may try several games before
     one still has a seat by the time the click lands. Measured: a full walk
     plus the countdown spec fits inside ~110s, so 180 leaves real headroom.
     Too SHORT a budget here is not a safety feature - it kills the helper
     mid-flight and reports "browser has been closed" instead of the honest
     "no joinable spin right now". */
  test.setTimeout(180_000);

  test.afterEach(async ({ page }) => {
    await cancelSheet(page).catch(() => {
      /* the test may already have closed it */
    });
  });

  test('a joinable spin can be entered, and the seat opens the buy-in sheet', async ({ page }) => {
    const atTable = await openSpinTable(page);
    test.skip(!atTable, 'no joinable spin in this club right now');

    const opened = await openSeatSheet(page);
    test.skip(!opened, 'no open seat on this spin right now');

    /* THE COMPLAINT, ANSWERED IN A BROWSER: clicking an open seat on a spin
       produces the buy-in sheet. Not an error, not a silent nothing. */
    const sheet = page.locator(SHEET);
    await expect(sheet).toHaveCount(1);
    await expect(sheet.locator('.seat-buyin-confirm__title')).toHaveText(/Buy In/);

    // It must name a seat and a price, or the player cannot know what they
    // are agreeing to.
    await expect(sheet.locator('.seat-buyin-confirm__eyebrow')).toContainText(/Seat \d+/);
    const amount = (await sheet.locator('.seat-buyin-confirm__amount').innerText()).trim();
    expect(amount, 'the sheet must print a buy-in amount').toMatch(/[0-9]/);

    // Confirm EXISTS and is deliberately never clicked. See the header.
    await expect(sheet.locator(CONFIRM)).toBeVisible();
  });

  test('the held-seat countdown is real and it counts DOWN', async ({ page }) => {
    const atTable = await openSpinTable(page);
    test.skip(!atTable, 'no joinable spin in this club right now');
    const opened = await openSeatSheet(page);
    test.skip(!opened, 'no open seat on this spin right now');

    const line = page.locator(SHEET).getByText(/Seat Held For \d+s/);
    await expect(line, 'round 14 put the 60s window on the sheet').toBeVisible({ timeout: 10000 });

    const read = async (): Promise<number> =>
      Number(((await line.innerText()).match(/(\d+)/) ?? [])[1]);

    const first = await read();
    expect(first, 'the countdown must start inside the 60s window').toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(60);

    /* The bug this replaces was a timer that fired ONCE and navigated. A
       number that is merely present proves nothing; it has to move, and it
       has to move the right way. Ten seconds is long enough that a slow
       frame cannot explain the difference. */
    await page.waitForTimeout(10_000);
    const later = await read();
    expect(later, `countdown did not tick (${first} -> ${later})`).toBeLessThan(first);
    expect(first - later, 'the countdown drifted from wall-clock time').toBeLessThanOrEqual(14);

    /* AND THE SHEET IS STILL HERE. The deleted duplicate timer would have
       navigated to /hub/club-arena/hub/club-arena — a dead route — at the
       60s mark; this asserts the surviving one has not fired early and that
       the page under it is still the table. */
    await expect(page.locator(SHEET)).toHaveCount(1);
    await expect(page).toHaveURL(/\/table\/[0-9a-f-]{36}/i);
    expect(page.url(), 'the doubled basename bug is back').not.toContain(
      '/hub/club-arena/hub/club-arena'
    );
  });

  test('the multiplier ladder opens, and every prize is priced at THIS stake', async ({ page }) => {
    const atTable = await openSpinTable(page);
    test.skip(!atTable, 'no joinable spin in this club right now');
    const opened = await openSeatSheet(page);
    test.skip(!opened, 'no open seat on this spin right now');

    const sheet = page.locator(SHEET);
    const toggle = sheet.locator('.seat-buyin-confirm__odds-toggle');
    await expect(toggle, 'the odds ladder is spins-only and this is a spin').toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    const rows = sheet.locator(
      '.seat-buyin-confirm__odds-row:not(.seat-buyin-confirm__odds-row--head)'
    );
    const n = await rows.count();
    expect(n, 'the ladder must list the real tiers').toBeGreaterThan(3);

    const cost = Number(
      (await sheet.locator('.seat-buyin-confirm__amount').innerText()).replace(/[^0-9.]/g, '')
    );
    expect(cost, 'the sheet must print a numeric buy-in').toBeGreaterThan(0);

    /* Every prize is cost x multiplier. The spin FEE is 0 by construction -
       rake lives inside the multiplier distribution - so the buy-in IS the
       figure the pool multiplies. A ladder that quotes prizes for some other
       stake is the advertising-what-you-do-not-pay bug. */
    for (let i = 0; i < n; i++) {
      const cells = rows.nth(i).locator('span');
      const mult = Number((await cells.nth(0).innerText()).replace(/[^0-9.]/g, ''));
      const prize = Number((await cells.nth(1).innerText()).replace(/[^0-9.]/g, ''));
      expect(prize, `${mult}x priced wrong for a buy-in of ${cost}`).toBe(Math.round(cost * mult));
    }

    // It collapses again, and the sheet survives it.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(sheet.locator(CONFIRM)).toBeVisible();
  });

  test('Cancel closes it, takes nothing, and the seat can be opened again', async ({ page }) => {
    const atTable = await openSpinTable(page);
    test.skip(!atTable, 'no joinable spin in this club right now');
    const opened = await openSeatSheet(page);
    test.skip(!opened, 'no open seat on this spin right now');

    await expect(page.locator(CONFIRM)).toBeVisible();
    await page.locator(CANCEL).click();
    await expect(page.locator(SHEET)).toHaveCount(0);

    /* Cancelling must release the pending guard, or the seat is dead for the
       rest of the session and the player is on a table they cannot enter -
       which is indistinguishable, from the player's chair, from "it never
       works". Prove it by opening the sheet a second time. */
    const again = await openSeatSheet(page);
    expect(again, 'the seat could not be opened a second time after Cancel').toBe(true);
  });

  test('the backdrop dismisses the sheet without spending', async ({ page }) => {
    const atTable = await openSpinTable(page);
    test.skip(!atTable, 'no joinable spin in this club right now');
    const opened = await openSeatSheet(page);
    test.skip(!opened, 'no open seat on this spin right now');

    /* The backdrop is a dismiss, and it must be a dismiss and nothing else:
       it is the largest click target on the screen and it sits directly over
       the felt. Clicking it must never reach a seat, an action button, or
       the confirm underneath. */
    await page.locator('.seat-buyin-confirm__backdrop').click({ position: { x: 5, y: 5 } });
    await expect(page.locator(SHEET)).toHaveCount(0);
    await expect(page).toHaveURL(/\/table\/[0-9a-f-]{36}/i);
  });
});
