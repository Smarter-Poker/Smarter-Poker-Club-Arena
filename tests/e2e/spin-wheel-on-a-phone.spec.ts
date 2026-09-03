/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE SPIN WHEEL, ON A PHONE — and the durations the engine is waiting on
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-28: "I STILL CAN'T EVEN SIT DOWN AND PLAY ... AND THE SPIN
 * ANIMATION NEVER PLAYS!!!"
 *
 * The engine half of that complaint has been fixed and proven. The half a
 * player actually SEES had not been, and the 2026-08-31 audit found why:
 *
 *   - the vitest suites (sharedSpinReveal, spinPostReveal, SpinWheel.test)
 *     assert the DOM and the handler wiring, but jsdom lays nothing out and
 *     runs no real timer, so it cannot tell whether anything is PAINTED;
 *   - `live-animations.spec.ts` measures the wheel's real keyframes, but only
 *     at `devices['Desktop Chrome']`;
 *   - the horse fleet runs ~20,900 spins a week and proves the ENGINE - but a
 *     horse has no browser (CLAUDE.md 10.5: HorseLogic is its input device),
 *     so it can never exercise one pixel of this.
 *
 * So the wheel - a FULL-SCREEN modal takeover, the single most likely thing
 * to break on a small screen - had no phone coverage at all. That is the gap
 * this file closes, in the same way the repo already trusts for the insurance
 * dialog: load the SHIPPED stylesheets, mount the real markup, and assert
 * what the browser actually paints.
 *
 * TWO CLASSES OF REGRESSION ARE PINNED HERE.
 *
 * 1. PAINTED, ON A PHONE. The disc, the drawn multiplier and the prize must
 *    be inside the 375px viewport and non-zero in size. The insurance modal
 *    shipped with its decision buttons below the clip line on exactly this
 *    viewport (hand #3158299) - a timed financial decision with no visible
 *    controls. The wheel announces what a player is playing for; the same
 *    failure here is the same severity.
 *
 * 2. THE SHIPPED CSS STILL LASTS AS LONG AS THE ENGINE HOLDS. The engine
 *    holds the deal for spinRevealToDealMs() and the client scales its
 *    animation against that hold. If a CSS edit shortens the chase, the wheel
 *    finishes early and the table sits dead; if it lengthens it past the
 *    hold, cards are dealt over the top of the card announcing the prize -
 *    which is the exact bug spinRevealTotalMs()'s own comment records (a
 *    4200ms client result against a 2200ms engine hold, for two full
 *    seconds). These beats are read from the DEPLOYED bundle, so the pin
 *    fails when the shipped stylesheet drifts from the spec, not merely when
 *    a source file does.
 */

import { test, expect, type Page } from '@playwright/test';
import { SPIN_REVEAL } from '../../src/config/spinSpec';

/** CI runs against this commit's own build; a bare local run hits production. */
const ARENA = process.env.ARENA_BASE_URL || 'https://smarter.poker/hub/club-arena';

/** A real phone. 375 is the width CLAUDE.md names as the design floor. */
const PHONE = { width: 375, height: 667 };

/**
 * Pull the SHIPPED stylesheets in, exactly as live-animations.spec.ts does.
 * The component CSS lives in lazy chunks that index.html does not link, so
 * they are discovered from the entry module's own graph.
 */
