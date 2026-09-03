/**
 * Dan 2026-08-19, bug list item 4: "cards glitch once before display - all
 * cards shown at once after being dealt."
 *
 * Two causes, both in one keyframe.
 *
 *  1. THE GLITCH. heroCardPeek started every card at rotateY(90deg). A hole
 *     card is a SINGLE-SIDED element, so edge-on it has no width and nothing to
 *     draw - a flash of nothing, then the card snapping into existence. It then
 *     overshot past its resting size (scale 1.05, rotateY -10deg) and rocked
 *     back through two more keyframes, so the card visibly wobbled before
 *     settling.
 *
 *  2. NOT AT ONCE. Each card carried its own animation-delay - 0.1s, 0.25s,
 *     0.4s, 0.55s, 0.7s, 0.85s - so a PLO6 hand trickled in over most of a
 *     second, one card at a time.
 *
 * The cards now simply arrive: a short rise and fade, no rotation, no
 * overshoot, and no per-card stagger.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const css = fs.readFileSync(path.join(process.cwd(), 'src/components/table/SeatSlot.css'), 'utf8');

const heroSeat = (cardCount: number) => `
  <div class="seat seat--hero seat--in-hand">
    <div class="seat__avatar-wrap"><div class="seat__avatar"></div></div>
    <div class="seat__info"><span class="seat__name">HERO</span></div>
    <div class="seat__cards seat__cards--hero">
      ${Array.from({ length: cardCount }, (_, i) => `<div class="seat__card seat__card--face" id="hc-${i}"></div>`).join('')}
    </div>
  </div>`;

const page = (n: number) => `
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; background: #123; }
    :root { --seat-avatar-size: 112px; }
    .seat { position: relative; width: 128px; margin: 200px auto; }
    .seat__avatar { width: var(--seat-avatar-size); height: var(--seat-avatar-size); border-radius: 50%; background: #444; }
    .seat__info { width: 100%; height: 34px; background: #222; }
    .seat__card--face { background: #fff; }
  </style>
  <style>${css}</style>
  ${heroSeat(n)}`;

async function cardStyles(p: import('@playwright/test').Page, n: number) {
  return p.evaluate((count) => {
    return Array.from({ length: count }, (_, i) => {
      const el = document.getElementById(`hc-${i}`)!;
      const cs = getComputedStyle(el);
      return { delay: cs.animationDelay, name: cs.animationName, duration: cs.animationDuration };
    });
  }, n);
}

test.use({ viewport: { width: 900, height: 800 } });

for (const n of [2, 4, 5, 6]) {
  test(`${n} hole cards all start at the same instant`, async ({ page: p }) => {
    await p.setContent(page(n));
    const styles = await cardStyles(p, n);
    expect(styles).toHaveLength(n);
    const delays = new Set(styles.map((s) => s.delay));
    expect(delays.size).toBe(1); // no per-card stagger
    expect([...delays][0]).toBe('0s');
  });
}

test('the deal animation never turns the card edge-on', async ({ page: p }) => {
  await p.setContent(page(6));
  const [style] = await cardStyles(p, 1);
  expect(style.name).toBe('heroCardDeal');

  // Sample the card's width across the whole animation. A rotateY(90deg) frame
  // collapses it to zero - that is the glitch, and it must never happen.
  const widths = await p.evaluate(async () => {
    const el = document.getElementById('hc-0')!;
    const seen: number[] = [];
    for (let i = 0; i < 24; i++) {
      seen.push(el.getBoundingClientRect().width);
      await new Promise((r) => setTimeout(r, 15));
    }
    return seen;
  });
  expect(Math.min(...widths)).toBeGreaterThan(0);
});

test('the card never overshoots its resting size', async ({ page: p }) => {
  await p.setContent(page(2));
  const resting = await p.evaluate(() => {
    const el = document.getElementById('hc-0')!;
    return parseFloat(getComputedStyle(el).width);
  });
  const widths = await p.evaluate(async () => {
    const el = document.getElementById('hc-0')!;
    const seen: number[] = [];
    for (let i = 0; i < 24; i++) {
      seen.push(el.getBoundingClientRect().width);
      await new Promise((r) => setTimeout(r, 15));
    }
    return seen;
  });
  // Allow a hair for sub-pixel rounding; the old keyframe overshot by 5%.
  expect(Math.max(...widths)).toBeLessThanOrEqual(resting + 0.5);
});

test('the whole hand is on screen quickly, not trickled in', async ({ page: p }) => {
  await p.setContent(page(6));
  const styles = await cardStyles(p, 6);
  for (const s of styles) {
    expect(parseFloat(s.duration)).toBeLessThanOrEqual(0.4);
  }
});
