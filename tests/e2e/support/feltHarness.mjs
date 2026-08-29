/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE FELT HARNESS — one definition, two consumers
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The felt's width is not a property anyone declares. `.table-scaler` derives it
 * from the vertical space left over, through six custom properties and four
 * breakpoints, and everything on the felt is now a fraction of the result. The
 * only honest way to know what a 768px tablet gets is to lay it out in a browser
 * at 768px and read it back.
 *
 * This module builds that layout — the REAL stylesheets in the REAL nesting —
 * and is shared by the two things that need it:
 *
 *   tests/e2e/table-proportions.spec.ts   the CI guard  (is it still flat?)
 *   scripts/dev/measure-felt.mjs          the dev tool  (what are the numbers?)
 *
 * It is one file because two copies of a measurement harness that are supposed
 * to agree will not. This whole pass was about deleting duplicated numbers; it
 * would be a poor joke to introduce a second copy of the thing that measures
 * them. Plain .mjs rather than .ts because a Playwright spec and a node script
 * can both import it as-is, and `tsconfig.json` only covers `src`.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Every stylesheet contributing to the felt's geometry or to what sits on it,
 *  in cascade order. @import lines are stripped because the imported file is
 *  concatenated here instead — a bare @import inside setContent would 404. */
export const SHEETS = [
  'src/styles/design-tokens.css',
  'src/pages/TablePage.css',
  'src/components/table/ActionPanel.css',
  'src/components/table/SeatSlot.css',
  'src/components/table/TableVisualHotfix.css',
];

export const buildCss = (root) =>
  SHEETS.map((f) => readFileSync(resolve(root, f), 'utf8'))
    .join('\n')
    .replace(/@import\s+[^;]+;/g, '');

/** The nesting the geometry actually depends on. `.table-page--embedded` is the
 *  production route (MultiTablePage); the standalone one differs only by the tab
 *  bar it subtracts — see CALIBRATION below, which is the datum that proved it. */
export const buildHtml = (css) => `<!doctype html><html><head><style>${css}</style></head>
<body>
  <div class="table-page table-page--embedded" data-hero="true">
    <div class="table-container">
      <div class="table-scaler">
        <div class="seat"><div class="seat__cards seat__cards--hero"></div></div>
        <!-- THE HERO IS A SECOND SEAT AND MUST BE MEASURED SEPARATELY.
             Until 2026-08-28 this harness rendered only .seat, the villain
             slot, and three "@media ... .seat.seat--hero { ... !important }"
             rungs survived the proportional conversion untouched because
             nothing here ever matched them. The hero is the one seat the player
             looks at, and its slot feeds every villain hole card through
             --vh-card-h, so a blind spot here is a blind spot over most of the
             felt. (No backticks in this comment: it lives inside a JS template
             literal, and a backtick here ends the string.) -->
        <!-- Positioned the way the ring positions it: hero sits at y:100 in
             every ring (tableSeatGeometry.ts), i.e. AVATAR CENTRE ON THE
             SCALER'S BOTTOM EDGE, with the wrapper's own
             translate(-50%,-50%) and --hero-lift retired to 0
             (SeatSlot.css, "Zero, not some smaller lift"). Half the hero
             block therefore hangs BELOW the felt, into the strip
             --sp-hero-clear reserves before the action bar - which is the
             dependency that file calls out by name. -->
        <div class="seat-wrapper seat-wrapper--hero" style="position:absolute;left:50%;top:100%;transform:translate(-50%,-50%) translateY(calc(-1 * var(--hero-lift, 0px)))">
          <div class="seat seat--hero seat--in-hand">
            <div class="seat__avatar-wrap"><div class="seat__avatar"></div></div>
            <div class="seat__info"><span class="seat__name">HERO</span><span class="seat__stack">1,000</span></div>
            <div class="seat__cards seat__cards--hero"></div>
          </div>
        </div>
      </div>
    </div>
    <div class="action-panel-wrapper"><div class="action-panel"><div class="action-row">
      <button class="action-btn"><span class="action-btn__label">FOLD</span></button>
    </div></div></div>
  </div>
</body></html>`;