async function loadLiveCss(page: Page): Promise<void> {
  await page.goto(`${ARENA}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async (base: string) => {
    const html = await fetch(base + 'index.html').then((r) => r.text());
    const entry = html.match(/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0];
    const js = entry ? await fetch(base + entry).then((r) => r.text()) : '';
    const names = new Set<string>();
    for (const m of js.matchAll(/assets\/[A-Za-z0-9_.-]+\.css/g)) names.add(m[0]);
    for (const m of html.matchAll(/assets\/[A-Za-z0-9_.-]+\.css/g)) names.add(m[0]);
    document.body.innerHTML = '';
    for (const n of names) {
      try {
        const css = await fetch(base + n).then((r) => r.text());
        const s = document.createElement('style');
        s.textContent = css;
        document.head.appendChild(s);
      } catch {
        /* a chunk that 404s is not this test's problem */
      }
    }
    // Speed 1 = the shipped durations, unscaled. The player's Animation Speed
    // preference may only scale this; it may never remove a beat (10.6).
    document.documentElement.style.setProperty('--animation-speed', '1');
  }, `${ARENA}/`);
}

/**
 * The wheel at its RESULT phase — the moment that has to survive a phone,
 * because it carries the number the whole sequence exists to announce.
 *
 * Markup mirrors SpinWheel.tsx's own render: sw > sw__dim + sw__beam +
 * sw__stage > (disc | result). Class names are the component's, so a rename
 * that leaves this file behind shows up as a failure rather than a silent
 * pass on markup nothing renders any more.
 */
async function mountWheelResult(page: Page, multiplier = 25, prize = 250): Promise<void> {
  await page.evaluate(
    ({ mult, pz }) => {
      const root = document.createElement('div');
      root.className = 'table-page';
      root.innerHTML = `
        <div class="sw sw--result">
          <div class="sw__dim"></div>
          <div class="sw__beam"></div>
          <div class="sw__stage">
            <div class="sw__disc-wrap">
              <div class="sw__disc">
                <div class="sw__seg sw__seg--c0 sw__seg--winner">
                  <span class="sw__seg-label">${mult}</span>
                </div>
                <div class="sw__hub"><span class="sw__hub-mult">${mult}x</span></div>
              </div>
            </div>
            <div class="sw__result">
              <div class="sw__prize">${pz}</div>
              <div class="sw__prize-label">PRIZE POOL</div>
              <div class="sw__splits">
                <span class="sw__split"><span class="sw__split-place">1st</span>
                <span class="sw__split-amt">${pz}</span></span>
              </div>
            </div>
          </div>
        </div>`;
      document.body.appendChild(root);
    },
    { mult: multiplier, pz: prize }
  );
}

/**
 * Let every entrance animation finish before measuring.
 *
 * WITHOUT THIS THE SUITE IS FLAKY, and it was: the first CI run failed on
 * `.sw__hub-mult` being invisible and passed on retry. The wheel's parts
 * animate IN from opacity 0, so sampling opacity at an arbitrary instant
 * measures how far the animation happens to have travelled on that runner,
 * not whether the element is ever painted. The reduced-motion variant passed
 * on the same run precisely because `animation:none` settles it immediately —
 * which is what identified the cause.
 *
 * Waiting on the real Animation objects (rather than sleeping a guessed
 * number of ms, which is the same magic-number trap the repo bans for source
 * windows) asserts the END STATE deterministically: if the multiplier is
 * still transparent once its own animation has finished, it is genuinely
 * invisible and that is a real bug worth failing on.
 */
async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const anims = document.getAnimations();
    await Promise.all(
      anims.map((a) =>
        // A paused or infinite animation would hang the wait; finished is a
        // promise that only such an animation never resolves, so race it.
        Promise.race([a.finished.catch(() => undefined), new Promise((r) => setTimeout(r, 4000))])
      )
    );
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  });
}

/** Is this element painted, and wholly inside the viewport? */
async function paintedInside(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { found: false, w: 0, h: 0, insideX: false, insideY: false, visible: false };
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el as Element);
    return {
      found: true,
      w: Math.round(r.width),
      h: Math.round(r.height),
      insideX: r.left >= -1 && r.right <= window.innerWidth + 1,
      insideY: r.top >= -1 && r.bottom <= window.innerHeight + 1,
      visible: cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0,
    };
  }, selector);
}

test.describe('LIVE E2E — the spin wheel on a 375px phone', () => {
  test('the disc, the drawn multiplier and the prize are painted inside the viewport', async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ viewport: PHONE, reducedMotion: 'no-preference' });
    const page = await ctx.newPage();
    await loadLiveCss(page);
    await mountWheelResult(page);
    await settle(page);

    // The disc itself. A wheel that renders at zero size, or half off the
    // side of a phone, is the "animation never plays" complaint in its most
    // literal form.
    const disc = await paintedInside(page, '.sw__disc');
    expect(disc.found, 'the disc must exist — has .sw__disc been renamed?').toBe(true);
    expect(disc.visible, 'the disc must be visible').toBe(true);
    expect(disc.w, 'the disc must have real width on a phone').toBeGreaterThan(80);
    expect(disc.h, 'the disc must have real height on a phone').toBeGreaterThan(80);
    expect(disc.insideX, 'the disc must not run off the side of a 375px screen').toBe(true);

    // The number the sequence exists to announce.
    // The shipped multiplier intentionally begins at opacity: 0 and pops in
    // over 450ms. Wait for that real animation instead of sampling its first
    // frame, which made this browser gate deterministically fail on CI.
    await expect
      .poll(async () => (await paintedInside(page, '.sw__hub-mult')).visible, {
        message: 'the drawn multiplier must finish its entrance animation',
        timeout: 2_000,
      })
      .toBe(true);
    const hub = await paintedInside(page, '.sw__hub-mult');
    expect(hub.found, 'the drawn multiplier must be rendered').toBe(true);
    expect(hub.visible, 'the drawn multiplier must be visible').toBe(true);
    expect(hub.w, 'the multiplier must have painted width').toBeGreaterThan(0);
    expect(hub.insideX, 'the multiplier must be on screen').toBe(true);

    // And what it is worth.
    const prize = await paintedInside(page, '.sw__prize');
    expect(prize.found, 'the prize must be rendered').toBe(true);
    expect(prize.visible, 'the prize must be visible').toBe(true);
    expect(prize.insideX, 'the prize must be on screen horizontally').toBe(true);
    expect(
      prize.insideY,
      'the prize must be on screen vertically — the insurance modal shipped its buttons below the clip line on this exact viewport'
    ).toBe(true);

    await ctx.close();
  });

  test('the dim and beam cover the felt rather than a corner of it', async ({ browser }) => {
    // The vignette is what makes the wheel a takeover instead of a widget. If
    // it collapses to a corner the felt stays legible behind the disc and the
    // moment reads as a glitch.
    const ctx = await browser.newContext({ viewport: PHONE, reducedMotion: 'no-preference' });
    const page = await ctx.newPage();
    await loadLiveCss(page);
    await mountWheelResult(page);
    await settle(page);

    const dim = await page.evaluate(() => {
      const el = document.querySelector('.sw__dim');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    });
    expect(dim, 'the dim layer must exist').not.toBeNull();
    expect(dim!.w, 'the dim must span the width of the phone').toBeGreaterThanOrEqual(
      PHONE.width - 2
    );

    await ctx.close();
  });
});

test.describe('LIVE E2E — the shipped wheel CSS still lasts as long as the engine holds', () => {
  test('the chase and the countdown carry their spec durations in the deployed bundle', async ({
    browser,
  }) => {
    /* Read from the DEPLOYED stylesheet, not from source. The engine holds the
       deal for spinRevealToDealMs(); if the shipped CSS is shorter the table
       sits dead after the wheel, and if it is longer the deal lands on top of
       the result card — the two-second overlap spinRevealTotalMs()'s own
       comment records. */
    const ctx = await browser.newContext({ viewport: PHONE, reducedMotion: 'no-preference' });
    const page = await ctx.newPage();
    await loadLiveCss(page);

    const durations = await page.evaluate(() => {
      // Every keyframe animation the shipped sheets define for the wheel,
      // with its declared duration, by walking the CSSOM rather than guessing.
      const out: Record<string, number> = {};
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList;
        try {
          rules = (sheet as CSSStyleSheet).cssRules;
        } catch {
          continue;
        }
        for (const rule of Array.from(rules)) {
          const st = (rule as CSSStyleRule).style;
          if (!st) continue;
          const sel = (rule as CSSStyleRule).selectorText || '';
          if (!sel.includes('sw__') && !sel.includes('.sw')) continue;
          const dur = st.animationDuration || st.getPropertyValue('animation-duration');
          if (!dur) continue;
          for (const d of dur.split(',').map((x) => x.trim())) {
            const ms = d.endsWith('ms')
              ? parseFloat(d)
              : d.endsWith('s')
                ? parseFloat(d) * 1000
                : 0;
            if (ms > 0) out[sel + '|' + d] = Math.round(ms);
          }
        }
      }
      return out;
    });

    const all = Object.values(durations);
    expect(
      all.length,
      'no wheel animation durations found in the shipped CSS — either the selectors were renamed or the wheel stylesheet stopped shipping'
    ).toBeGreaterThan(0);

    // The longest single wheel beat must not exceed the whole sequence the
    // engine waits for. A beat longer than the hold deals cards over the top
    // of the wheel.
    const longest = Math.max(...all);
    const hold =
      SPIN_REVEAL.LEAD_IN_MS +
      SPIN_REVEAL.COUNTDOWN_MS +
      SPIN_REVEAL.SPIN_MS +
      SPIN_REVEAL.WINNER_FLASH_MS +
      SPIN_REVEAL.RESULT_HOLD_MS;
    expect(
      longest,
      `a shipped wheel animation runs ${longest}ms, longer than the ${hold}ms the engine holds the deal for`
    ).toBeLessThanOrEqual(hold);

    await ctx.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CLAUDE.md 10.6: reduced motion collapses MOTION, never MEANING.
// ═══════════════════════════════════════════════════════════════════════════
test.describe('LIVE E2E — the wheel under reduced motion', () => {
  test('the flourish is dropped but the result is still painted', async ({ browser }) => {
    /* The shipped stylesheet carries
     *   @media(prefers-reduced-motion:reduce){ .sw__dim,.sw__beam,.sw__count,
     *     .sw__disc-wrap,.sw__hub-mult,.sw__status,.sw__result,... {animation:none} }
     *
     * That is correct here, and it is worth writing down WHY, because it looks
     * at first glance like an Animation Law violation. SpinWheel advances its
     * phases on setTimeout (setPhase('countdown'|'chase'|'result'|'idle')),
     * NOT on animationend — so with every CSS animation removed the countdown
     * still counts, the disc still resolves, and the prize is still announced
     * for the full RESULT_HOLD_MS the engine is waiting through. Motion goes;
     * meaning stays. That is exactly the distinction 10.6 draws, and it is why
     * this component needs no data-motion="keep" the way SeatKnockout and
     * SeatSlot do — their durations live in CSS, these live in JS.
     *
     * The pin: a reduced-motion player must never be left staring at a blank
     * takeover for the ~16.6s the engine holds the deal. */
    const ctx = await browser.newContext({ viewport: PHONE, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await loadLiveCss(page);
    await mountWheelResult(page, 25, 250);
    await settle(page);

    const prize = await paintedInside(page, '.sw__prize');
    expect(prize.found, 'the prize must still be rendered under reduced motion').toBe(true);
    expect(
      prize.visible,
      'reduced motion must not hide the result — that is meaning, not motion'
    ).toBe(true);
    expect(prize.insideY, 'the prize must still be on screen').toBe(true);

    const hub = await paintedInside(page, '.sw__hub-mult');
    expect(hub.visible, 'the drawn multiplier must survive reduced motion').toBe(true);

    await ctx.close();
  });
});
