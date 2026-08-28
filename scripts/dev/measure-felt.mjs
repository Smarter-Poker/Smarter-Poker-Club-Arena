/**
 * WHAT THE FELT AND EVERYTHING ON IT ACTUALLY MEASURES, PER DEVICE.
 *
 * Dan 2026-08-28: "why doesn't the live table scale differently per device? My
 * buttons and cards look the same no matter if I'm on a phone, or a tablet."
 *
 * Answering that needs real numbers, not arithmetic done in a comment. The
 * felt's width is not a property anyone declares — `.table-scaler` derives it
 * from the vertical space left over, through six custom properties and four
 * breakpoints, and the only honest way to know what a 768px tablet gets is to
 * lay it out in a browser at 768px and read it back.
 *
 * This loads the REAL stylesheets off disk into the REAL element nesting, at a
 * list of real device viewports, and prints what each one resolves to. It needs
 * no dev server and no login, so it reruns identically on any machine and in CI.
 *
 *   node scripts/dev/measure-felt.mjs
 *   node scripts/dev/measure-felt.mjs --json
 *
 * CALIBRATION, so a wrong answer here is caught rather than believed: the
 * comment block at the top of TablePage.css records a production measurement —
 * Chromium at 1204px wide, --sp-action-h 97px, scaler 606.2 x 1002. The
 * `--calibrate` run reproduces that setup and asserts the same number falls out,
 * which is what proves this harness models the real cascade rather than a
 * plausible-looking one.
 *
 *   node scripts/dev/measure-felt.mjs --calibrate
 */

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../');

/** Every stylesheet that contributes to the felt's geometry or to what sits on
 *  it, in cascade order. @import lines are stripped because the imported file is
 *  concatenated here instead — a bare @import inside setContent would 404. */
const SHEETS = [
  'src/styles/design-tokens.css',
  'src/pages/TablePage.css',
  'src/components/table/ActionPanel.css',
  'src/components/table/SeatSlot.css',
  'src/components/table/TableVisualHotfix.css',
];

const css = SHEETS.map((f) => readFileSync(resolve(ROOT, f), 'utf8'))
  .join('\n')
  .replace(/@import\s+[^;]+;/g, '');

/** The nesting the geometry actually depends on. `.table-page--embedded` is the
 *  production route (MultiTablePage); the non-embedded one only differs by the
 *  tab bar it subtracts. */
const HTML = `<!doctype html><html><head><style>${css}</style></head>
<body>
  <div class="table-page table-page--embedded" data-hero="true">
    <div class="table-container">
      <div class="table-scaler">
        <div class="seat"><div class="seat__cards seat__cards--hero"></div></div>
      </div>
    </div>
    <div class="action-panel-wrapper"><div class="action-panel"><div class="action-row">
      <button class="action-btn"><span class="action-btn__label">FOLD</span></button>
    </div></div></div>
  </div>
</body></html>`;

