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

/**
 * The 9-max ring's TOP-CAP y, read the same way.
 *
 * Added 2026-09-05 because this spec had been measuring a pairing that ships
 * nowhere. `TOP_CENTRE_Y` comes from `{ x: 50, y: 5 }`, which only exists on
 * the rings of six seats or fewer - and since the canvas and the avatar cap
 * became per-ring, those rings draw on a 960-unit canvas with a 56px cap,
 * while 7/8/9-max draw at y 6 on 1000 with a 76px cap. Testing y 5 against
 * the full-canvas cap combined the tightest seat position with the largest
 * avatar, a combination the app cannot produce, and failed.
 *
 * Both real pairings are measured below instead.
 */
function readTopCapY(): number {
  for (const rel of RING_SOURCES) {
    const full = path.join(process.cwd(), rel);
    if (!fs.existsSync(full)) continue;
    const src = fs.readFileSync(full, 'utf8');
    const m = /\{\s*x:\s*27,\s*y:\s*([\d.]+)\s*\}[^\n]*top-left/i.exec(src);
    if (m) return Number(m[1]);
  }
  throw new Error(
    'the 9-max top-cap seat position was not found in any of: ' +
      RING_SOURCES.join(', ') +
      ' - the seat rings moved again and this spec must be pointed at them.'
  );
}

const TOP_CAP_Y = readTopCapY();

/** The two pairings the app actually ships. Canvas heights: TablePage.css. */
const SMALL_RING = { y: TOP_CENTRE_Y, canvas: 960, seats: 6, cap: 56 } as const;
const FULL_RING = { y: TOP_CAP_Y, canvas: 1000, seats: 9, cap: 76 } as const;

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
    .table-scaler { position: relative; width: 605px; height: var(--harness-h, ${SCALER_H}px); margin: 0 auto; --table-w: 605px; }
    .table-felt { position: absolute; inset: 0; }
    .table-surface { position: absolute; left: 13.3%; top: ${FELT_TOP_PCT}%;
                     width: 73.2%; height: 80.3%; z-index: 1; }
    .seat-wrapper { position: absolute; transform: translate(-50%, -50%); z-index: 10; }
    .seat__avatar-img { width: 100%; height: 100%; display: block; background: #666; }
    .seat__info { width: 96px; height: 34px; background: #222; }
  </style>`;

/**
 * `seats` puts the real `.table-page[data-seats=N]` ancestor around the scaler,
 * because since 2026-09-05 that attribute is what selects the top row's avatar
 * cap. Omit it to exercise the full-canvas rule directly.
 */
const page = (
  topPct: number,
  extraClass: string,
  opts: { canvas?: number; seats?: number } = {}
) => {
  const canvas = opts.canvas ?? SCALER_H;
  const open = opts.seats ? `<div class="table-page" data-seats="${opts.seats}">` : '';
  const close = opts.seats ? '</div>' : '';
  return `${harness}<style>:root { --harness-h: ${canvas}px; }</style><style>${seatCss}</style>
  ${open}
  <div class="table-scaler">
    <div class="table-felt"><div class="table-surface"></div></div>
    ${seat(topPct, extraClass)}
  </div>
  ${close}`;
};

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

/* ─────────────────────────────────────────────────────────────────────────
   Every beat below runs against BOTH shipped pairings. Before 2026-09-05 they
   ran against one invented pairing - the small ring's y on the full ring's
   canvas and cap - and when the cap became per-canvas that combination put
   the bust art inside the banner and failed, describing a table nobody can
   open. A guard that measures an impossible layout protects nothing.
   ───────────────────────────────────────────────────────────────────────── */
const RINGS = [
  {
    label: `small ring (<=6 seats, y ${SMALL_RING.y}, canvas ${SMALL_RING.canvas})`,
    ...SMALL_RING,
  },
  { label: `full ring (7-9 seats, y ${FULL_RING.y}, canvas ${FULL_RING.canvas})`, ...FULL_RING },
];

for (const ring of RINGS) {
  const content = () =>
    page(ring.y, 'seat-wrapper--top', { canvas: ring.canvas, seats: ring.seats });

  test(`${ring.label}: the player box straddles the rail band`, async ({ page: p }) => {
    await p.setContent(content());
    const m = await measure(p);
    expect(m.boxTopPct).toBeLessThanOrEqual(RAIL_PCT);
    expect(m.boxBottomPct).toBeGreaterThanOrEqual(RAIL_PCT);
  });

  test(`${ring.label}: the box is not stranded on the felt`, async ({ page: p }) => {
    await p.setContent(content());
    expect((await measure(p)).boxTopPct).toBeLessThan(FELT_TOP_PCT);
  });

  test(`${ring.label}: the whole seat, bust art included, stays inside the canvas`, async ({
    page: p,
  }) => {
    await p.setContent(content());
    const m = await measure(p);
    /* Two pixels, not zero. Measured clearances at 605px wide are 2.2px on the
       small ring and 3.9px on the full one; a bare `>= 0` would call 0.2px
       fine, and 0.2px is a rounding error away from the 2026-08-19 bug this
       whole rule exists to prevent. */
    expect(m.artTopPct * (ring.canvas / 100)).toBeGreaterThanOrEqual(2);
  });

  test(`${ring.label}: the top avatar is capped at ${ring.cap}px`, async ({ page: p }) => {
    await p.setContent(content());
    /* The cap belongs to the CANVAS. 76px on the full ring is a 36% larger
       avatar than the flat 56 it replaced (that number was two-thirds of a
       flat 84px slot, and the slot became proportional while the cap did not,
       so a 720px table was halving its top row). The same 76 on the short
       canvas measures 8.1px INSIDE the banner, which is why the small rings
       keep 56. Both are measured, not reasoned. */
    expect((await measure(p)).avatarPx).toBe(ring.cap);
  });
}

test('CONTROL: a full-size seat at this height would leave the canvas', async ({ page: p }) => {
  // Proves the compact treatment is doing real work, not decorating a fix.
  // No `seat-wrapper--top`, so no cap at all - the proportional slot in full.
  await p.setContent(
    page(SMALL_RING.y, '', { canvas: SMALL_RING.canvas, seats: SMALL_RING.seats })
  );
  const m = await measure(p);
  // Full-size means the proportional law's answer, not the retired 84px rung.
  expect(Math.abs(m.avatarPx - Math.max(50, 605 * 0.158))).toBeLessThanOrEqual(1);
  expect(m.artTopPct).toBeLessThan(0);
});

test('CONTROL: the previous y=11 position stranded the box on the felt', async ({ page: p }) => {
  await p.setContent(
    page(11, 'seat-wrapper--top', { canvas: FULL_RING.canvas, seats: FULL_RING.seats })
  );
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
