/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE RIVER SQUEEZE, DRIVEN BY A REAL POINTER (2026-09-05)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-05: "NOTHING WORKS FOR THE SQUEEZE ON THE RIVER. DO NOT CLAIM
 * SUCCESS AGAIN UNTIL YOU'VE VERIFIED IT WORKS."
 *
 * He was right, and the reason nothing caught it is written into this file's
 * existence. The squeeze had two kinds of coverage and neither could see a
 * browser:
 *
 *   - the component tests run in happy-dom, which has no layout, no real CSS
 *     cascade and no pointer capture. They proved the ATTRIBUTES were set.
 *   - tests/e2e/card-squeeze-mobile.spec.ts runs in chromium but mounts
 *     HAND-WRITTEN markup, so it proved the STYLESHEET was sane against a
 *     div that the real component never produced.
 *
 * Nothing rendered the real component in a real browser and pushed a real
 * mouse across it. This does, through the /sim route's `?squeeze=1` knob.
 *
 * It asserts the whole chain, in the order a player experiences it:
 *   1. the river card is HELD FACE DOWN (rotateY ~0), not face up
 *   2. it is the interactive host, and it accepts pointer events
 *   3. dragging turns it - the transform actually changes under the mouse
 *   4. releasing past the threshold OPENS it (face up, rotateY 180)
 *   5. a short drag springs it back face down
 *   6. left alone, it opens itself before the next street could land
 *
 * Run:
 *   npm run build:ci
 *   npx http-server dist -p 4178 --silent &
 *   ARENA_BASE_URL=http://localhost:4178 npx playwright test \
 *     tests/e2e/river-squeeze-interactive.spec.ts --project=chromium
 */
import { test, expect, type Page } from '@playwright/test';

/* BASE_URL is what playwright.config.ts and the CI job actually set; this file
   read only ARENA_BASE_URL, so in the "Live Production E2E" job it fell through
   to localhost:4178 - a port nothing listens on there - and all 16 specs failed
   with ERR_CONNECTION_REFUSED on EVERY run of main from 2026-09-04. That job
   exists to answer "is main green" and it had been answering "no" about itself.
   /sim is a real route (src/App.tsx) and serves 200 in production, so honouring
   BASE_URL turns sixteen self-inflicted reds into real production coverage.
   Trailing slash stripped because every use below appends an absolute path. */
const RAW = process.env.ARENA_BASE_URL || process.env.BASE_URL || 'http://localhost:4178';
const BASE = RAW.replace(/\/+$/, '');
const HOST = '.card-squeeze-host';

function rotationYFromTransform(transform: string | null): number {
  if (transform === null) return NaN;
  if (!transform || transform === 'none') return 0;
  /* Parse INSIDE the parentheses. `matrix3d(...)` carries a digit in its
     own name, so a naive match over the whole string picks up the "3" and
     every index is off by one - which reported a real 27deg rotation as
     0deg and sent a chase after a bug that was not there. */
  const inside = transform.slice(transform.indexOf('(') + 1, transform.lastIndexOf(')'));
  const nums = inside.split(',').map((n) => Number(n.trim()));
  if (transform.startsWith('matrix3d') && nums.length === 16) {
    // rotateY: m11 = cos(theta), m13 = -sin(theta) in column-major matrix3d
    return Math.round((Math.atan2(-nums[2], nums[0]) * 180) / Math.PI);
  }
  if (nums.length === 6) return Math.round((Math.atan2(nums[1], nums[0]) * 180) / Math.PI);
  return 0;
}

/** rotateY in degrees from the live computed matrix3d/matrix of an element. */
async function rotationY(page: Page, selector: string): Promise<number> {
  const transform = await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    return el ? getComputedStyle(el).transform : null;
  }, selector);
  return rotationYFromTransform(transform);
}

