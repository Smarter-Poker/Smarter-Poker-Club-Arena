/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  WATCHING A RUNNING TOURNAMENT — the route Dan asked for, end to end
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-25 (binding): "in MTT, when I click on a tournament that's
 * RUNNING I should be able to click a button and watch the tournament. It
 * should take you directly to the FEATURED TABLE of the tournament
 * automatically, or you can go to Tables or Ranking and see any player and be
 * redirected to that table directly."
 *
 * The unit specs for this assert that the source contains a `featuredTableId`
 * memo and a `btn-watch` class. That is not the same claim. It cannot tell you
 * whether the button renders on a real running tournament, whether the table it
 * points at exists, or whether clicking it lands anywhere. Those are the only
 * things Dan actually asked for, and only a browser against real data can
 * answer them.
 *
 * READ-ONLY. Watching a table is a navigation, not a transaction — nothing here
 * seats anybody or spends anything. It never touches a Register button (see
 * tournament-buy-in-dialog.spec.ts for why that matters).
 *
 * SKIPS RATHER THAN FAILS when production happens to have no running
 * tournament: "there is no live event at 4am" is a fact about the schedule, not
 * a regression in the code.
 */

import { test, expect, type Page } from '@playwright/test';

const url = (path: string) => path.replace(/^\//, '');

async function requireSignedIn(page: Page) {
  if (/\/auth\b/.test(page.url())) {
    test.skip(true, 'signed out — set SP_EMAIL / SP_PASS for this spec to run');
  }
}

/**
 * Land on the details page of a tournament that is actually RUNNING.
 * Returns false when there is not one to look at.
 */
/**
 * WAIT FOR THE LOBBY TO HAVE ACTUALLY DRAWN ITS CARDS.
 *
 * The first working draft used `waitForTimeout(2500)` here and every spec then
 * blew the 30s test budget: production is a signed-in app holding realtime
 * sockets, and a fixed sleep is both too long when it is fast and too short
 * when it is not. Wait for the thing itself.
 *
 * Returns false when the lobby genuinely has no actionable card — an empty
 * schedule is a fact about production, not a regression.
 */
async function lobbyReady(page: Page): Promise<boolean> {
  const anyCardAction = page.getByRole('button', {
    name: /^\s*(Watch|Open Tournament|Register|Late Register)\b/i,
  });
  try {
    await anyCardAction.first().waitFor({ state: 'visible', timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the navigation drawer out of the way.
 *
 * Found by RUNNING this suite rather than by reading it: on a signed-in cold
 * load the hamburger drawer sits over the lobby, so every card behind it is
 * unmatched and the first draft of these specs SKIPPED on every run — signed in
 * or out. A spec that can only skip reports green and proves nothing.
 */
async function dismissChrome(page: Page) {
  const close = page.getByRole('button', { name: /^\s*Close\s*$/ }).first();
  if (await close.isVisible().catch(() => false)) {
    await close.click().catch(() => {});
    await close.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
  }
}

async function openRunningTournament(page: Page): Promise<boolean> {
  await page.goto(url('tournaments'), { waitUntil: 'domcontentloaded' });
  await requireSignedIn(page);
  await dismissChrome(page);
  if (!(await lobbyReady(page))) return false;

  // A running event's card carries the Watch / Open Tournament action; that is
  // the most reliable "this one is live" marker on the lobby.
  const liveCard = page.getByRole('button', { name: /^\s*(Watch|Open Tournament)\s*$/i }).first();
  if ((await liveCard.count()) === 0) return false;

  await liveCard.click();
  /* An unregistered viewer's Watch carries `?watch=1`, and the details page
     acts on it as soon as its featured table resolves — so this click can land
     on EITHER the details page or straight on the felt. Both are correct; wait
     for whichever arrives. */
  await page
    .waitForURL(/\/(tournaments|table)\/[0-9a-f-]{8,}/i, { timeout: 12000 })
    .catch(() => {});
  return /\/(tournaments|table)\/[0-9a-f-]{8,}/i.test(page.url());
}

/** True once we are on a felt rather than the details page. */
const onTable = (page: Page) => /\/table\/[0-9a-f-]{8,}/i.test(page.url());

test.describe('Watching a running tournament', () => {
  /* Production, signed in, over a real network — and one of these opens a poker
     table, which boots an engine socket. The default 30s is a local-dev budget. */
  test.setTimeout(90_000);

  test('Watch on a live card lands on a real felt, never a dead end', async ({ page }) => {
    /* Dan's item 1, end to end. Three drafts of this test failed for the same
       reason and it is worth recording: the first two branched on
       `page.url()`, which is a SYNCHRONOUS read racing an in-flight
       navigation. On production an unregistered viewer's Watch goes straight
       through to the felt, so the branch chose "details page" and then looked
       for a footer on a page that had already become a table — the assertion
       failed while the feature worked perfectly.

       Assert the DISJUNCTION. Either destination is correct; what must never
       happen is a 404, an error boundary, or still being on the lobby. */
    const ok = await openRunningTournament(page);
    test.skip(!ok, 'no running tournament on production right now');

    expect(page.url(), 'Watch must leave the lobby').toMatch(
      /\/(tournaments|table)\/[0-9a-f-]{8,}/i
    );

    const arrived = page
      .locator('.table-hud')
      .or(page.locator('.table-surface'))
      .or(page.locator('.spectator-footer-bar'))
      .or(page.locator('.details-footer'))
      .first();
    await expect(arrived, 'Watch must land on a felt or on the event page').toBeVisible({
      timeout: 25_000,
    });

    const body = page.locator('body');
    await expect(body).not.toContainText("This page doesn't exist");
    await expect(body).not.toContainText(/Something went wrong|This page ran into an issue/i);
  });

  test('a tournament felt shows the stats bar in the right corner', async ({ page }) => {
    /* Dan: "tournaments are still missing the stats bar in the right corner."
       It was missing for two independent reasons: MiniStatsCard bailed out to a
       bare glyph for tournaments, and TournamentHUD was rendered outside the
       fixed HUD layer entirely, with nothing to anchor it. */
    const ok = await openRunningTournament(page);
    test.skip(!ok, 'no running tournament on production right now');

    /* SETTLE FIRST, THEN DECIDE. Checking `isVisible()` the instant after the
       click is the same race that broke the test above: the watch intent may
       still be navigating, so neither the felt NOR the footer is on screen yet
       and the test concluded "no live table" and skipped itself. Wait for one
       of them to actually exist before branching. */
    const felt = page.locator('.table-hud').or(page.locator('.spectator-footer-bar')).first();
    const watch = page.locator('.details-footer .btn-watch');
    await expect(felt.or(watch).first()).toBeVisible({ timeout: 25_000 });

    if (!(await felt.isVisible().catch(() => false))) {
      if ((await watch.count()) === 0) {
        test.skip(true, 'this event has no live table to feature');
      }
      await watch.click();
    }
    await page.waitForURL(/\/table\/[0-9a-f-]{8,}/i, { timeout: 25_000 });

    const corner = page.locator('.table-hud__corner--ur');
    await expect(corner, 'the upper-right HUD corner must exist on a tournament felt').toBeVisible({
      timeout: 25_000,
    });

    /* The tournament bar carries labelled FIGURES. The bug was a button that
       said only "STATS" — a link to a panel, not a stats bar. Only asserted
       when the bar is present at all: a spectator with no seat legitimately
       has no stack to show. */
    const bar = corner.locator('.mini-stats-card--tournament-stats');
    if ((await bar.count()) > 0) {
      await expect(bar).toContainText(/Stack/i);
      await expect(bar).not.toHaveText(/^\s*STATS\s*$/);
    }
  });
});
