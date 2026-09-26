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
 * VIEWS picks the sizes (comma separated, default phone,desktop):
 *   phone      393 x 852 portrait
 *   desktop    1280 x 820
 *   landscape  812 x 375, a phone on its side
 *   safe       844 x 390 on its side with an iPhone's safe area: Chromium's own
 *              Emulation.setSafeAreaInsetsOverride sets env(safe-area-inset-*)
 *              to 47px left and right (the notch and its mirror) and 21px at the
 *              bottom (the home indicator), exactly what the pages read.
 * The two landscape views frame the console, not the scene, so each frame is
 * what the player sees without scrolling, and every shot logs a LAYOUT line:
 * horizontal overflow, and whether the scene and both plates sit inside the
 * viewport (and, with the safe area, clear of the insets).
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
const VIEW_SIZES = {
  phone: { width: 393, height: 852, dsf: 2, mobile: true },
  desktop: { width: 1280, height: 820, dsf: 1, mobile: false },
  landscape: { width: 812, height: 375, dsf: 2, mobile: true, sideways: true },
  safe: {
    width: 844,
    height: 390,
    dsf: 2,
    mobile: true,
    sideways: true,
    insets: { top: 0, left: 47, right: 47, bottom: 21 },
  },
};
const views = (process.env.VIEWS ?? 'phone,desktop')
  .split(',')
  .map((name) => name.trim())
  .filter((name) => name in VIEW_SIZES);
/** Where every piece the player needs sits, against the viewport and its insets. */
const layout = (page, insets) =>
  page.evaluate((inset) => {
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        left: Math.round(r.left),
        right: Math.round(r.right),
      };
    };
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pieces = {
      scene: box(
        document.querySelector('[data-game-console] canvas, [aria-label="Diamond Mines Board"]')
      ),
      primary: box(document.querySelector('[data-plate="primary"]')),
      secondary: box(document.querySelector('[data-plate="secondary"]')),
    };
    const problems = [];
    const doc = document.scrollingElement;
    if (doc.scrollWidth > doc.clientWidth + 1)
      problems.push(`horizontal scroll ${doc.scrollWidth - doc.clientWidth}px`);
    for (const [name, r] of Object.entries(pieces)) {
      if (!r) continue;
      if (r.top < 0 || r.bottom > vh)
        problems.push(`${name} outside viewport (${r.top}..${r.bottom} of ${vh})`);
      if (inset && name !== 'scene') {
        if (r.bottom > vh - inset.bottom) problems.push(`${name} under the home indicator`);
        if (r.left < inset.left || r.right > vw - inset.right)
          problems.push(`${name} under the notch`);
      }
    }
    return { pieces, problems };
  }, insets ?? null);
