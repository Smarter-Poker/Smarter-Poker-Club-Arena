/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  VISUAL REGRESSION — the squeeze at 25 / 50 / 75 / 100% (spec 106, 107, 109)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * ROUND 2 2026-09-05. tests/e2e/live-animations.spec.ts proves the squeeze
 * RUNS and for how long. That is not the same as proving it looks right: a
 * squeeze can drift - turn the wrong way, show the face early, land with a
 * residual transform - while remaining technically functional and exactly the
 * right length. Spec 106 asks for this precisely because of that gap.
 *
 * So this drives the REAL production keyframes to four fixed points on their
 * own timeline and reads back what the browser actually computed:
 *
 *    25%   still on the BACK, narrowing      (0 < rotateY < 90)
 *    50%   past the swap, on the FACE        (90 < rotateY < 180)
 *    75%   the face is at full width         (rotateY === 180)
 *   100%   no residual transform at all      (identity, spec 109)
 *
 * Screenshots are attached to the report at each point so a human can see the
 * shape; the ASSERTIONS are numeric, because a screenshot comparison across
 * machines and browsers is a flake generator and would end up disabled.
 *
 * Run:  npx playwright test tests/e2e/card-squeeze-visual-regression.spec.ts
 */

import { test, expect, type Page } from '@playwright/test';
import { loadLiveCss as loadLiveCssShared, skipUnlessLiveCss } from './lib/live-css';

const ARENA = process.env.ARENA_BASE_URL || 'https://smarter.poker/hub/club-arena';

/**
 * The shipped-CSS loader lives in tests/e2e/lib/live-css.ts. This file used
 * to hold its own copy, which could not tell an unreadable bundle from a
 * bundle with no animations - see the header there.
 */
async function loadLiveCss(page: Page) {
  const load = await loadLiveCssShared(page, ARENA, { animationSpeed: '1' });
  skipUnlessLiveCss(load, ARENA);
}

/** One squeezing board card, built exactly as SqueezeCard renders it. */
async function mountSqueeze(page: Page) {
  await page.evaluate(() => {
    document.body.style.background = '#123';
    const root = document.createElement('div');
    root.className = 'table-page';
    root.innerHTML = `<div class="community-cards"><div class="community-cards__container" id="bc">
      <div class="community-cards__card community-cards__card--river card-squeeze-host" id="card"
           style="width:65px;height:91px">
        <div class="card-squeeze__shadow"></div>
        <div class="card-squeeze" id="flip">
          <div class="card-squeeze__face card-squeeze__face--back"
               style="background:#7a1620"></div>
          <div class="card-squeeze__face card-squeeze__face--front"
               style="background:#f4f4f4"></div>
        </div>
        <div class="card-squeeze__spine" id="spine"></div>
      </div></div></div>`;
    document.body.appendChild(root);
  });
}

/**
 * Park every animation at `pct` of the FLIP's own active duration and report
 * what the browser computed. rotateY is recovered from the matrix: for
 * rotateY(t) scaled by s the matrix carries m11 = s*cos(t) and m13 = -s*sin(t).
 */
async function at(page: Page, pct: number) {
  return page.evaluate((p: number) => {
    const flip = document.getElementById('flip')!;
    const spine = document.getElementById('spine')!;
    const host = document.getElementById('card')!;
    for (const a of document.getAnimations()) {
      const t = a.effect?.getTiming();
      if (!t) continue;
      const delay = typeof t.delay === 'number' ? t.delay : 0;
      const dur = typeof t.duration === 'number' ? t.duration : 0;
      a.pause();
      a.currentTime = delay + dur * p;
    }
    const read = (el: Element) => {
      const cs = getComputedStyle(el);
      const m = new DOMMatrixReadOnly(cs.transform === 'none' ? '' : cs.transform);
      const deg = (Math.atan2(-m.m13, m.m11) * 180) / Math.PI;
      return {
        transform: cs.transform,
        opacity: Number(cs.opacity),
        angle: (deg + 360) % 360,
        scale: Math.hypot(m.m11, m.m13),
      };
    };
    return { flip: read(flip), spine: read(spine), host: read(host) };
  }, pct);
}

/**
 * AUDIT FIX 2026-09-05. The replay's card wrapper had `display: inline-flex`
 * and no size, on the reasoning that it would "hug the CardImage exactly".
 * Every element SqueezeCard renders is `position: absolute`, so during a
 * reveal the wrapper had no in-flow child, collapsed to 0x0 and took the
 * whole card with it - invisible for the entire reveal, on the one surface a
 * player is deliberately studying, with the row reflowing around the hole.
 *
 * Only a real browser can catch that: happy-dom does no layout, so every
 * unit test measured zero and could not tell the difference. This measures.
 */
