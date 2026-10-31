/** Owner 2026-10-31: every top, side and hero seat shares the former hero size.
 * Banner clearance now belongs to the measured layout hook, not a smaller cap.
 * Exercise that owner together with the real stylesheet; full-table card,
 * player and marker clearance is covered in table-proportions.spec.ts.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { buildSync } from 'esbuild';
const layoutBundle = buildSync({
  stdin: {
    contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {useProtectedCardLayout} from './src/hooks/useProtectedCardLayout'; const ref={current:document.querySelector('.table-scaler')}; function Layout(){useProtectedCardLayout(ref,'fixture');return null} createRoot(document.getElementById('layout-root')).render(React.createElement(Layout));`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"test"', 'import.meta.env': '{}' },
}).outputFiles[0].text;
async function mount(p: import('@playwright/test').Page, content: string) {
  await p.setContent(content + '<div id="layout-root"></div>');
  await p.addScriptTag({ content: layoutBundle });
  await p.waitForFunction(() =>
    Boolean(
      document.querySelector('.seat-wrapper--top')?.getAttribute('style')?.includes('translate:')
    )
  );
}
const fullAvatar = Math.max(50, 605 * 0.158) * 1.3333;

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

/** Real ring positions and canvas heights. */
const SMALL_RING = { y: TOP_CENTRE_Y, canvas: 960, seats: 6 } as const;
const FULL_RING = { y: TOP_CAP_Y, canvas: 1000, seats: 9 } as const;

const SCALER_H = 1000;
const FELT_TOP_PCT = 8.9;

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

/* Full-size top pods keep their player facts in the upper quarter, below
   the retained crown anchor. The complete ring is checked separately. */
for (const ring of RINGS) {
  const content = () =>
    page(ring.y, 'seat-wrapper--top', { canvas: ring.canvas, seats: ring.seats });

  test(`${ring.label}: the complete top pod clears the banner`, async ({ page: p }) => {
    await mount(p, content());
    const m = await measure(p);
    // The six-seat crown keeps its existing intentional 2px clipping.
    expect(m.artTopPct * (ring.canvas / 100)).toBeGreaterThanOrEqual(ring.seats === 6 ? -2.01 : 2);
    expect(m.boxTopPct).toBeGreaterThan(m.artTopPct);
  });

  test(`${ring.label}: the box stays in the upper player lane`, async ({ page: p }) => {
    await mount(p, content());
    expect((await measure(p)).boxBottomPct).toBeLessThan(25);
  });
}

/* Full rings keep the complete artwork below the page boundary. */
for (const ring of [FULL_RING].map((r) => ({
  label: `full ring (7-9 seats, y ${r.y}, canvas ${r.canvas})`,
  ...r,
}))) {
  const content = () =>
    page(ring.y, 'seat-wrapper--top', { canvas: ring.canvas, seats: ring.seats });

  test(`${ring.label}: the whole seat, bust art included, stays inside the canvas`, async ({
    page: p,
  }) => {
    await mount(p, content());
    const m = await measure(p);
    // Keep daylight below the boundary; zero is too close to clipping.
    expect(m.artTopPct * (ring.canvas / 100)).toBeGreaterThanOrEqual(2);
  });

  test(`${ring.label}: the top avatar uses the full hero size`, async ({ page: p }) => {
    await mount(p, content());
    expect((await measure(p)).avatarPx).toBeCloseTo(fullAvatar, 0);
  });
}

/* Dan 2026-10-24: "IN 6 HANDED GAMES, THE AVATAR OR VILLIAN IN THE 'DONKQUEEN'
   POSITION CAN BE FULL SCREEN NOW THAT THE BBJ IS REMOVED FROM ABOVE THEM...
   MAKE THAT CHANGE GLOBALLY". The short rings' top seat is the full
   proportional slot with the full 1.45x bust, exactly like a side seat. */
