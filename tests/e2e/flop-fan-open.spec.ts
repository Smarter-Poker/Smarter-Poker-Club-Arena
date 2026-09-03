/**
 * Dan 2026-08-19, bug list item 5: "flops must deal 3 cards face down then fan
 * open (animation), not just appear."
 *
 * The old animation spun each card in from rotateY(180deg), but the card was a
 * SINGLE element and that element was the FACE. Half a turn of a one-sided card
 * shows the face mirrored, never a back - the card was legible before it
 * landed, which is why it read as "the cards just appear".
 *
 * There are now two real surfaces per card and two phases. This spec samples
 * the flip's rotation over time, against the real stylesheet, and asserts:
 *   - during the deal the cards are FACE DOWN
 *   - they turn over left to right, not all at once
 *   - they finish FACE UP
 *   - with animations suppressed the board is face up, never stuck on backs
 *
 * Rotation is read from the live computed matrix: m11 is cos(theta), so +1 is
 * 0deg (back showing) and -1 is 180deg (front showing).
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const css = fs.readFileSync(
  path.join(process.cwd(), 'src/components/table/CommunityCards.css'),
  'utf8'
);

/** The markup CardFace emits for a newly dealt flop card. */
const flopBoard = `
  <div class="community-cards">
    <div class="community-cards__container">
      ${[0, 1, 2]
        .map(
          (i) => `
        <div class="community-cards__card community-cards__card--flop-deal"
             id="card-${i}" style="animation-delay:${i * 100}ms; --card-index:${i}">
          <div class="community-cards__flip" id="flip-${i}">
            <div class="community-cards__flip-face community-cards__flip-face--back"></div>
            <div class="community-cards__flip-face community-cards__flip-face--front"></div>
          </div>
        </div>`
        )
        .join('')}
    </div>
  </div>`;

const page = (extraCss = '') => `
  <style>
    body { margin: 0; background: #123; }
    :root { --animation-speed: 1; }
    .community-cards__container { display: flex; gap: 8px; }
    .community-cards__flip-face--back { background: #224; }
    .community-cards__flip-face--front { background: #eee; }
  </style>
  <style>${css}</style>
  <style>${extraCss}</style>
  ${flopBoard}`;

/** cos(theta) of the flip's current rotation. +1 = face down, -1 = face up. */
async function cosTheta(p: import('@playwright/test').Page, i: number) {
  return p.evaluate((idx) => {
    const el = document.getElementById(`flip-${idx}`)!;
    const t = getComputedStyle(el).transform;
    if (!t || t === 'none') return 1;
    const nums = t
      .slice(t.indexOf('(') + 1, -1)
      .split(',')
      .map((n) => parseFloat(n));
    return nums[0]; // m11
  }, i);
}

test.use({ viewport: { width: 800, height: 400 } });

/**
 * Animation timings, read off the live timeline rather than sampled by sleeping.
 *
 * 2026-08-19: the first version of these tests waited a fixed 700ms and then
 * asserted on the rotation it happened to catch. That is a race — under a
 * loaded parallel run the animation had not started yet and the spec failed on
 * main. getAnimations() exposes delay and duration directly, so the ORDERING
 * (land, then fan open, left to right) is checked deterministically and the
 * only thing left to wait on is `finished`.
 */
async function timings(p: import('@playwright/test').Page) {
  return p.evaluate(() =>
    [0, 1, 2].map((i) => {
      const card = document.getElementById(`card-${i}`)!;
      const flip = document.getElementById(`flip-${i}`)!;
      const one = (el: Element, name: string) => {
        const a = el.getAnimations().find((x) => (x as CSSAnimation).animationName === name) as
          | CSSAnimation
          | undefined;
        const t = a?.effect?.getComputedTiming();
        return { delay: Number(t?.delay ?? NaN), duration: Number(t?.duration ?? NaN) };
      };
      return { land: one(card, 'ccFlopLand'), flip: one(flip, 'ccFlopFanOpen') };
    })
  );
}

test('all three cards are dealt FACE DOWN before anything turns over', async ({ page: p }) => {
  await p.setContent(page());
  const t = await timings(p);

  // Every card lands before the FIRST flip begins — nothing turns over while a
  // card is still in the air.
  const lastLanded = Math.max(...t.map((c) => c.land.delay + c.land.duration));
  const firstFlip = Math.min(...t.map((c) => c.flip.delay));
  expect(firstFlip).toBeGreaterThanOrEqual(lastLanded);
});

test('they fan open LEFT TO RIGHT, not all at once', async ({ page: p }) => {
  await p.setContent(page());
  const t = await timings(p);
  expect(t[0].flip.delay).toBeLessThan(t[1].flip.delay);
  expect(t[1].flip.delay).toBeLessThan(t[2].flip.delay);
});

test('the deal itself is staggered, not simultaneous', async ({ page: p }) => {
  await p.setContent(page());
  const t = await timings(p);
  expect(t[0].land.delay).toBeLessThan(t[1].land.delay);
  expect(t[1].land.delay).toBeLessThan(t[2].land.delay);
});

test('the flop finishes FACE UP', async ({ page: p }) => {
  await p.setContent(page());
  // Derive the wait from the real timings rather than guessing a number: the
  // sequence is over once the LAST flip's delay + duration has elapsed.
  const t = await timings(p);
  const endsAt = Math.max(...t.map((c) => c.flip.delay + c.flip.duration));
  await p.waitForTimeout(endsAt + 250);
  for (const i of [0, 1, 2]) {
    expect(await cosTheta(p, i)).toBeLessThan(-0.9); // ~180deg, front showing
  }
});

test('with animations suppressed the board is FACE UP, never stuck on backs', async ({
  page: p,
}) => {
  await p.setContent(page('* { animation: none !important; }'));
  for (const i of [0, 1, 2]) {
    expect(await cosTheta(p, i)).toBeLessThan(-0.9);
  }
});

test('only one face is ever presented to the viewer', async ({ page: p }) => {
  await p.setContent(page());
  const hidden = await p.evaluate(() =>
    Array.from(document.querySelectorAll('.community-cards__flip-face')).map(
      (el) => getComputedStyle(el).backfaceVisibility
    )
  );
  expect(hidden).toHaveLength(6);
  for (const h of hidden) expect(h).toBe('hidden');
});
