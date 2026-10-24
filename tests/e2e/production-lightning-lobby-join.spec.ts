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
import { prepareCashLobbyActions } from './support/cashLobbyOverlays';

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
    await prepareCashLobbyActions(page);

    await page.goto(`clubs/${club}`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth(?:\/|\?|$)/);

    // Lobby cards label the button "Join Lightning"; lobby rows read
    // "Join Lightning" with an aria-label naming the game. Either is the door.
    const joins = page.locator('button:visible:enabled', { hasText: /^\s*Join Lightning\s*$/ });
    await expect(joins.first(), 'the member lobby lists a joinable Lightning game').toBeVisible({
      timeout: 30_000,
    });
    await joins.first().click();

    await expect(page).toHaveURL(LIGHTNING_ROUTE, { timeout: 15_000 });
    const landed = page.url();
    // The original defect: a lobby effect replaced the route a moment later.
    await page.waitForTimeout(3_000);
    expect(page.url(), 'the lobby must not take the Lightning route back').toBe(landed);

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