test.describe('the replay card keeps its box while it squeezes', () => {
  test.beforeEach(async ({ page }) => {
    await loadLiveCss(page);
    await page.evaluate(() => {
      document.body.innerHTML = `<div class="hr-felt"><div class="hr-felt__boards">
        <div class="hr-felt__board" id="board">
          <div class="hr-felt__card" id="plain">
            <div class="card-image card-image--sm"></div>
          </div>
          <div class="hr-felt__card card-squeeze-host" id="sq">
            <div class="card-squeeze__shadow"></div>
            <div class="card-squeeze">
              <div class="card-squeeze__face card-squeeze__face--back"></div>
              <div class="card-squeeze__face card-squeeze__face--front"></div>
            </div>
            <div class="card-squeeze__spine"></div>
          </div>
        </div></div></div>`;
    });
  });

  test('a squeezing card is the same size as a still one, and never 0x0', async ({ page }) => {
    const box = await page.evaluate(() => {
      /* offsetWidth/Height, not getBoundingClientRect: the squeezing card is
         mid-animation and its RENDERED rect carries the transform (scaleX at
         the materialise keyframe). What must not collapse is the LAYOUT box,
         which is what the row is measured from. */
      const r = (id: string) => {
        const el = document.getElementById(id)! as HTMLElement;
        return { w: el.offsetWidth, h: el.offsetHeight };
      };
      const face = document.querySelector('#sq .card-squeeze__face--front')! as HTMLElement;
      return { plain: r('plain'), squeeze: r('sq'), face: face.offsetWidth };
    });
    expect(box.squeeze.w, 'the squeezing card must have a width').toBeGreaterThan(0);
    expect(box.squeeze.h, 'and a height').toBeGreaterThan(0);
    expect(box.squeeze, 'squeezing must not change the box').toEqual(box.plain);
    expect(box.face, 'the faces must fill the wrapper, not collapse').toBe(box.squeeze.w);
  });

  test('the board row does not reflow when a card starts squeezing', async ({ page }) => {
    const widths = await page.evaluate(() => {
      const board = document.getElementById('board')!;
      const before = board.getBoundingClientRect().width;
      document.getElementById('sq')!.classList.remove('card-squeeze-host');
      const after = board.getBoundingClientRect().width;
      return { before: Math.round(before), after: Math.round(after) };
    });
    expect(widths.before).toBe(widths.after);
  });
});

test.describe('the host lends its decoration to the card that is turning', () => {
  test.beforeEach(async ({ page }) => {
    await loadLiveCss(page);
    await mountSqueeze(page);
  });

  test('the felt card suppresses its own shadow and pseudo-elements mid-flip', async ({ page }) => {
    const seen = await page.evaluate(() => {
      const host = document.getElementById('card')!;
      /* getComputedStyle returns a LIVE declaration - reading it after the
         class is removed reports the restored value, not the one under test.
         Snapshot to primitives first. */
      const shadow = getComputedStyle(host).boxShadow;
      const beforeDisplay = getComputedStyle(host, '::before').display;
      const afterDisplay = getComputedStyle(host, '::after').display;
      host.classList.remove('card-squeeze-host');
      const restored = getComputedStyle(host).boxShadow;
      return { shadow, beforeDisplay, afterDisplay, restored };
    });
    // While squeezing: no host shadow, no gloss, no sheen over the edge-on card.
    expect(seen.shadow).toBe('none');
    expect(seen.beforeDisplay).toBe('none');
    expect(seen.afterDisplay).toBe('none');
    // And it all comes back the moment the class goes.
    expect(seen.restored).not.toBe('none');
  });
});

