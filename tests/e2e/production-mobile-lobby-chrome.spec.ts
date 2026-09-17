import { test, expect, devices, type Page } from '@playwright/test';

/**
 * THE THREE THINGS DAN PHOTOGRAPHED, ON THE LIVE LOBBY (2026-09-10).
 *
 * mobile-lobby-chrome.spec.ts builds the lobby from this commit's stylesheets
 * and measures it; that is the pre-merge gate. This file is the other half:
 * the DEPLOYED lobby, signed in, on the phone engine, after the real wallet
 * has published the real count. It exists because the fixture passed on
 * 2026-09-09 while production printed nothing under MY WALLETS - the page
 * reset the count in the same commit the wallet published it, and no fixture
 * of the CSS could see that. A contract about what a player sees has to be
 * read off what a player sees.
 *
 * Signed out this file skips, like every authenticated spec here. It runs on
 * a phone profile in the chromium project: what it reads - the wallet's
 * published text, a sticky offset, a fixed edge - is decided by the app, not
 * the engine, and the engine-specific geometry is already measured on WebKit
 * by mobile-lobby-chrome.spec.ts.
 */
const CLUB_ID = process.env.E2E_CLUB_ID || 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';

/** The MY WALLETS title's optical centre on the my-wallets-v1 master, as a
 *  percentage of the plate; the count line is centred on it. */
const TITLE_CENTRE_PCT = 54.65;

test.use({ ...devices['iPhone 13'] });

async function openLobby(page: Page) {
  await page.goto(`clubs/${CLUB_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  test.skip(/\/auth(?:\/|$|\?)/.test(page.url()), 'signed out: the club lobby is behind a login');

  /* A club message is a legitimate full-screen welcome at the door. Close it
     through its own X, without persisting anything. */
  const close = page.getByRole('button', { name: 'Close Club Message' });
  const opened = await close
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (opened) {
    await close.click();
    await expect(close).toBeHidden({ timeout: 8_000 });
  }
  await expect(page.locator('.lobby-wallets-trigger')).toBeVisible({ timeout: 45_000 });
}

/** Where a fixed element at bottom: 0 lands is the bottom edge. The viewport
 *  height is not: WebKit's mobile emulation reports it taller than the layout
 *  viewport fixed elements attach to. */
async function bottomEdge(page: Page) {
  return page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;bottom:0;left:0;width:1px;height:1px;pointer-events:none';
    document.body.appendChild(probe);
    const edge = probe.getBoundingClientRect().bottom;
    probe.remove();
    return edge;
  });
}

test.describe('the mobile lobby chrome on production', () => {
  test('MY WALLETS prints the count, keeps it, centred and unclipped', async ({ page }) => {
    await openLobby(page);
    const small = page.locator('.lobby-wallets-trigger__copy small');

    /* The number the viewer's role decides, in the wallet's own words. Not a
       placeholder, and not the empty bay that a wiped count leaves behind. */
    await expect.poll(() => small.textContent(), { timeout: 20_000 }).toMatch(/^\d+ Balances?$/);
    const printed = await small.textContent();

    /* ...and there is still a count once every balance has had time to load.
       The 2026-09-10 defect was a count published and then taken back; a
       single read at the right instant would have passed. The NUMBER may
       legitimately move in that window (the live role arriving adds a row to
       a cached one); the bay going empty may not. */
    await page.waitForTimeout(4_000);
    expect(await small.textContent(), 'the count was taken back after it printed').toMatch(
      /^\d+ Balances?$/
    );

    const m = await page.evaluate((titleCentrePct) => {
      const btn = document.querySelector('.lobby-wallets-trigger')!;
      const el = btn.querySelector('small')!;
      const range = document.createRange();
      range.selectNodeContents(el);
      const b = btn.getBoundingClientRect();
      const z = el.getBoundingClientRect();
      const t = range.getBoundingClientRect();
      return {
        clipped: t.width > z.width + 0.5,
        offCentreByPct: Math.abs(
          ((t.left + t.width / 2 - b.left) / b.width) * 100 - titleCentrePct
        ),
      };
    }, TITLE_CENTRE_PCT);
    expect(m.clipped, `${printed} is clipped at the plate's edge`).toBe(false);
    expect(m.offCentreByPct, `${printed} is off the painted title's centre`).toBeLessThan(1);
  });

  test('the filter row locks under Find Your Game when the lobby scrolls', async ({ page }) => {
    await openLobby(page);
    const sortbar = page.locator('.lobby-sortbar');
    await expect(sortbar).toBeVisible({ timeout: 45_000 });
    await expect(sortbar).toHaveCSS('position', 'sticky');

    /* Scroll far enough that an unstuck row would leave the screen. */
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(600);
    const m = await page.evaluate(() => {
      const row = document.querySelector('.lobby-sortbar')!.getBoundingClientRect();
      const deck = document
        .querySelector('.club-lobby-command-top__controls')!
        .getBoundingClientRect();
      return {
        rowTop: row.top,
        rowBottom: row.bottom,
        deckBottom: deck.bottom,
        scrolled: window.scrollY,
      };
    });
    expect(m.scrolled, 'the lobby did not scroll at all').toBeGreaterThan(0);
    expect(m.rowBottom, 'the filter row scrolled off the top of the page').toBeGreaterThan(0);
    expect(
      Math.abs(m.rowTop - m.deckBottom),
      'gap between Find Your Game and the row'
    ).toBeLessThan(1);
  });

  test('the footer frame sits on the bottom edge with nothing under it', async ({ page }) => {
    await openLobby(page);
    /* Two landmarks share this name on a club lobby: the arena boundary's
       "Choose Arena" nav inside the page, and the footer. The footer is the
       one that carries the six controls. */
    const nav = page
      .getByRole('navigation', { name: 'Poker Arena' })
      .filter({ has: page.locator('[data-footer-control]') });
    await expect(nav).toHaveCount(1);
    await expect(nav).toBeVisible();
    await expect(nav).toHaveCSS('position', 'fixed');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(300);

    const edge = await bottomEdge(page);
    // The Diamond Spins overlay is a second image; measure the approved base frame.
    const artwork = nav.locator('img[src$="/club-arena-footer-v2.webp"]').locator('..');
    await expect(artwork).toHaveCount(1);
    const frame = await artwork.boundingBox();
    expect(frame).not.toBeNull();
    expect(
      Math.abs(frame!.y + frame!.height - edge),
      'strip between the painted frame and the bottom edge'
    ).toBeLessThan(1);
  });
});
