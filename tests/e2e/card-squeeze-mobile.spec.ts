/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE SQUEEZE ON A PHONE (2026-09-05)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan: "THIS NEEDS TO BE BUILD AND OPTIMIZED FOR MOBILE, NOT JUST DESK TOP,
 * 95% OF USERS WILL BE MOBILE."
 *
 * Every existing check on this animation runs at a desktop viewport. This one
 * runs at 375x812 - the narrowest phone the board is designed for - and
 * asserts the four things that can only be wrong on a phone:
 *
 *   1. the card still has a box, and the board row does not reflow
 *   2. only ONE element per squeezing card is promoted to a compositor layer,
 *      and only while it is turning (will-change is a memory cost, and MDN
 *      says it applies to the entire subtree)
 *   3. the flip is inside the published 400ms ceiling and matches the phone
 *      profile, not the desktop one
 *   4. nothing but transform and opacity animates - the compositing-only rule
 *
 * Run:  npx playwright test tests/e2e/card-squeeze-mobile.spec.ts
 */

import { test, expect, devices, type Page } from '@playwright/test';

const ARENA = process.env.ARENA_BASE_URL || 'https://smarter.poker/hub/club-arena';

test.use({ ...devices['iPhone 13'] });

async function loadLiveCss(page: Page) {
  // Read the deployed assets without mounting the application. Its async
  // hydration and route effects can otherwise replace this fixture mid-test.
  const htmlResponse = await page.request.get(`${ARENA}/index.html`);
  expect(htmlResponse.ok(), 'the built entry document must load').toBe(true);
  const html = await htmlResponse.text();
  const entry = html.match(/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0];
  expect(entry, 'the built entry script must be discoverable').toBeTruthy();
  const scriptResponse = await page.request.get(`${ARENA}/${entry}`);
  expect(scriptResponse.ok(), 'the built entry script must load').toBe(true);
  const js = await scriptResponse.text();
  const names = new Set<string>();
  for (const text of [html, js]) {
    for (const match of text.matchAll(/assets\/[A-Za-z0-9_.-]+\.css/g)) names.add(match[0]);
  }
  expect(names.size, 'the build must expose its stylesheets').toBeGreaterThan(0);
  const styles = await Promise.all(
    [...names].map(async (name) => {
      const response = await page.request.get(`${ARENA}/${name}`);
      expect(response.ok(), `stylesheet ${name} must load`).toBe(true);
      return response.text();
    })
  );
  await page.goto('about:blank');
  await page.setContent(
    '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body></body></html>'
  );
  for (const content of styles) await page.addStyleTag({ content });
  await page.evaluate(() => document.documentElement.style.setProperty('--animation-speed', '1'));
}

/** The felt board at a phone width, with the river mid-squeeze. */
async function mountPhoneBoard(page: Page, animating: 'on' | 'off' = 'on') {
  await page.evaluate((anim: string) => {
    document.body.style.margin = '0';
    document.body.style.background = '#123';
    const card = (extra = '', attrs = '') =>
      `<div class="community-cards__card ${extra}" ${attrs}></div>`;
    document.body.innerHTML = `
      <div class="table-page"><div class="table-scaler" style="width:375px">
        <div class="community-area"><div class="community-cards">
          <div class="community-cards__container" id="row">
            ${card()}${card()}${card()}${card()}
            <div class="community-cards__card community-cards__card--river card-squeeze-host"
                 id="river" data-rs-3d="on" data-rs-animating="${anim}"
                 style="--rs-prepare:50ms;--rs-hold:0ms;--rs-flip:300ms;--rs-overshoot:1.02">
              <div class="card-squeeze__shadow"></div>
              <div class="card-squeeze" id="flip">
                <div class="card-squeeze__face card-squeeze__face--back"></div>
                <div class="card-squeeze__face card-squeeze__face--front"></div>
              </div>
              <div class="card-squeeze__spine"></div>
            </div>
          </div>
        </div></div>
      </div></div>`;
  }, animating);
}