test.describe('the squeeze, quarter by quarter', () => {
  test.beforeEach(async ({ page }) => {
    await loadLiveCss(page);
    await mountSqueeze(page);
  });

  test('25/50/75/100% each look the way the reference does', async ({ page }, testInfo) => {
    const card = page.locator('#card');

    // ── 25% — still the BACK, narrowing toward its edge ────────────────────
    const q1 = await at(page, 0.25);
    expect(q1.flip.angle, 'at a quarter the card must still be turning').toBeGreaterThan(0);
    expect(q1.flip.angle, 'and must NOT have reached the swap yet').toBeLessThan(90);
    await testInfo.attach('squeeze-25', {
      body: await card.screenshot(),
      contentType: 'image/png',
    });

    // ── 50% — past the swap, the FACE is widening ──────────────────────────
    const q2 = await at(page, 0.5);
    expect(q2.flip.angle, 'at half the face must already be showing').toBeGreaterThan(90);
    expect(q2.flip.angle, 'and must not be full width yet').toBeLessThan(180);
    expect(q2.flip.angle, 'the turn only ever goes one way').toBeGreaterThan(q1.flip.angle);
    await testInfo.attach('squeeze-50', {
      body: await card.screenshot(),
      contentType: 'image/png',
    });

    // ── 75% — the face is at full width, and this is where the spine ends ──
    const q3 = await at(page, 0.75);
    expect(Math.abs(q3.flip.angle - 180), 'at three quarters the face is full width').toBeLessThan(
      0.5
    );
    expect(q3.spine.opacity, 'the edge is long gone by now').toBeLessThan(0.05);
    await testInfo.attach('squeeze-75', {
      body: await card.screenshot(),
      contentType: 'image/png',
    });

    // ── 100% — NO residual transform (spec 109) ────────────────────────────
    const q4 = await at(page, 1);
    expect(Math.abs(q4.flip.angle - 180), 'the card rests face up').toBeLessThan(0.5);
    expect(Math.abs(q4.flip.scale - 1), 'no residual scale from the overshoot').toBeLessThan(0.005);
    // `none` or the identity matrix - the materialise animation fills
    // forwards onto `transform: none`, which Chrome reports as identity.
    // Either way there is no residual transform, which is what spec 109 asks.
    expect(
      q4.host.transform === 'none' ||
        /^matrix\(1,\s*0,\s*0,\s*1,\s*0,\s*0\)$/.test(q4.host.transform),
      `the host itself rests untransformed, got ${q4.host.transform}`
    ).toBe(true);
    expect(q4.spine.opacity, 'the edge is invisible at rest').toBeLessThan(0.05);
    await testInfo.attach('squeeze-100', {
      body: await card.screenshot(),
      contentType: 'image/png',
    });
  });

  test('the edge spine exists exactly at the swap and nowhere else (spec 73)', async ({ page }) => {
    // Before: no edge. At the swap: a visible edge. After: gone again.
    expect((await at(page, 0.2)).spine.opacity).toBeLessThan(0.05);
    const swap = await at(page, 0.375);
    expect(swap.spine.opacity, 'a card at 90deg must still read as a card').toBeGreaterThan(0.9);
    expect(Math.abs(swap.flip.angle - 90), 'the swap is exactly edge-on').toBeLessThan(1);
    expect((await at(page, 0.6)).spine.opacity).toBeLessThan(0.05);
  });

  test('the shadow thins at the swap and returns, by opacity only (spec 72)', async ({ page }) => {
    const shadowAt = (p: number) =>
      page.evaluate((pct: number) => {
        for (const a of document.getAnimations()) {
          const t = a.effect?.getTiming();
          if (!t) continue;
          const delay = typeof t.delay === 'number' ? t.delay : 0;
          const dur = typeof t.duration === 'number' ? t.duration : 0;
          a.pause();
          a.currentTime = delay + dur * pct;
        }
        const el = document.querySelector('.card-squeeze__shadow')!;
        const cs = getComputedStyle(el);
        return { opacity: Number(cs.opacity), boxShadow: cs.boxShadow };
      }, p);

    const start = await shadowAt(0);
    const swap = await shadowAt(0.375);
    const end = await shadowAt(1);
    expect(swap.opacity, 'a card seen edge-on casts almost nothing').toBeLessThan(start.opacity);
    expect(end.opacity, 'and it is back when the card lies flat').toBeGreaterThan(swap.opacity);
    // The blur radius never changes - that is what keeps it off the paint path.
    expect(swap.boxShadow).toBe(start.boxShadow);
    expect(end.boxShadow).toBe(start.boxShadow);
  });

  test('the card never distorts: scaleY is untouched throughout (spec 108)', async ({ page }) => {
    for (const pct of [0, 0.25, 0.375, 0.5, 0.75, 0.9, 1]) {
      const m = await page.evaluate((p: number) => {
        for (const a of document.getAnimations()) {
          const t = a.effect?.getTiming();
          if (!t) continue;
          const delay = typeof t.delay === 'number' ? t.delay : 0;
          const dur = typeof t.duration === 'number' ? t.duration : 0;
          a.pause();
          a.currentTime = delay + dur * p;
        }
        const cs = getComputedStyle(document.getElementById('flip')!);
        const mat = new DOMMatrixReadOnly(cs.transform === 'none' ? '' : cs.transform);
        return { m22: mat.m22 };
      }, pct);
      // The overshoot is a UNIFORM scale, so m22 tracks it; what must never
      // happen is a horizontal-only stretch leaving the height alone at 1
      // while the width changes independently. Height stays within the
      // overshoot bound at every point.
      expect(m.m22, `vertical scale at ${pct * 100}%`).toBeGreaterThan(0.98);
      expect(m.m22, `vertical scale at ${pct * 100}%`).toBeLessThan(1.04);
    }
  });
});