const shot = async (page, width, phase, view = {}) => {
  // Frame the scene, not the fixture chrome: a click on a console plate can
  // scroll the page past the board on a phone. On its side, frame the console:
  // the question there is whether the scene and its plates fit one screen.
  const scene = page
    .locator(
      view.sideways
        ? '[data-game-console]'
        : 'canvas, [aria-label="Diamond Mines Board"], [data-motion="keep"]'
    )
    .first();
  await scene.evaluate((el) => el.scrollIntoView({ block: 'start' })).catch(() => {});
  const path = resolve(outDir, `${game}-${width}-${phase}.png`);
  await page.screenshot({ path, fullPage: false });
  console.log(path);
  if (view.sideways) {
    const { pieces, problems } = await layout(page, view.insets);
    console.log(
      `LAYOUT ${game}-${width}-${phase} ${problems.length ? problems.join('; ') : 'ok'} ${JSON.stringify(pieces)}`
    );
  }
  // And the scene alone, at full resolution, for a close review.
  if (process.env.SCENE_SHOTS !== '0')
    await scene
      .screenshot({ path: resolve(outDir, `${game}-${width}-${phase}-scene.png`) })
      .catch(() => {});
};
/** The finished game's receipt, once its pop-open has played. */
const receipt = async (page, width, view) => {
  const dialog = page.getByRole('dialog');
  // Already up (it arrived while the scene was being shot): take it now, as
  // the test page's receipt continues by itself after five seconds.
  const already = await dialog.isVisible().catch(() => false);
  const arrived =
    already ||
    (await dialog.waitFor({ timeout: 20000 }).then(
      () => true,
      () => false
    ));
  if (!arrived) return;
  // The pop-open and the art's own entrance take about 1.4s.
  await page.waitForTimeout(already ? 200 : 1600);
  await shot(page, width, 'receipt', view);
};
/** Mines: turn tiles over in this order (MINE_TILES=13,7,19), stopping at a mine. */
const mineTiles = (process.env.MINE_TILES ?? '13,7').split(',').map(Number);
for (const view of views.map((name) => VIEW_SIZES[name])) {
  const { width, height, dsf } = view;
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: dsf,
    isMobile: view.mobile,
    hasTouch: view.mobile,
    // REDUCED=1 captures the reduced-motion presentation.
    reducedMotion: process.env.REDUCED === '1' ? 'reduce' : 'no-preference',
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  if (view.insets) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: view.insets });
  }
  await page.goto(`${baseUrl}/diamond-test.html?game=${game}${superMode}${fixedRoll}`, {
    waitUntil: 'networkidle',
  });
  await page.waitForTimeout(1500);
  // Frame the scene, not the fixture chrome above it.
  const scene = page.locator('canvas, [data-motion="keep"]').first();
  await scene.scrollIntoViewIfNeeded().catch(() => {});
  await shot(page, width, 'idle', view);
  const start = page.getByRole('button', { name: 'Start Test', exact: true });
  if (await start.count()) {
    await start.click();
    await page.waitForTimeout(openMs);
    if (game === 'mines') {
      await shot(page, width, 'open-idle', view);
      for (const tile of mineTiles) {
        const button = page.getByRole('button', { name: `Tile ${tile}`, exact: true });
        if (!(await button.isEnabled().catch(() => false))) break;
        await button.click();
        await page.waitForTimeout(900);
        if (await page.getByRole('button', { name: /, Mine$/ }).count()) break;
      }
    }
    await shot(page, width, 'open', view);
    if (game === 'crash' && flyToCrash) {
      // The fixture crashes on its own once the clock passes the sealed point:
      // the flash, the burst a moment later, then the settled frame.
      await page.waitForSelector('[data-phase="crashed"]', { timeout: 120000 });
      await shot(page, width, 'crash-flash', view);
      await page.waitForTimeout(650);
      await shot(page, width, 'crashed', view);
      await receipt(page, width, view);
      const proceed = page.getByRole('button', { name: 'Continue', exact: true });
      if (await proceed.count())
        await proceed
          .first()
          .click()
          .catch(() => {});
      await page.waitForTimeout(600);
      await shot(page, width, 'crashed-settled', view);
      await context.close();
      continue;
    }
    if (game === 'crossing') {
      const cross = page.getByRole('button', { name: 'Cross Next Road', exact: true });
      for (let i = 0; i < crossings && (await cross.isEnabled().catch(() => false)); i++) {
        await cross.click();
        // A hit ends the round and its receipt follows the bust; the test
        // page's receipt continues by itself after five seconds, so catch it.
        const hit = await page
          .getByRole('dialog')
          .waitFor({ timeout: 2200 })
          .then(
            () => true,
            () => false
          );
        if (hit) {
          await receipt(page, width, view);
          break;
        }
      }
      if (
        await page
          .getByRole('dialog')
          .isVisible()
          .catch(() => false)
      )
        await receipt(page, width, view);
      await shot(page, width, 'street', view);
    }
    const book = page.getByRole('button', { name: 'Book The Win', exact: true });
    if (await book.isEnabled().catch(() => false)) {
      await book.click();
      await page.waitForTimeout(1800);
      await shot(page, width, 'booked-early', view);
      await receipt(page, width, view);
      // The prize reveal sits over the settled scene; take it down to see the
      // booked road and how far the donkey could have gone.
      const proceed = page.getByRole('button', { name: 'Continue', exact: true });
      if (await proceed.count())
        await proceed
          .first()
          .click()
          .catch(() => {});
      await page.waitForTimeout(700);
      await shot(page, width, 'booked', view);
    } else {
      await receipt(page, width, view);
      await page.waitForTimeout(600);
      await shot(page, width, 'settled', view);
      // The prize reveal covers the scene once a round settles by itself (a
      // Crash round that reached its ceiling, say); dismiss it for the scene.
      const proceed = page.getByRole('button', { name: 'Continue', exact: true });
      if (await proceed.isVisible().catch(() => false)) {
        await proceed.click();
        await page.waitForTimeout(600);
        await shot(page, width, 'settled-scene', view);
      }
    }
  }
  await context.close();
}
await browser.close();
