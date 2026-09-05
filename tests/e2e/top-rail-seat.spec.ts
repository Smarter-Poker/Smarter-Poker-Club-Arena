/**
 * Dan 2026-08-19, bug list item 10: "the top player's box must sit on top of
 * the rail, not in the middle of the table."
 *
 * Table geometry, from the measured skin composites (TablePage.tsx):
 *   .table-surface (the FELT window) = top 8.9%, height 80.3% of .table-scaler
 *   the top rail band sits just ABOVE the felt, centred near y 8.5%
 * So "on the rail" means the player box straddles ~8.5%; "in the middle of the
 * table" means it sits entirely below 8.9%, floating on the felt.
 *
 * Why the seat is compact: with the avatar ABOVE the nameplate, a full-size
 * seat cannot put its box on the rail. The box sits ~3.9% of the table below
 * the seat centre, so anchoring it on the rail needs a seat centre near 4.6%,
 * which pushes the seat - and the bust art, which is drawn rising from its
 * feet - off the top of the canvas into the BBJ banner. A 56px avatar halves
 * that offset and makes it fit. Dan chose this trade-off over flipping the
 * nameplate or letting the art overlap the banner.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const seatCss = fs.readFileSync(
  path.join(process.cwd(), 'src/components/table/SeatSlot.css'),
  'utf8'
);
/**
 * The y the app actually ships for the top-centre seat. Read from source, never
 * hardcoded — but read from WHEREVER the rings live.
 *
 * 2026-08-19: the seat rings were moved out of TablePage.tsx into
 * src/lib/tableSeatGeometry.ts by a refactor, and this spec kept reading the old
 * file. The regex stopped matching, TOP_CENTRE_Y became NaN, and three checks
 * failed — the item-10 guard had quietly stopped guarding anything. Searching
 * the candidate files instead of naming one means the next move cannot silently
 * disarm it, and a miss is now a loud failure rather than a NaN.
 */
const RING_SOURCES = [
  'src/lib/tableSeatGeometry.ts',
  'src/pages/TablePage.tsx',
  'src/utils/tableGeometry.ts',
];

function readTopCentreY(): number {
  for (const rel of RING_SOURCES) {
    const full = path.join(process.cwd(), rel);
    if (!fs.existsSync(full)) continue;
    const src = fs.readFileSync(full, 'utf8');
    const m = /\{\s*x:\s*50,\s*y:\s*([\d.]+)\s*\}[^\n]*top-center/i.exec(src);
    if (m) return Number(m[1]);
  }
  throw new Error(
    'top-centre seat position not found in any of: ' +
      RING_SOURCES.join(', ') +
      ' — the seat rings moved again and this spec must be pointed at them.'
  );
}

const TOP_CENTRE_Y = readTopCentreY();

const SCALER_H = 1000;
const FELT_TOP_PCT = 8.9;
const RAIL_PCT = 8.5;

const seat = (topPct: number, extraClass: string) => `
  <div class="seat-wrapper ${extraClass}" style="left:50%; top:${topPct}%">
    <div class="seat seat--in-hand">
      <div class="seat__avatar-wrap seat__avatar-wrap--bust">
        <div class="seat__avatar seat__avatar--bust">
          <img class="seat__avatar-img" alt="" />
        </div>
      </div>
      <div class="seat__info"><span class="seat__name">VILLAIN</span><span class="seat__stack">1,000</span></div>
    </div>
  </div>`;

const harness = `
  <style>
    * { box-sizing: border-box; animation: none !important; }
    /* design-tokens.css: the global table avatar size. Without it .seat__avatar
       falls back to its own 56px default and the full-size controls below would
       silently measure a compact seat. */
    :root { --seat-avatar-size: 84px; }
    body { margin: 0; }
    /* 2026-08-29: --table-w republished the way the app publishes it
       (ResizeObserver writes the measured width back). Without it the
       proportional --seat-avatar-size (#1650) resolves from its 360px
       fallback and every full-size assertion below measures a felt that
       never ships at this scaler size. */
    .table-scaler { position: relative; width: 605px; height: ${SCALER_H}px; margin: 0 auto; --table-w: 605px; }
    .table-felt { position: absolute; inset: 0; }
    .table-surface { position: absolute; left: 13.3%; top: ${FELT_TOP_PCT}%;
                     width: 73.2%; height: 80.3%; z-index: 1; }
    .seat-wrapper { position: absolute; transform: translate(-50%, -50%); z-index: 10; }
    .seat__avatar-img { width: 100%; height: 100%; display: block; background: #666; }
    .seat__info { width: 96px; height: 34px; background: #222; }
  </style>`;