/**
 * Devices, not breakpoints. The point of the list is that it contains viewports
 * BETWEEN the old 640 / 480 / 380 rungs and above all of them — a 744px iPad
 * mini and an 834px iPad Pro 11 are exactly the widths the ladder could not
 * describe, and they are the reason Dan could see the bug.
 */
export const DEVICES = [
  ['iPhone SE', 375, 667],
  ['iPhone 12/13/14', 390, 844],
  ['iPhone 14 Pro Max', 430, 932],
  /* ── REAL HARDWARE ROWS (2026-08-29) ─────────────────────────────────────
     The rows above are what Playwright emulates: env(safe-area-inset-*) = 0.
     No iPhone Dan has ever held works that way — the notch is ~47px (Dynamic
     Island 59px) and the home indicator 34px, all of it paid out of
     --sp-table-h. The 2026-08-29 felt "fix" was verified green on the rows
     above while changing NOTHING on Dan's actual phone, because the real
     felt was height-bound under insets this harness could not see. These two
     rows are the phones as they exist; measureAll substitutes the env()
     tokens with these values (a browser offers no other way to emulate
     them). If a beat passes on the emulated row and fails here, believe
     HERE. */
  ['iPhone 12/13/14 (real)', 390, 844, 47, 34],
  ['iPhone 14 Pro Max (real)', 430, 932, 59, 34],
  ['iPhone landscape', 844, 390],
  ['iPad mini portrait', 744, 1133],
  ['iPad portrait', 768, 1024],
  ['iPad Pro 11 portrait', 834, 1194],
  ['iPad Pro 12.9 portrait', 1024, 1366],
  ['iPad landscape', 1024, 768],
  ['iPad Pro 12.9 landscape', 1366, 1024],
  ['laptop', 1280, 800],
  ['desktop', 1440, 900],
  ['large desktop', 1920, 1080],
];

/**
 * The recorded production measurement, from the comment block at the top of
 * TablePage.css: Chromium at 1204px wide, --sp-action-h 97px, scaler
 * 606.2 x 1002. It is the only figure in this repo taken from a real browser on
 * a real deploy, so it is what proves this harness models the real cascade
 * rather than a plausible-looking one.
 *
 * NOT embedded. The first run of the calibration came out 49px short in
 * --sp-table-h — exactly the tab bar `.table-page--embedded` subtracts — which
 * is how we learned that figure was taken on the standalone route. That is the
 * one datum distinguishing the two, and it is why this asserts rather than
 * assumes.
 */
export const CALIBRATION = {
  viewport: { width: 1204, height: 1235 },
  forceBottom: '.table-container{--sp-table-bottom: calc(97px + 60px) !important}',
  expect: { w: 606.2, h: 1002 },
};

/**
 * Read back on the elements that own them, not on :root — several of these are
 * declared on `.seat` precisely so a responsive block can retune them there.
 *
 * TOKENS ARE MEASURED THROUGH A REAL PROPERTY, NEVER READ AS TEXT. Since
 * 2026-08-28 `--table-w` is a registered <length> and does resolve, but the
 * tokens derived from it (--sp-card2-w and friends) are not registered, so
 * `getPropertyValue` on those still returns "clamp(44px, calc(...), 100px)" and
 * parseFloat gives NaN. The first version of this harness did exactly that and
 * printed a confident 0px card for every device.
 *
 * --table-w IS REPUBLISHED HERE THE WAY THE APP PUBLISHES IT: a ResizeObserver
 * in TablePage.tsx measures `.table-scaler` and writes its width back inline.
 * Without that step this would measure the CSS fallback instead of the real
 * felt, and would be wrong in the flattering direction on exactly the wide
 * viewports in question.
 */
