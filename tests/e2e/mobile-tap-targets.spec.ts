/**
 * TAP TARGETS — a thumb has to be able to hit it (2026-08-23).
 *
 * Apple's guidance is a 44pt minimum; measured in production at 375px, 27
 * controls were under it, the worst an 18px-tall "View All". Small controls
 * are not a cosmetic complaint: a 20px chip in a horizontal row is a coin
 * flip between two adjacent filters.
 *
 * WHAT IS MEASURED, AND WHY IT IS NOT THE ELEMENT BOX
 *
 * The fix deliberately did NOT resize these controls — a 20px range tab
 * becoming 44px is a redesign, not a repair. Each keeps its painted size and
 * gains an invisible 44px-tall `::after` hit area, because a click on a
 * pseudo-element is dispatched to its host. So the element's own rect still
 * reads 20px and always will; asserting on it would fail forever and teach
 * everyone to ignore this spec.
 *
 * What actually decides whether a thumb lands is which element is on top at a
 * point, so that is what this asks: probe points on a 44px vertical span
 * centred on each control and require `elementFromPoint` to resolve back to
 * that control. That is true whether the target is genuinely 44px tall or is
 * 20px with an expanded hit area — it tests the behaviour, not the technique,
 * and it stays honest if someone later swaps one for the other.
 *
 * `pointer: coarse` is emulated (hasTouch), because the expansion is scoped
 * to touch devices on purpose: a mouse does not need it and an invisible 44px
 * box around every chip would start stealing clicks on desktop.
 */
import { test, expect } from '@playwright/test';

const CLUB = process.env.AUDIT_CLUB_ID || 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';

const ROUTES = ['profile', 'friends', 'wallet', 'settings', 'hand-history', `clubs/${CLUB}`];

/** Apple HIG minimum, in CSS px. */
const MIN = 44;

/** How far above and below centre a thumb should still land on the control. */
const REACH = MIN / 2 - 2; // 20px each way, 2px of slack for sub-pixel layout

interface Miss {
  route: string;
  sel: string;
  text: string;
  boxH: number;
  reachablePx: number;
}

test.use({ hasTouch: true, isMobile: true });

test('every control answers to a thumb at 375px', async ({ page }) => {
  test.setTimeout(ROUTES.length * 15_000 + 60_000);
  await page.setViewportSize({ width: 375, height: 812 });

  const misses: Miss[] = [];
  const skipped: string[] = [];
  let checked = 0;

  for (const route of ROUTES) {
    try {
      await page.goto(route, { waitUntil: 'domcontentloaded' });
    } catch (err) {
      if (!String(err).includes('ERR_ABORTED')) {
        skipped.push(`${route}: navigation failed`);
        continue;
      }
    }
    await page.waitForTimeout(2600);
    if (page.url().includes('/auth')) {
      skipped.push(route);
      continue;
    }

    const found = await page.evaluate(
      ({ REACH }) => {
        const root = document.querySelector('#main-content') || document.body;
        const out: Array<{ sel: string; text: string; boxH: number; reachablePx: number }> = [];
        const unmeasured: string[] = [];
        let n = 0;

        for (const el of root.querySelectorAll('button, a[href], [role="button"]')) {
          const s = getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) continue;
          // Controls inside a fixed layer are chrome (nav bars, parked drawers).
          let p: Element | null = el;
          let inFixed = false;
          while (p && p !== root) {
            if (getComputedStyle(p).position === 'fixed') {
              inFixed = true;
              break;
            }
            p = p.parentElement;
          }
          if (inFixed) continue;

          const b = el.getBoundingClientRect();
          if (b.width === 0 || b.height === 0) continue;
          // Must be on screen to be probed at all.
          if (b.bottom <= 0 || b.top >= window.innerHeight) continue;
          if (b.right <= 0 || b.left >= window.innerWidth) continue;

          const cx = b.left + b.width / 2;
          const cy = b.top + b.height / 2;

          /* A control has to be far enough inside the viewport for the whole
             44px band to be probed, or the measurement is meaningless: this
             walks outward from the centre and `document.elementFromPoint`
             returns null for any y outside the viewport, which reads exactly
             like a control buried under an overlay.

             That is not a hypothetical. On 2026-08-25 the live audit reported
             `hand-history: button.replay-btn box 44px, reachable 0px` - a
             button that already carries `min-height: 44px` and is perfectly
             hittable. Measured on production: its box was at y=798 in an
             812px viewport, so its centre sat at y=820, off the bottom edge,
             and the very first probe came back null. It was the last row of a
             scrolling list; scroll down and it is a 44px target like any
             other.

             So say so instead of accusing it. A control the sweep could not
             measure is recorded and excluded - never counted as a pass, and
             never reported as a miss. */
          if (cy - REACH < 1 || cy + REACH > window.innerHeight - 1) {
            unmeasured.push(
              el.tagName.toLowerCase() +
                (el.className ? '.' + String(el.className).split(' ')[0].slice(0, 26) : '') +
                ' (centre off-screen, not probed)'
            );
            continue;
          }

          n += 1;

          /* Walk outward from the centre and find how far the control still
             wins the hit test. Stop at the first point it loses. */
          let reach = 0;
          for (let d = 0; d <= REACH; d += 4) {
            const up = document.elementFromPoint(cx, Math.max(1, cy - d));
            const down = document.elementFromPoint(cx, Math.min(window.innerHeight - 1, cy + d));
            const owns = (t: Element | null) =>
              !!t && (t === el || el.contains(t) || t.contains(el));
            if (!owns(up) || !owns(down)) break;
            reach = d;
          }
          const reachablePx = reach * 2;
          if (reachablePx < REACH * 2) {
            out.push({
              sel:
                el.tagName.toLowerCase() +
                (el.className ? '.' + String(el.className).split(' ')[0].slice(0, 26) : ''),
              text: (el.textContent || '').trim().slice(0, 24).replace(/\s+/g, ' '),
              boxH: Math.round(b.height),
              reachablePx,
            });
          }
        }
        return { out, n, unmeasured };
      },
      { REACH }
    );

    checked += found.n;
    for (const u of found.unmeasured) skipped.push(`${route}: ${u}`);
    for (const f of found.out) misses.push({ route, ...f });
  }

  console.log('MOBILE_TAP_TARGETS ' + JSON.stringify({ misses, skipped, checked }, null, 1));

  /* An empty sweep proves nothing — this suite has been fooled that way before. */
  expect(
    checked,
    'no controls were found on any route — the sweep asserted nothing'
  ).toBeGreaterThan(0);

  if (process.env.MOBILE_FIT_STRICT || process.env.CI) {
    expect(
      misses,
      `Controls a thumb cannot reliably hit at 375px (need ${MIN}px of vertical reach):\n${misses
        .map(
          (m) => `  ${m.route}: ${m.sel} "${m.text}" box ${m.boxH}px, reachable ${m.reachablePx}px`
        )
        .join('\n')}`
    ).toEqual([]);
  }
});
