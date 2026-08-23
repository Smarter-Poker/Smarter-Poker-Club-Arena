/**
 * NO TAP MAY ZOOM THE PAGE (2026-08-23).
 *
 * iOS Safari zooms the entire viewport when a text field is focused whose
 * computed font-size is under 16px, and it does not zoom back out on blur.
 * The user is left on a panned, oversized page — indistinguishable from the
 * app breaking. 16px is the exact threshold.
 *
 * CORRECTION 2026-08-23: an earlier version of this comment said the viewport
 * carries no `maximum-scale`. That was the World Hub's `_app.js` viewport, not
 * this app's. Club Arena's own index.html declares
 * `maximum-scale=1.0, user-scalable=no`, which suppresses the symptom AND
 * takes pinch-zoom away from people who need it (WCAG 1.4.4).
 *
 * That makes this spec more useful, not less: the zoom lock is the only thing
 * standing between an undersized field and a broken-looking page, and it is a
 * lock worth removing. It cannot be removed safely until every field is at
 * least 16px — which is what this asserts. Keep it green and the lock becomes
 * a free win rather than a load-bearing workaround.
 *
 * Headless Chromium does not emulate the iOS zoom itself, so this asserts the
 * measurable cause rather than the symptom: at 375px, every focusable text
 * field computes to at least 16px.
 */
import { test, expect } from '@playwright/test';

const CLUB = process.env.AUDIT_CLUB_ID || 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';

/* Routes chosen because each one puts a text field in front of the user. */
const ROUTES = [
  'friends',
  'search',
  'settings',
  `clubs/${CLUB}/members`,
  `clubs/${CLUB}/create-table`,
  `clubs/${CLUB}/settings`,
];

/** The iOS threshold, exactly. */
const MIN_PX = 16;

interface Small {
  route: string;
  sel: string;
  fontPx: number;
  type: string;
}

test('no text field is small enough to make iOS zoom the page', async ({ page }) => {
  test.setTimeout(ROUTES.length * 15_000 + 60_000);
  await page.setViewportSize({ width: 375, height: 812 });

  const small: Small[] = [];
  const skipped: string[] = [];
  let fieldsChecked = 0;

  for (const route of ROUTES) {
    try {
      await page.goto(route, { waitUntil: 'domcontentloaded' });
    } catch (err) {
      if (!String(err).includes('ERR_ABORTED')) {
        skipped.push(`${route}: navigation failed`);
        continue;
      }
    }
    await page.waitForTimeout(2400);
    if (page.url().includes('/auth')) {
      skipped.push(route);
      continue;
    }

    const found = await page.evaluate((MIN_PX) => {
      /* Only the field types iOS actually zooms for. checkbox/radio/range
         carry no text and do not trigger it. */
      const ZOOMABLE = new Set([
        'text',
        'search',
        'number',
        'email',
        'password',
        'tel',
        'url',
        'date',
        'datetime-local',
        'month',
        'time',
        'week',
        '',
      ]);
      const out: Array<{ sel: string; fontPx: number; type: string }> = [];
      let n = 0;
      for (const el of document.querySelectorAll('input, textarea, select')) {
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') continue;
        const type = (el as HTMLInputElement).type?.toLowerCase() ?? '';
        if (el.tagName === 'INPUT' && !ZOOMABLE.has(type)) continue;
        const fontPx = parseFloat(s.fontSize);
        if (!Number.isFinite(fontPx)) continue;
        n += 1;
        if (fontPx < MIN_PX - 0.01) {
          out.push({
            sel:
              el.tagName.toLowerCase() +
              (el.className ? '.' + String(el.className).split(' ')[0].slice(0, 26) : ''),
            fontPx: Math.round(fontPx * 10) / 10,
            type,
          });
        }
      }
      return { out, n };
    }, MIN_PX);

    fieldsChecked += found.n;
    for (const f of found.out) small.push({ route, ...f });
  }

  console.log('MOBILE_INPUT_ZOOM ' + JSON.stringify({ small, skipped, fieldsChecked }, null, 1));

  /* If the sweep found no fields at all it proved nothing — say so rather
     than passing an empty assertion, the failure mode this suite has had
     twice before. */
  expect(
    fieldsChecked,
    'no text fields were found on any route — the sweep asserted nothing'
  ).toBeGreaterThan(0);

  if (process.env.MOBILE_FIT_STRICT || process.env.CI) {
    expect(
      small,
      `Fields under ${MIN_PX}px at 375px — focusing these zooms iOS and never unzooms:\n${small
        .map((s) => `  ${s.route}: ${s.sel} [${s.type}] ${s.fontPx}px`)
        .join('\n')}`
    ).toEqual([]);
  }
});
