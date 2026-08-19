/**
 * Dan 2026-08-19, bug list item 10: "the top player's box must sit on top of
 * the rail, not in the middle of the table."
 *
 * The top-centre seats had been moved DOWN off the measured rail band
 * (y 8.5% -> 11%) so tall bust art would stop poking into the BBJ banner above
 * the table. That fixed the art by putting the whole player box in the middle
 * of the felt - the bug Dan reported. The seats are back on the rail and the
 * overhang is capped at its source (bust scale, top row only).
 *
 * Table geometry, from the measured skin composites (TablePage.tsx):
 *   .table-surface (the FELT window) = top 8.9%, height 80.3% of .table-scaler
 *   the top rail band sits just ABOVE that, centred near y 8.5%
 * So "on the rail" means the player box straddles ~8.5%, and "in the middle of
 * the table" means it sits below 8.9% entirely.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const seatCss = fs.readFileSync(
  path.join(process.cwd(), 'src/components/table/SeatSlot.css'),
  'utf8'
);

const SCALER_H = 1000;
const FELT_TOP_PCT = 8.9; // .table-surface top
const RAIL_PCT = 8.5; // measured rail band at the top cap

/** The seat markup SeatSlot.tsx emits for an occupied villain seat. */
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
    body { margin: 0; }
    .table-scaler { position: relative; width: 605px; height: ${SCALER_H}px; margin: 0 auto; }
    .table-felt { position: absolute; inset: 0; }
    .table-surface { position: absolute; left: 13.3%; top: ${FELT_TOP_PCT}%;
                     width: 73.2%; height: 80.3%; z-index: 1; }
    .seat-wrapper { position: absolute; transform: translate(-50%, -50%); z-index: 10; }
    .seat__avatar { width: var(--seat-avatar-size, 84px); height: var(--seat-avatar-size, 84px); }
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
    const pct = (v: number) => ((v - scaler.top) / scaler.height) * 100;
    return {
      boxTopPct: pct(box.top),
      boxBottomPct: pct(box.bottom),
      artTopPct: pct(img.top),
    };
  });
}

test.use({ viewport: { width: 1280, height: 1100 } });

test('the player box straddles the rail band', async ({ page: p }) => {
  await p.setContent(page(8.5, 'seat-wrapper--top'));
  const m = await measure(p);
  expect(m.boxTopPct).toBeLessThanOrEqual(RAIL_PCT);
  expect(m.boxBottomPct).toBeGreaterThanOrEqual(RAIL_PCT);
});

test('the box is NOT stranded in the middle of the felt', async ({ page: p }) => {
  await p.setContent(page(8.5, 'seat-wrapper--top'));
  const m = await measure(p);
  // Wholly below the felt's top edge would mean it is floating on the table.
  expect(m.boxTopPct).toBeLessThan(FELT_TOP_PCT);
});

test('the old y=11 position DID strand the box in the felt', async ({ page: p }) => {
  // Control: proves these assertions measure the real defect.
  await p.setContent(page(11, 'seat-wrapper--top'));
  const m = await measure(p);
  expect(m.boxTopPct).toBeGreaterThan(FELT_TOP_PCT);
});

test('bust art stays inside the table canvas on the top rail', async ({ page: p }) => {
  await p.setContent(page(8.5, 'seat-wrapper--top'));
  const m = await measure(p);
  // Above 0% is off the top of the scaler, i.e. into the BBJ banner.
  expect(m.artTopPct).toBeGreaterThanOrEqual(0);
});

test('the full 1.45x bust WOULD have escaped into the banner at this height', async ({
  page: p,
}) => {
  // Control: without the top-row scale cap, the art leaves the canvas - which
  // is exactly why the seats had been pushed down off the rail.
  await p.setContent(page(8.5, ''));
  const m = await measure(p);
  expect(m.artTopPct).toBeLessThan(0);
});

test('side and bottom seats keep the full 1.45x bust', async ({ page: p }) => {
  await p.setContent(page(50, ''));
  const scale = await p.evaluate(
    () => getComputedStyle(document.querySelector('.seat__avatar-img')!).transform
  );
  // matrix(1.45, 0, 0, 1.45, ...)
  expect(scale).toContain('1.45');
});
