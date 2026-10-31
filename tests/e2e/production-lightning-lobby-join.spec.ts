import { openLobbyGameSection } from './support/lobbyGameSections';
/**
 * JOIN LIGHTNING FROM THE GAME LOBBY, ON THE DEPLOYED SITE (2026-10-24).
 *
 * Dan: "JOIN LIGHTNING GAMES STILL SILENTLY FAILS FROM THE GAME LOBBY". The
 * cause (#7879) was a lobby query-string effect that overwrote the Lightning
 * route a tap had just opened, sending the player back to the lobby with no
 * word. Its unit test mounts the page with synthetic reads; this reads the
 * real lobby a member club of the Midway union shows, taps a real Join
 * Lightning, and checks the player lands on the approved Lightning card
 * (#7890) and STAYS there.
 *
 * READ ONLY. It never presses the entry card's Join, and it fails if any
 * admission or buy-in RPC is sent.
 */
import { expect, test } from '@playwright/test';
import { CLUB_ENTRY_MESSAGE_NAME, prepareCashLobbyActions } from './support/cashLobbyOverlays';
import { diamondEntryRead, settleDiamondSpinsOffer } from './support/diamondInvitationOffer';

const club = process.env.E2E_LIGHTNING_CLUB_ID || '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
const MONEY_RPCS = new Set([
  '/rest/v1/rpc/fn_cash_game_join',
  '/rest/v1/rpc/atomic_table_buyin',
  '/rest/v1/rpc/fn_lightning_join',
  '/rest/v1/rpc/fn_lightning_buy_in',
]);
const LIGHTNING_ROUTE = /\/lightning\/[0-9a-f-]{36}(?:[?#]|$)/;

for (const width of [393, 1440]) {
  test(`Join Lightning from the lobby at ${width}px opens and keeps the Lightning card`, async ({
    page,
  }, info) => {
    test.setTimeout(90_000);
    expect(
      Boolean(process.env.SP_EMAIL && process.env.SP_PASS),
      'isolated authenticated account required'
    ).toBe(true);
    await page.setViewportSize({ width, height: 900 });
    const moneyCalls: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (MONEY_RPCS.has(path)) moneyCalls.push(path);
    });
    // The lobby's own doors open on its first reads: register their real
    // dismissals, wait for the lobby, settle the Diamond offer, and settle the
    // club message BEFORE a game panel can open on top of it (run
    // 40132784246: the message opened under the panel and could not be closed).
    const offer = diamondEntryRead(page);
    await page.goto(`clubs/${club}`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:\/|\?|$)/);
    await prepareCashLobbyActions(page);
    await openLobbyGameSection(page, 'ALL');
    // A visible game row is the lobby's readiness at every width (the wallets
    // button the phone check waits on is hidden at 1440px, run 40153826373).
    await expect(
      page
        .locator('[data-testid="lobby-game-row"]:visible, .club-home__games .lt-row:visible')
        .first()
    ).toBeVisible({ timeout: 45_000 });
    await settleDiamondSpinsOffer(page, offer);
    const greeting = page.getByRole('dialog', { name: CLUB_ENTRY_MESSAGE_NAME });
    await greeting.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
    if (await greeting.isVisible())
      await prepareCashLobbyActions(page, { retainInvitationHandler: false });
    await expect(greeting).toHaveCount(0);

    // The live lobby is a row list (compact rows with a Details button on a
    // phone, table rows on desktop). A row opens the game panel, and the panel
    // holds Join Lightning: the exact path #7879 repaired. Games named
    // "Lightning" that are not running Lightning offer Join Game instead, so
    // the first panel that offers an enabled Join Lightning is the door.
    const allGames = page.getByRole('tab', { name: 'ALL', exact: true });
    if (await allGames.count()) await allGames.click();
    // A row is chosen by its live mode, not its name (post-deploy run
    // 40292901952): games named "Lightning" that are not running Lightning -
    // the variants Dan took off Lightning on 2026-10-25, nine-handed pilots,
    // games below the switch-on count - offer Join Game, and eight of them
    // filled every try. data-lightning is set only while the game is in
    // Lightning mode with Join Lightning on offer.
    const rows = page.locator(
      // Both layouts are in the document; only the one this width shows counts
      // (run 40132784246 picked the hidden phone row at 1440px).
      '[data-testid="lobby-game-row"][data-kind="cash"][data-lightning="on"]:visible, .club-home__games .lt-row[data-kind="cash"][data-lightning="on"]:visible'
    );
    await expect(rows.first(), 'the member lobby lists a Lightning game').toBeVisible({
      timeout: 45_000,
    });
    const panel = page.getByRole('dialog').filter({ has: page.locator('.arena-game-card') });
    const tries = Math.min(await rows.count(), 8);
    let opened = false;
    // What each tried panel offered, so a refusal names the cause instead of
    // only "false" (runs 40290005874 and 40292901952 failed with no screenshot
    // surviving the later Playwright runs in the same job).
    const saw: string[] = [];
    for (let i = 0; i < tries && !opened; i += 1) {
      const row = rows.nth(i);
      const details = row.getByRole('button', { name: /^Details:/ });
      if (await details.count()) await details.first().click();
      else await row.click();
      await expect(panel.first(), 'a lobby row opens its game panel').toBeVisible({
        timeout: 8_000,
      });
      const join = panel.getByRole('button', { name: 'Join Lightning', exact: true }).first();
      if ((await join.count()) && (await join.isEnabled())) {
        await join.click();
        opened = true;
      } else {
        const title = ((await row.innerText().catch(() => '')) || '')
          .replace(/\s+/g, ' ')
          .slice(0, 80);
        const offered = await panel
          .first()
          .getByRole('button')
          .evaluateAll((buttons) =>
            buttons
              .map(
                (b) =>
                  `${(b.textContent || '').replace(/\s+/g, ' ').trim()}${(b as HTMLButtonElement).disabled ? ' (disabled)' : ''}`
              )
              .filter((label) => label && !/^Close Game Lobby/.test(label))
              .slice(0, 6)
          )
          .catch(() => [] as string[]);
        saw.push(`${title} -> ${offered.join(' | ') || 'no buttons'}`);
        await page.getByRole('button', { name: 'Close Game Lobby', exact: true }).click();
        await expect(panel).toHaveCount(0);
      }
    }
    expect(
      opened,
      `a Lightning game panel offers an enabled Join Lightning; tried ${saw.length} of ${await rows.count()} rows:\n${saw.join('\n')}`
    ).toBe(true);

    await expect(page).toHaveURL(LIGHTNING_ROUTE, { timeout: 15_000 });
    const landed = new URL(page.url());
    // The original defect: a lobby effect replaced the route a moment later.
    // The entry consumes ?join=1 in place; that must not look like leaving
    // the card (run 40191613101). Keep the exact origin and cluster path.
    await page.waitForTimeout(3_000);
    const stayed = new URL(page.url());
    expect(stayed.origin, 'the Lightning card must stay on its origin').toBe(landed.origin);
    expect(stayed.pathname, 'the lobby must not take the Lightning route back').toBe(
      landed.pathname
    );

    const card = page.locator('[data-testid="lightning-entry"] .lightning-cash-card');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.locator('.agc-nlh-premium')).toHaveCount(1);
    await expect(card.getByRole('button', { name: 'Return To Lobby', exact: true })).toBeVisible();
    await expect(card.locator('[data-zone="primaryAction"]')).toBeVisible();
    const stakes = (await card.locator('[data-zone="stakes"]').textContent())?.trim() ?? '';
    expect(stakes, 'stakes read like the table, e.g. 1/2 or 0.25/0.50').toMatch(
      /^\d+(?:\.\d+)?\/\d+(?:\.\d+)?$/
    );
    expect(stakes).not.toMatch(/(^|\/)\d+\.00(\/|$)/);
    const text = (await page.locator('[data-testid="lightning-entry"]').textContent()) ?? '';
    expect(text).not.toMatch(/Join Waitlist|Waiting List|Buy In Once/);

    await info.attach(`lightning-lobby-join-${width}.png`, {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    expect(moneyCalls, 'a read-only check sends no admission or buy-in').toEqual([]);
  });
}