const DEVICES = [
  ['iPhone SE', 375, 667],
  ['iPhone 12/13/14', 390, 844],
  ['iPhone 14 Pro Max', 430, 932],
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
 * Read back on the elements that own them, not on :root — several of these are
 * declared on `.seat` precisely so a responsive block can retune them there.
 *
 * TOKENS ARE MEASURED THROUGH A REAL PROPERTY, NEVER READ AS TEXT. An
 * unregistered custom property computes to its token stream with var()s
 * substituted, not to a length — so `getPropertyValue('--sp-card2-w')` on a
 * `clamp(...)` returns the literal string "clamp(44px, calc(...), 100px)" and
 * parseFloat gives NaN. The first version of this file did exactly that and
 * printed a confident 0 for every card. Assigning the token to `width` on a
 * probe element and reading the used value is the only honest route.
 *
 * --table-w IS REPUBLISHED HERE THE WAY THE APP PUBLISHES IT. In production a
 * ResizeObserver in TablePage.tsx measures `.table-scaler` and writes its width
 * back as an inline `--table-w`. Without that step this harness would measure
 * the static CSS fallback instead of the real felt, and would be wrong in the
 * flattering direction on exactly the wide viewports in question.
 */
const PROBE = () => {
  const scaler = document.querySelector('.table-scaler');
  const seat = document.querySelector('.seat');
  const btn = document.querySelector('.action-btn');

  // Stand in for the ResizeObserver, then let styles settle against it.
  const feltW = scaler.getBoundingClientRect().width;
  scaler.style.setProperty('--table-w', feltW + 'px');

  const probe = document.createElement('div');
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  seat.appendChild(probe);
  const resolve = (expr) => {
    probe.style.width = expr;
    return +parseFloat(getComputedStyle(probe).width).toFixed(1);
  };

  const out = {
    feltW: +feltW.toFixed(1),
    feltH: +scaler.getBoundingClientRect().height.toFixed(1),
    btnH: +parseFloat(getComputedStyle(btn).height).toFixed(1),
    card2W: resolve('var(--sp-card2-w)'),
    card2H: resolve('var(--sp-card2-h)'),
    cardRevW: resolve('var(--sp-cardrev-w)'),
    avatar: resolve('var(--seat-avatar-size)'),
    seatW: +parseFloat(getComputedStyle(seat).width).toFixed(1),
    // PLO4 is the widest private row: w + 3 x step.
    plo4Row: resolve('calc(var(--sp-card2-w) + 3 * var(--sp-card2-w) * 0.4167)'),
  };
  probe.remove();
  return out;
};

const browser = await chromium.launch();
const page = await browser.newPage();

if (process.argv.includes('--calibrate')) {
  /* The recorded production case: 1204px wide, --sp-action-h 97px, and the
     window tall enough that --sp-table-h came out at 1002. That predates the
     constant reserve, so the height is injected the way the note describes. */
  await page.setViewportSize({ width: 1204, height: 1235 });
  /* NOT embedded. The first run of this calibration came out 49px short in
     --sp-table-h — exactly the tab bar `.table-page--embedded` subtracts — which
     is the harness telling us the recorded measurement was taken on the
     standalone route. Worth keeping as a comment: it is the one datum that
     distinguishes the two routes, and it is why this file asserts rather than
     assumes. */
  await page.setContent(HTML.replace(' table-page--embedded', ''));
  await page.addStyleTag({
    content: `.table-container{--sp-table-bottom: calc(97px + 60px) !important}`,
  });
  const { feltW, feltH } = await page.evaluate(PROBE);
  const okW = Math.abs(feltW - 606.2) < 2;
  const okH = Math.abs(feltH - 1002) < 3;
  console.log(`calibration: expected 606.2 x 1002, got ${feltW} x ${feltH}`);
  console.log(okW && okH ? 'PASS — the harness models the real cascade.' : 'FAIL');
  await browser.close();
  process.exit(okW && okH ? 0 : 1);
}

const rows = [];
for (const [name, width, height] of DEVICES) {
  await page.setViewportSize({ width, height });
  await page.setContent(HTML);
  rows.push({ device: name, vp: `${width}x${height}`, ...(await page.evaluate(PROBE)) });
}
await browser.close();

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  /* Card and avatar as a PERCENTAGE OF THE FELT is the column the whole
     question turns on. If it is not flat down this column, the thing on the
     felt is not scaling with the felt — which is the bug. */
  const pct = (v, w) => (w ? ((v / w) * 100).toFixed(1) + '%' : '-');
  console.table(
    rows.map((r) => ({
      device: r.device,
      viewport: r.vp,
      felt: `${r.feltW}`,
      btn: r.btnH,
      card: r.card2W,
      'card/felt': pct(r.card2W, r.feltW),
      avatar: r.avatar,
      'avatar/felt': pct(r.avatar, r.feltW),
      'PLO4 row/felt': pct(r.plo4Row, r.feltW),
      seat: r.seatW,
    }))
  );
}
