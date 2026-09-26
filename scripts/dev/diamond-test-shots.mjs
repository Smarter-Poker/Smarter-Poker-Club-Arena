#!/usr/bin/env node
/**
 * Diamond bonus games: headless screenshots of the fixture page
 * (diamond-test.html, no account, no wallet) against a running Vite dev
 * server, at phone and desktop widths, through each phase of a round.
 *
 *   node scripts/dev/diamond-test-shots.mjs <game> <outDir> [baseUrl]
 *       game: plinko | crash | crossing | mines (add ?super=1 via SUPER=1)
 *       baseUrl defaults to http://127.0.0.1:5199/hub/club-arena
 *
 * Writes <outDir>/<game>-<width>-<phase>.png. WebGL runs on SwiftShader, so
 * the frames are what a phone with no GPU acceleration would draw; the point
 * is the composition, the colours and the copy, not the frame rate.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const [
  ,
  ,
  game = 'crossing',
  outDir = 'test-results/diamond-shots',
  baseUrl = 'http://127.0.0.1:5199/hub/club-arena',
] = process.argv;
const superMode = process.env.SUPER === '1' ? '&super=1' : '';
// A fixed sealed road for the crossing (ROLL=0.07 survives six of twelve
// streets), and how many streets to cross before booking (CROSS=2). The same
// ROLL seals a crash point (0.02 flies to 15.5x, 0.3 crashes at 1.50x).
const fixedRoll = process.env.ROLL ? `&roll=${process.env.ROLL}` : '';
const crossings = Number(process.env.CROSS ?? 2);
// Crash: how long the flight climbs before the open shot (OPEN_MS), and
// CRASHED=1 lets it fly into the sealed crash instead of booking the win.
const openMs = Number(process.env.OPEN_MS ?? (game === 'crash' ? 2600 : 1200));
const flyToCrash = process.env.CRASHED === '1';
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const shot = async (page, width, phase) => {
  // Frame the scene, not the fixture chrome: a click on a console plate can
  // scroll the page past the board on a phone.
  const scene = page
    .locator('canvas, [aria-label="Diamond Mines Board"], [data-motion="keep"]')
    .first();
  await scene.evaluate((el) => el.scrollIntoView({ block: 'start' })).catch(() => {});
  const path = resolve(outDir, `${game}-${width}-${phase}.png`);
  await page.screenshot({ path, fullPage: false });
  console.log(path);
  // And the scene alone, at full resolution, for a close review.
  if (process.env.SCENE_SHOTS !== '0')
    await scene
      .screenshot({ path: resolve(outDir, `${game}-${width}-${phase}-scene.png`) })
      .catch(() => {});
};
/** Mines: turn tiles over in this order (MINE_TILES=13,7,19), stopping at a mine. */
const mineTiles = (process.env.MINE_TILES ?? '13,7').split(',').map(Number);
for (const [width, height, dsf] of [
  [393, 852, 2],
  [1280, 820, 1],
]) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: dsf,
    isMobile: width < 768,
    hasTouch: width < 768,
    // REDUCED=1 captures the reduced-motion presentation.
    reducedMotion: process.env.REDUCED === '1' ? 'reduce' : 'no-preference',
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(`${baseUrl}/diamond-test.html?game=${game}${superMode}${fixedRoll}`, {
    waitUntil: 'networkidle',
  });
  await page.waitForTimeout(1500);
  // Frame the scene, not the fixture chrome above it.
  const scene = page.locator('canvas, [data-motion="keep"]').first();
  await scene.scrollIntoViewIfNeeded().catch(() => {});
  await shot(page, width, 'idle');
  const start = page.getByRole('button', { name: 'Start Test', exact: true });
  if (await start.count()) {
    await start.click();
    await page.waitForTimeout(openMs);
    if (game === 'mines') {
      await shot(page, width, 'open-idle');
      for (const tile of mineTiles) {
        const button = page.getByRole('button', { name: `Tile ${tile}`, exact: true });
        if (!(await button.isEnabled().catch(() => false))) break;
        await button.click();
        await page.waitForTimeout(900);
        if (await page.getByRole('button', { name: /, Mine$/ }).count()) break;
      }
    }
    await shot(page, width, 'open');
    if (game === 'crash' && flyToCrash) {
      // The fixture crashes on its own once the clock passes the sealed point:
      // the flash, the burst a moment later, then the settled frame.
      await page.waitForSelector('[data-phase="crashed"]', { timeout: 120000 });
      await shot(page, width, 'crash-flash');
      await page.waitForTimeout(650);
      await shot(page, width, 'crashed');
      await page.waitForTimeout(2500);
      const proceed = page.getByRole('button', { name: 'Continue', exact: true });
      if (await proceed.count())
        await proceed
          .first()
          .click()
          .catch(() => {});
      await page.waitForTimeout(600);
      await shot(page, width, 'crashed-settled');
      await context.close();
      continue;
    }
    if (game === 'crossing') {
      const cross = page.getByRole('button', { name: 'Cross Next Road', exact: true });
      for (let i = 0; i < crossings && (await cross.isEnabled().catch(() => false)); i++) {
        await cross.click();
        await page.waitForTimeout(2200);
      }
      await shot(page, width, 'street');
    }
    const book = page.getByRole('button', { name: 'Book The Win', exact: true });
    if (await book.isEnabled().catch(() => false)) {
      await book.click();
      await page.waitForTimeout(1800);
      await shot(page, width, 'booked-early');
      await page.waitForTimeout(3500);
      // The prize reveal sits over the settled scene; take it down to see the
      // booked road and how far the donkey could have gone.
      const proceed = page.getByRole('button', { name: 'Continue', exact: true });
      if (await proceed.count())
        await proceed
          .first()
          .click()
          .catch(() => {});
      await page.waitForTimeout(700);
      await shot(page, width, 'booked');
    } else {
      await page.waitForTimeout(3000);
      await shot(page, width, 'settled');
      // The prize reveal covers the scene once a round settles by itself (a
      // Crash round that reached its ceiling, say); dismiss it for the scene.
      const proceed = page.getByRole('button', { name: 'Continue', exact: true });
      if (await proceed.isVisible().catch(() => false)) {
        await proceed.click();
        await page.waitForTimeout(600);
        await shot(page, width, 'settled-scene');
      }
    }
  }
  await context.close();
}
await browser.close();
