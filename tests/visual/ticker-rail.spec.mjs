/**
 * Writes the pictures. Run: node tests/visual/ticker-rail.spec.mjs
 *
 * Desktop, phone, and the reduced-motion branch - which is the one nobody has
 * ever looked at, because it only exists for a player who asked for no motion.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const URL = process.env.HARNESS_URL || 'http://localhost:5199/tests/visual/ticker-rail.html';
const OUT = process.env.SHOT_DIR || 'tests/visual/__shots__';
mkdirSync(OUT, { recursive: true });

const SHOTS = [
  { name: 'desktop', viewport: { width: 1440, height: 520 }, reducedMotion: 'no-preference' },
  { name: 'phone', viewport: { width: 375, height: 520 }, reducedMotion: 'no-preference' },
  { name: 'reduced-motion', viewport: { width: 1440, height: 520 }, reducedMotion: 'reduce' },
  { name: 'ultrawide', viewport: { width: 2560, height: 520 }, reducedMotion: 'no-preference' },
];

const browser = await chromium.launch();
for (const shot of SHOTS) {
  const ctx = await browser.newContext({
    viewport: shot.viewport,
    reducedMotion: shot.reducedMotion,
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
  // Let the marquee settle on a frame and the fonts land.
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/${shot.name}.png`, fullPage: false });
  console.log(`wrote ${OUT}/${shot.name}.png`);
  await ctx.close();
}
await browser.close();