/** Step the sim to the river of scenario 2 with the squeeze presented. */
async function openRiver(
  page: Page,
  opts: { watchHolds?: boolean; reduce?: boolean; manualClock?: boolean } = {}
) {
  const { watchHolds = false, reduce = false, manualClock = false } = opts;
  if (manualClock) await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  /* Emulated HERE rather than through `test.use`, which did not reliably
     reach the page in this project's config: the reduce run intermittently
     resolved the `all-in` profile, i.e. the test was not testing what it
     said. emulateMedia before the first navigation is unambiguous. */
  if (reduce) await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${BASE}/sim/?squeeze=1`, { waitUntil: 'domcontentloaded' });
  // Scenario 2 is the turn -> river street advance.
  const select = page.locator('select').first();
  await select.waitFor({ state: 'visible', timeout: 20000 });
  await select.selectOption({ index: 1 });
  // Walk to the step whose board holds four cards (the turn), then advance
  // one more so the river is genuinely a NEWLY DEALT fifth card.
  const next = page.getByRole('button', { name: /next/i }).first();
  for (let i = 0; i < 12; i++) {
    const count = await page.locator('.community-cards__card').count();
    if (count === 4) break;
    await next.click();
    await page.waitForTimeout(120);
  }
  expect(await page.locator('.community-cards__card').count(), 'the turn is on the felt').toBe(4);
  // Record every data-rs-hold transition from the moment the river mounts.
  // The auto-open is only on screen for ~350ms before the mount window
  // closes, which a polling assertion loses; an observer cannot miss it.
  // OPT-IN: observing the whole body's attributes is enough main-thread work
  // to move the presentation's own timings, so only the test that needs it
  // pays for it.
  if (watchHolds)
    await page.evaluate(() => {
      (window as unknown as { __holds: string[] }).__holds = [];
      const w = window as unknown as { __holds: string[]; __obs?: MutationObserver };
      w.__obs?.disconnect();
      w.__obs = new MutationObserver(() => {
        const h = document.querySelector('.card-squeeze-host');
        const v = h?.getAttribute('data-rs-hold') ?? 'none';
        if (w.__holds[w.__holds.length - 1] !== v) w.__holds.push(v);
      });
      w.__obs.observe(document.body, { subtree: true, childList: true, attributes: true });
    });
  // Pause before the river exists. Pointer work on a busy CI runner must
  // not consume the separate automatic-reveal deadline during a drag test.
  if (manualClock) await page.clock.pauseAt(new Date('2026-01-01T01:00:00Z'));
  await next.click();
  // The squeeze is the player's only once the hold has committed. Waiting on
  // it (rather than on the host merely existing) is what stops a pointerdown
  // landing before React has attached the handlers.
  await page.locator(`${HOST}[data-rs-hold="drag"]`).waitFor({ state: 'attached', timeout: 4000 });
  /* Let the card finish materialising before touching it.
     MEASURED 2026-09-05, ten runs: a press dispatched in the card's first
     ~100ms - while the host is still running ccCardMaterialize - lands about
     one time in three; from 150ms on it landed 7 times out of 7. That window
     is not one a player can act in (the card then holds for 2.25 SECONDS and
     a human reaction is ~200ms), so it is a robot-only race and this wait is
     the test behaving like a person rather than a defect being hidden. It is
     recorded in the changelog as a known window, not swept up. */
  if (manualClock) await page.clock.runFor(200);
  await page.waitForTimeout(200);
}

/**
 * THE DEFECT DAN REPORTED (2026-09-05), pinned in the browser that showed it.
 *
 * With Reduce Motion on - a switch a great many phones carry - the river used
 * to resolve the `reduced` profile: no hold, no `data-rs-hold`, the card
 * already face up. There was nothing on the felt to squeeze, which is exactly
 * "NOTHING WORKS FOR THE SQUEEZE ON THE RIVER". Nothing could see it: the
 * component tests run in happy-dom (no media queries, no cascade) and the
 * other e2e spec drove hand-written markup.
 */
test.describe('with Reduce Motion on, the perk survives - only the motion collapses', () => {
  test('the river still holds face down and still opens under the finger', async ({ page }) => {
    // Freeze the independent auto-open ceiling while Playwright is driving
    // the gesture. A saturated CI runner can otherwise spend the whole 2.55s
    // allowance between mouse steps and remove the host mid-drag. The real
    // ceiling remains covered by the dedicated "left alone" test below.
    await openRiver(page, { reduce: true, manualClock: true });
    const host = page.locator(HOST);
    /* ONE evaluate per reading. The card opens itself at the ceiling and the
       host unmounts ~400ms later, so a chain of polling assertions can spend
       the whole window and then report "element not found" - which is what a
       loaded machine did to an earlier version of this test. */
    const faces = async () =>
      page.evaluate(() => {
        const h = document.querySelector('.card-squeeze-host');
        if (!h) return { gone: true, front: -1, back: -1, hold: 'none', profile: 'none' };
        return {
          gone: false,
          front: Number(getComputedStyle(h.querySelector('.card-squeeze__face--front')!).opacity),
          back: Number(getComputedStyle(h.querySelector('.card-squeeze__face--back')!).opacity),
          hold: h.getAttribute('data-rs-hold') ?? 'none',
          profile: h.getAttribute('data-rs-profile') ?? 'none',
        };
      });
    const start = await faces();
    expect(start.gone, 'the card is still on the felt').toBe(false);
    expect(start.hold, 'a viewer with Reduce Motion still gets the hold').toBe('drag');
    expect(start.profile).toBe('all-in-reduced');
    expect(start.front, 'face down: the front is not showing').toBeLessThan(0.05);
    expect(start.back, 'face down: the back is').toBeGreaterThan(0.9);

    const box = (await host.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + box.width * 0.5, cy, { steps: 6 });
    const mid = await faces();
    expect(mid.front, 'it opens under the finger, by fading not turning').toBeGreaterThan(0.15);
    expect(mid.back).toBeLessThan(0.9);

    await page.mouse.move(cx + box.width * 1.2, cy, { steps: 6 });
    await page.mouse.up();
    // CSS animations use the compositor clock, while the independent JS
    // auto-open deadline remains paused by the test clock.
    await page.waitForTimeout(450);
    const end = await faces();
    expect(end.gone || end.front > 0.9, `face up after release (${JSON.stringify(end)})`).toBe(
      true
    );
  });

  test('the motion IS collapsed: it never rotates', async ({ page }) => {
    await openRiver(page, { reduce: true });
    const rotated = await page.evaluate(() => {
      const t = getComputedStyle(document.querySelector('.card-squeeze')!).transform;
      return t.startsWith('matrix3d');
    });
    expect(rotated, 'no 3D turn under Reduce Motion').toBe(false);
  });
});

test.describe('the river squeeze, with a real mouse', () => {
  test('holds the river FACE DOWN under an interactive host', async ({ page }) => {
    await openRiver(page);
    const host = page.locator(HOST);
    await expect(host, 'the river must mount the squeeze host').toHaveCount(1, { timeout: 4000 });
    await expect(host).toHaveAttribute('data-rs-hold', 'drag');
    await expect(host).toHaveAttribute('data-rs-profile', 'all-in');
    // Face DOWN: the two-surface box sits at rotateY(0) while it is the
    // player's. 180 here would mean the card is already face up.
    const deg = await rotationY(page, `${HOST} .card-squeeze`);
    expect(Math.abs(deg), `held face down, got rotateY ${deg}deg`).toBeLessThan(15);
    // And nothing is covering it: the point that would be dragged must
    // actually hit the card.
    const box = (await host.boundingBox())!;
    const hit = await page.evaluate(
      ([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return el
          ? el.closest('.card-squeeze-host')
            ? 'card'
            : el.className || el.tagName
          : 'none';
      },
      [box.x + box.width / 2, box.y + box.height / 2]
    );
    expect(hit, 'a pointer at the centre of the card must reach the card').toBe('card');
  });

  test('a drag turns it, and letting go past the threshold opens it', async ({ page }) => {
    // Keep the server-paced ceiling from racing the deliberately stepped
    // synthetic pointer. Automatic opening is verified separately below.
    await openRiver(page, { manualClock: true });
    const host = page.locator(HOST);
    await expect(host).toHaveCount(1, { timeout: 4000 });
    const box = (await host.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + box.width * 0.3, cy, { steps: 6 });
    const mid = await rotationY(page, `${HOST} .card-squeeze`);
    expect(
      Math.abs(mid),
      `a third of a card of travel must turn it, got ${mid}deg`
    ).toBeGreaterThan(10);
    // Past the release threshold and let go: it opens the rest of the way.
    await page.mouse.move(cx + box.width * 1.1, cy, { steps: 8 });
    await page.mouse.up();
    await expect(host).toHaveAttribute('data-rs-hold', 'released', { timeout: 2000 });
    await page.waitForTimeout(700);
    const end = await page.evaluate((selector) => {
      const card = document.querySelector(selector) as HTMLElement | null;
      const board = document.querySelectorAll('.community-cards__card');
      const river = board.item(board.length - 1);
      return {
        gone: card === null,
        settledRiver: board.length === 5,
        settledRiverFaceUp:
          river !== null &&
          river.querySelector('.card-squeeze') === null &&
          river.querySelector('.card-image:not(.card-image--back)') !== null,
        transform: card ? getComputedStyle(card).transform : null,
      };
    }, `${HOST} .card-squeeze`);
    const endRotation = rotationYFromTransform(end.transform);
    const openedBeforeUnmount =
      Number.isFinite(endRotation) && Math.abs(Math.abs(endRotation) - 180) < 15;
    expect(
      openedBeforeUnmount || (end.gone && end.settledRiver && end.settledRiverFaceUp),
      `released river did not settle face up (${JSON.stringify({ ...end, endRotation })})`
    ).toBe(true);
  });

  test('a short drag springs it back face down', async ({ page }) => {
    await openRiver(page, { manualClock: true });
    const host = page.locator(HOST);
    await expect(host).toHaveCount(1, { timeout: 4000 });
    const box = (await host.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + box.width * 0.15, cy, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    await expect(host).toHaveAttribute('data-rs-hold', 'drag');
    const deg = await rotationY(page, `${HOST} .card-squeeze`);
    expect(Math.abs(deg), `sprung back face down, got ${deg}deg`).toBeLessThan(15);
  });

  test('left alone it opens itself, before the next street could land', async ({ page }) => {
    await openRiver(page, { watchHolds: true });
    // The ceiling is 2550ms at speed 1 and the engine's next street cannot
    // land before 2950ms, so by 3s the card must have opened ON ITS OWN and
    // the board must be showing five settled cards.
    await page.waitForTimeout(3000);
    const holds = await page.evaluate(() => (window as unknown as { __holds: string[] }).__holds);
    expect(holds, `hold transitions were ${JSON.stringify(holds)}`).toContain('released');
    expect(await page.locator('.community-cards__card').count()).toBe(5);
  });
});