const page = (topPct: number, extraClass: string) => `
  ${harness}<style>${seatCss}</style>
  <div class="table-scaler">
    <div class="table-felt"><div class="table-surface"></div></div>
    ${seat(topPct, extraClass)}
  </div>`;

async function measure(p: import('@playwright/test').Page) {
  return p.evaluate(() => {
    const scaler = document.querySelector('.table-scaler')!.getBoundingClientRect();
    const box = document.querySelector('.seat__info')!.getBoundingClientRect();
    const img = document.querySelector('.seat__avatar-img')!.getBoundingClientRect();
    const avatar = document.querySelector('.seat__avatar')!.getBoundingClientRect();
    const pct = (v: number) => ((v - scaler.top) / scaler.height) * 100;
    return {
      boxTopPct: pct(box.top),
      boxBottomPct: pct(box.bottom),
      artTopPct: pct(img.top),
      avatarPx: avatar.width,
    };
  });
}

test.use({ viewport: { width: 1280, height: 1100 } });

test('the shipped top-centre seat y is the one this spec measures', () => {
  expect(Number.isFinite(TOP_CENTRE_Y)).toBe(true);
});

test('the player box straddles the rail band', async ({ page: p }) => {
  await p.setContent(page(TOP_CENTRE_Y, 'seat-wrapper--top'));
  const m = await measure(p);
  expect(m.boxTopPct).toBeLessThanOrEqual(RAIL_PCT);
  expect(m.boxBottomPct).toBeGreaterThanOrEqual(RAIL_PCT);
});

test('the box is not stranded on the felt', async ({ page: p }) => {
  await p.setContent(page(TOP_CENTRE_Y, 'seat-wrapper--top'));
  const m = await measure(p);
  expect(m.boxTopPct).toBeLessThan(FELT_TOP_PCT);
});

test('the whole seat, bust art included, stays inside the table canvas', async ({ page: p }) => {
  await p.setContent(page(TOP_CENTRE_Y, 'seat-wrapper--top'));
  const m = await measure(p);
  expect(m.artTopPct).toBeGreaterThanOrEqual(0);
});

test('the top-centre avatar is the compact size', async ({ page: p }) => {
  await p.setContent(page(TOP_CENTRE_Y, 'seat-wrapper--top'));
  /* 76 since 2026-09-05, measured: the cap was a flat 56 chosen when the slot
     was a flat 84, and the slot became proportional while the cap did not - so
     a 720px table halved its top row. Chromium says 76 clears the banner by
     3.9px and 84 is 0.2px inside it. This harness has no `.table-page`
     ancestor, so it exercises the FULL-canvas rule; the short-canvas rings
     (<=6 seats) keep 56 and are pinned in the unit suite. */
  expect((await measure(p)).avatarPx).toBe(76);
});

test('CONTROL: a full-size seat at this height would leave the canvas', async ({ page: p }) => {
  // Proves the compact treatment is doing real work, not decorating a fix.
  await p.setContent(page(TOP_CENTRE_Y, ''));
  const m = await measure(p);
  // Full-size means the proportional law's answer, not the retired 84px rung.
  expect(Math.abs(m.avatarPx - Math.max(50, 605 * 0.158))).toBeLessThanOrEqual(1);
  expect(m.artTopPct).toBeLessThan(0);
});

test('CONTROL: the previous y=11 position stranded the box on the felt', async ({ page: p }) => {
  await p.setContent(page(11, 'seat-wrapper--top'));
  const m = await measure(p);
  expect(m.boxTopPct).toBeGreaterThan(FELT_TOP_PCT);
});

test('side and bottom seats keep the full-size avatar and 1.45x bust', async ({ page: p }) => {
  await p.setContent(page(50, ''));
  const m = await measure(p);
  /* 2026-08-29: was `toBe(84)` — the px-ladder avatar that #1650 deliberately
     replaced with a fraction of the felt. This spec ran in NO CI job, so the
     pin sat red for a day and guarded nothing. The full-size avatar is now
     the same law table-proportions.spec.ts enforces: 15.8% of the felt,
     floored at 50px. What THIS beat still owns is the contrast with the
     compact top seat above — full-size seats must not silently inherit the
     top row's 56px cap. */
  const expected = Math.max(50, 605 * 0.158);
  expect(Math.abs(m.avatarPx - expected)).toBeLessThanOrEqual(1);
  expect(m.avatarPx).toBeGreaterThan(56 + 10);
  const t = await p.evaluate(
    () => getComputedStyle(document.querySelector('.seat__avatar-img')!).transform
  );
  expect(t).toContain('1.45');
});
