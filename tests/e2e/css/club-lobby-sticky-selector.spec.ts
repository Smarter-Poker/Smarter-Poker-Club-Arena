/**
 * FIND YOUR GAME STAYS REACHABLE WHILE THE CATALOGUE MOVES.
 *
 * Source-string checks can prove that `position: sticky` was typed, but not
 * that the browser accepts its containing block. The command wrapper also
 * owns the campaign bay; before it was flattened, the selector stopped being
 * sticky as soon as that short wrapper left the scrollport. These two beats
 * render the production stylesheet and measure the result in Chromium at both
 * sides of the real breakpoint.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CSS = readFileSync(
  resolve(process.cwd(), 'src/components/lobby/ClubLobbyCommandTop.css'),
  'utf8'
);

function fixture(mobile: boolean): string {
  return `
    <style>
      ${CSS}
      html, body { margin: 0; min-height: 100%; background: #000; }
      :root { --ca-global-header-height: 64px; }
      .probe-header {
        ${mobile ? 'position: fixed;' : 'display: none;'}
        z-index: 390; inset: 0 0 auto; height: 64px; background: #111;
      }
      .probe-lead { height: ${mobile ? '320px' : '0'}; }
      .club-lobby-machine {
        width: 100%; max-width: none; aspect-ratio: auto; margin: 0;
        display: flex; flex-direction: column;
        ${mobile ? 'height: auto; overflow: visible;' : 'height: 360px; overflow-y: auto;'}
      }
      .club-lobby-command-top__controls { box-sizing: border-box; min-height: 122px; }
      .club-lobby-command-top__campaign { box-sizing: border-box; min-height: 110px; }
      .probe-games { flex: 0 0 auto; height: 1400px; background: #02070b; }
    </style>
    <header class="probe-header"></header>
    <div class="probe-lead"></div>
    <main class="club-lobby-machine">
      <section class="club-lobby-command-top">
        <div class="club-lobby-command-top__controls">
          <div class="lobby-controls">
            <div class="lobby-controls__heading">Find Your Game</div>
            <div class="game-bar">
              <div class="game-bar__types"><button class="game-bar__type">All</button></div>
              <button class="game-bar__filter-btn">Sort</button>
            </div>
            <div class="quickprefs">
              <div class="quickprefs__row--status"><button class="quickprefs__chip">Running</button></div>
            </div>
          </div>
        </div>
        <div class="club-lobby-command-top__campaign">Campaign</div>
      </section>
      <div class="probe-games">Games</div>
    </main>`;
}

test('desktop keeps the complete selector at the top of its game scrollport', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.setContent(fixture(false));

  const controls = page.locator('.club-lobby-command-top__controls');
  const machine = page.locator('.club-lobby-machine');
  const before = await controls.boundingBox();
  expect(before).not.toBeNull();

  await machine.evaluate((element) => {
    element.scrollTop = 500;
  });
  const after = await controls.boundingBox();
  expect(after).not.toBeNull();
  expect(Math.abs(after!.y - before!.y)).toBeLessThan(2);
  await expect(controls).toHaveCSS('position', 'sticky');
});

test('mobile pins the selector below the measured header while the page scrolls', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.setContent(fixture(true));

  const controls = page.locator('.club-lobby-command-top__controls');
  await page.evaluate(() => window.scrollTo(0, 620));
  const box = await controls.boundingBox();

  expect(box).not.toBeNull();
  expect(
    Math.abs(box!.y - 64),
    'selector must sit immediately below the measured header'
  ).toBeLessThan(2);
  await expect(controls).toHaveCSS('position', 'sticky');
  await expect(controls).toHaveCSS('top', '64px');

  for (const selector of ['.game-bar__type', '.game-bar__filter-btn', '.quickprefs__chip']) {
    const target = await page.locator(selector).boundingBox();
    expect(target, `${selector} must render`).not.toBeNull();
    expect(
      target!.height,
      `${selector} must provide a 44px mobile touch target`
    ).toBeGreaterThanOrEqual(44);
  }
});