export const PROBE = () => {
  const scaler = document.querySelector('.table-scaler');
  const seat = document.querySelector('.seat:not(.seat--hero)');
  const heroSeat = document.querySelector('.seat--hero');
  const btn = document.querySelector('.action-btn');

  const feltW = scaler.getBoundingClientRect().width;
  scaler.style.setProperty('--table-w', feltW + 'px');

  /* The hero's avatar is measured as a rendered ELEMENT rather than through the
     token probe: `.seat__avatar` is what actually gets drawn, and reading its
     used width catches an override anywhere in the chain — including one that
     sets the element's width directly instead of the token. */
  const heroAvatarEl = heroSeat.querySelector('.seat__avatar');

  const probe = document.createElement('div');
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  seat.appendChild(probe);
  const resolve_ = (expr) => {
    probe.style.width = expr;
    return +parseFloat(getComputedStyle(probe).width).toFixed(1);
  };

  const out = {
    feltW: +feltW.toFixed(1),
    feltH: +scaler.getBoundingClientRect().height.toFixed(1),
    btnH: +parseFloat(getComputedStyle(btn).height).toFixed(1),
    card2W: resolve_('var(--sp-card2-w)'),
    card2H: resolve_('var(--sp-card2-h)'),
    cardRevW: resolve_('var(--sp-cardrev-w)'),
    avatar: resolve_('var(--seat-avatar-size)'),
    seatW: +parseFloat(getComputedStyle(seat).width).toFixed(1),
    /* The hero slot, measured on the hero's own element. --seat-avatar-size is
       redeclared on `.seat.seat--hero` (x1.3333), so reading it from the
       villain tells you nothing about the hero — which is exactly how three
       !important rungs survived a conversion that claimed to delete them. */
    heroAvatar: +parseFloat(getComputedStyle(heroAvatarEl).width).toFixed(1),
    heroSeatW: +parseFloat(getComputedStyle(heroSeat).width).toFixed(1),
    /* Is the hero's name-and-stack plate covered by the fixed action bar?
       This is the failure `--sp-hero-clear` exists to prevent and the one
       SeatSlot.css names as the lift's single dependency. Reading it as two
       rects rather than as arithmetic is the point: the plate's height, the
       avatar's, the reserve and the bar's own height are now four different
       proportional expressions, and only layout knows where they land. */
    heroPlateBottom: +heroSeat.getBoundingClientRect().bottom.toFixed(1),
    heroOverhang: +(
      heroSeat.getBoundingClientRect().bottom - scaler.getBoundingClientRect().bottom
    ).toFixed(1),
    barTop: +btn.closest('.action-panel').getBoundingClientRect().top.toFixed(1),
    heroClear: resolve_('var(--sp-hero-clear)'),
    // PLO4 is the widest private row: w + 3 x step.
    plo4Row: resolve_('calc(var(--sp-card2-w) + 3 * var(--sp-card2-w) * 0.4167)'),
  };
  probe.remove();
  return out;
};

/** Measure every device in one browser. `page` is a Playwright page from either
 *  the spec's fixture or a script's own chromium launch. */
/** Substitute env(safe-area-inset-top/bottom) with concrete px. A browser
 *  offers no API to emulate the insets, and they are exactly what separated
 *  every green check from Dan's phone on 2026-08-29 — so the harness rewrites
 *  the tokens in the CSS text itself. Fallback forms with or without a default
 *  are both matched; left/right stay 0 (no portrait phone has either). */
export const applyInsets = (css, insetTop, insetBottom) =>
  css
    .replace(/env\(\s*safe-area-inset-top\s*(?:,[^()]*)?\)/g, `${insetTop}px`)
    .replace(/env\(\s*safe-area-inset-bottom\s*(?:,[^()]*)?\)/g, `${insetBottom}px`);

export async function measureAll(page, css) {
  const plainHtml = buildHtml(css);
  const rows = [];
  for (const [device, width, height, insetTop = 0, insetBottom = 0] of DEVICES) {
    await page.setViewportSize({ width, height });
    const html =
      insetTop || insetBottom
        ? buildHtml(applyInsets(css, insetTop, insetBottom))
        : plainHtml;
    await page.setContent(html);
    rows.push({ device, vp: `${width}x${height}`, ...(await page.evaluate(PROBE)) });
  }
  return rows;
}