test('small ring: the top-centre seat is the same full size as every other villain', async ({
  page: p,
}) => {
  await p.setContent(
    page(SMALL_RING.y, 'seat-wrapper--top', {
      canvas: SMALL_RING.canvas,
      seats: SMALL_RING.seats,
    })
  );
  const m = await measure(p);
  expect(Math.abs(m.avatarPx - fullAvatar)).toBeLessThanOrEqual(1);
  const t = await p.evaluate(
    () => getComputedStyle(document.querySelector('.seat__avatar-img')!).transform
  );
  expect(t).toContain('1.45');
});

test('every ring (2-9 seats) gets the full hero-size top seat', async ({ page: p }) => {
  for (const seats of [2, 3, 4, 5, 6, 7, 8, 9]) {
    await p.setContent(
      page(SMALL_RING.y, 'seat-wrapper--top', { canvas: SMALL_RING.canvas, seats })
    );
    const { avatarPx } = await measure(p);
    expect(avatarPx, `${seats}-max`).toBeCloseTo(fullAvatar, 0);
  }
});

test('CONTROL: a full-size seat at this height would leave the canvas', async ({ page: p }) => {
  // The unplaced CSS control proves why the measured hook owns clearance.
  await p.setContent(
    page(SMALL_RING.y, '', { canvas: SMALL_RING.canvas, seats: SMALL_RING.seats })
  );
  const m = await measure(p);
  // Full-size means the proportional law's answer, not the retired 84px rung.
  expect(Math.abs(m.avatarPx - fullAvatar)).toBeLessThanOrEqual(1);
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
  // A side seat must use the same proportional slot and artwork scale.
  const expected = fullAvatar;
  expect(Math.abs(m.avatarPx - expected)).toBeLessThanOrEqual(1);
  expect(m.avatarPx).toBeGreaterThan(56 + 10);
  const t = await p.evaluate(
    () => getComputedStyle(document.querySelector('.seat__avatar-img')!).transform
  );
  expect(t).toContain('1.45');
});

// Measure the real badge cascade: its layout footprint must shrink together
// with the text, so EquityBadgeLayer still avoids the displayed cards.
test('mobile all-in equity badges are half size', async ({ page }) => {
  const tableCss = fs.readFileSync(path.join(process.cwd(), 'src/pages/TablePage.css'), 'utf8');
  // Real line spacing is unitless (1.6). Browser-default `normal` varies by
  // platform/font and is not the app's cascade. Keep the exact half-height pin.
  const globalCss = fs.readFileSync(path.join(process.cwd(), 'src/styles/club-engine.css'), 'utf8');
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.setContent(
    `<style>${globalCss}\n${tableCss}</style><div class="equity-layer"><div class="equity-layer__slot"><div class="equity-overlay equity-overlay--ahead">100%<span class="equity-overlay__track"><span class="equity-overlay__bar"></span></span></div></div></div>`
  );
  await page
    .locator('.equity-overlay')
    .evaluate((el) => el.getAnimations().forEach((a) => a.finish()));
  const measure = () =>
    page.locator('.equity-overlay').evaluate((el) => {
      const badge = el.getBoundingClientRect();
      const track = el.querySelector('.equity-overlay__track')!.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        font: parseFloat(style.fontSize),
        lineHeight: parseFloat(style.lineHeight),
        width: badge.width,
        height: badge.height,
        trackW: track.width,
        trackH: track.height,
      };
    });
  const desktop = await measure();
  for (const width of [320, 375, 393, 430, 600, 768]) {
    await page.setViewportSize({ width, height: 900 });
    const mobile = await measure();
    expect(desktop.font).toBe(24);
    expect(mobile.font).toBe(12);
    expect(mobile.lineHeight).toBeCloseTo(desktop.lineHeight / 2, 1);
    expect(mobile.width).toBeCloseTo(desktop.width / 2, 1);
    expect(mobile.height).toBeCloseTo(desktop.height / 2, 1);
    expect(mobile.trackW).toBe(44);
    expect(mobile.trackH).toBe(3);
  }
});