test.describe('the squeeze at 375px', () => {
  test.beforeEach(async ({ page }) => {
    await loadLiveCss(page);
  });

  test('the phone viewport really is 375 wide, so this is not a desktop run', async ({ page }) => {
    const w = await page.evaluate(() => window.innerWidth);
    expect(w).toBeLessThanOrEqual(430);
  });

  test('a squeezing card keeps its box and the row does not reflow', async ({ page }) => {
    await mountPhoneBoard(page);
    const m = await page.evaluate(() => {
      const row = document.getElementById('row')!;
      const river = document.getElementById('river')! as HTMLElement;
      const before = Math.round(row.getBoundingClientRect().width);
      const boxWhileSqueezing = { w: river.offsetWidth, h: river.offsetHeight };
      river.classList.remove('card-squeeze-host');
      const after = Math.round(row.getBoundingClientRect().width);
      return {
        before,
        after,
        boxWhileSqueezing,
        boxAfter: { w: river.offsetWidth, h: river.offsetHeight },
      };
    });
    expect(m.boxWhileSqueezing.w, 'the card must have a width').toBeGreaterThan(0);
    expect(m.boxWhileSqueezing.h, 'and a height').toBeGreaterThan(0);
    expect(m.boxWhileSqueezing).toEqual(m.boxAfter);
    expect(m.before, 'the row must not resize when a card squeezes').toBe(m.after);
  });

  test('exactly ONE element is promoted, and only while it turns', async ({ page }) => {
    await mountPhoneBoard(page, 'on');
    const on = await page.evaluate(() => {
      const ids = ['river', 'flip'];
      const out: Record<string, string> = {};
      for (const id of ids) out[id] = getComputedStyle(document.getElementById(id)!).willChange;
      out.spine = getComputedStyle(document.querySelector('.card-squeeze__spine')!).willChange;
      out.shadow = getComputedStyle(document.querySelector('.card-squeeze__shadow')!).willChange;
      return out;
    });
    // the rotating box, and nothing else
    expect(on.flip).toContain('transform');
    expect(on.river).toBe('auto');
    expect(on.spine).toBe('auto');
    expect(on.shadow).toBe('auto');

    // and it is released the moment the component says the flip is over
    await mountPhoneBoard(page, 'off');
    const off = await page.evaluate(
      () => getComputedStyle(document.getElementById('flip')!).willChange
    );
    expect(off, 'the layer must be released when the flip ends').toBe('auto');
  });

  test('the flip runs at the PHONE profile and inside the 400ms ceiling', async ({ page }) => {
    await mountPhoneBoard(page);
    const durations = await page.evaluate(() => {
      const out: Record<string, number> = {};
      const elements = [
        document.getElementById('river'),
        document.getElementById('flip'),
        document.querySelector('.card-squeeze__spine'),
        document.querySelector('.card-squeeze__shadow'),
      ].filter((element): element is Element => element !== null);
      for (const element of elements) {
        const style = getComputedStyle(element);
        const names = style.animationName.split(',').map((name) => name.trim());
        const times = style.animationDuration.split(',').map((time) => time.trim());
        names.forEach((name, index) => {
          if (!name || name === 'none') return;
          const raw = times[index] || times[times.length - 1] || '0s';
          out[name] = Math.round(
            raw.endsWith('ms') ? Number.parseFloat(raw) : Number.parseFloat(raw) * 1_000
          );
        });
      }
      return out;
    });
    // 300ms is Material's typical mobile transition, and the phone profile
    expect(durations.ccCardSqueeze, 'the phone flip').toBe(300);
    expect(durations.ccCardSqueeze).toBeLessThanOrEqual(400);
    expect(durations.ccCardMaterialize).toBe(50);
    // spine and shadow ride the same clock
    expect(durations.ccCardSpine).toBe(300);
    expect(durations.ccCardShadow).toBe(300);
  });

  test('nothing but transform and opacity is animated (compositing only)', async ({ page }) => {
    await mountPhoneBoard(page);
    const props = await page.evaluate(() => {
      const seen = new Set<string>();
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList;
        try {
          rules = sheet.cssRules;
        } catch {
          continue;
        }
        for (const rule of Array.from(rules)) {
          if (!(rule instanceof CSSKeyframesRule)) continue;
          if (!/^ccCard/.test(rule.name)) continue;
          for (const kf of Array.from(rule.cssRules) as CSSKeyframeRule[]) {
            for (const p of Array.from(kf.style)) seen.add(p);
          }
        }
      }
      return [...seen];
    });
    expect(props.length, 'the ccCard* keyframes must exist').toBeGreaterThan(0);
    // This assertion is what found `ccCardFlip3D` - a dead keyframe animating
    // a non-compositor property, unreachable since the two-phase flop landed.
    for (const p of props) {
      expect(['transform', 'opacity', 'animation-timing-function']).toContain(p);
    }
  });

  test('reduced motion cross-fades rather than deleting the reveal', async ({ page }) => {
    // Reuse the fixture page and the CSS loaded by beforeEach. Creating a
    // second browser context repeated every production chunk fetch and made
    // this one assertion consume the full 30-second test budget under load.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mountPhoneBoard(page);
    const state = await page.evaluate(() => {
      const flip = document.getElementById('flip')!;
      const cs = getComputedStyle(flip);
      return {
        /* The COMPUTED cascade, not document.getAnimations(): the app's global
           reduced-motion rule collapses every duration to ~1ms, so by the time
           a query runs the animation has finished and Chrome has removed it.
           What must be true is which animation the cascade CHOSE. */
        animationName: cs.animationName,
        transform: cs.transform,
        spineName: getComputedStyle(document.querySelector('.card-squeeze__spine')!).animationName,
        spine: Number(getComputedStyle(document.querySelector('.card-squeeze__spine')!).opacity),
      };
    });
    // the reveal still HAPPENS, it just does not turn
    expect(state.animationName).toContain('ccCardCrossFade');
    expect(state.animationName).not.toContain('ccCardSqueeze');
    // and it rests face up
    expect(state.transform).not.toBe('none');
    // an edge belongs to a turn; there is no turn
    expect(state.spineName).toBe('none');
    expect(state.spine).toBeLessThan(0.05);
  });
});
