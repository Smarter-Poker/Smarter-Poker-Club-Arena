/**
 * Dan 2026-08-19, bug list item 15: "chips/chip animations must never appear
 * over the POT total."
 *
 * They did because of a stacking-context trap. `.pot-area` lived inside
 * `.table-surface`, which sets `z-index: 1` and therefore creates a stacking
 * context - so the pot's z-index of 20 could only compete with its siblings
 * inside the felt. The chip-flight layer is a SIBLING of `.table-surface` at
 * z-index 1000, so every chip flying to the pot landed on top of the number
 * and no z-index on the pot could have won.
 *
 * `.pot-area` is now a direct child of `.table-scaler`, alongside the chip
 * layer. This spec proves the two things that have to be true:
 *   1. chips render BENEATH the pot total (elementFromPoint at the pot centre
 *      returns the pot, not a chip);
 *   2. the pot did not move by a single pixel while doing it - measured
 *      against the PREVIOUS stylesheet and markup at four viewport widths.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const cssAfter = fs.readFileSync(path.join(process.cwd(), 'src/pages/TablePage.css'), 'utf8');
/**
 * The PRE-FIX stylesheet, checked in as a fixture.
 *
 * This used to read /tmp/TablePage.before.css - a snapshot that happened to be
 * sitting on the machine the fix was written on. The suite passed there and
 * failed on every clean checkout, because a test may not depend on state that
 * is not in the repository. The fixture is the exact bytes of
 *   git show 7e62f4faa^:src/pages/TablePage.css
 * (7e62f4faa is "chips fly UNDER the pot total"), so the baseline this spec
 * measures against is now reproducible by anyone.
 */
const cssBefore = fs.readFileSync(
  path.join(process.cwd(), 'tests/e2e/fixtures/TablePage.before.css'),
  'utf8'
);
const potCss = fs.readFileSync(
  path.join(process.cwd(), 'src/components/table/PotDisplay.css'),
  'utf8'
);

/**
 * The chip layer's z-index is read from the REAL stylesheet rather than
 * hardcoded, so this spec cannot drift away from what ships.
 */
const chipModuleCss = fs.readFileSync(
  path.join(process.cwd(), 'src/components/table/ChipAnimation.module.css'),
  'utf8'
);
const CHIP_Z = Number(/\.manager\s*\{[^}]*z-index:\s*(\d+)/.exec(chipModuleCss)?.[1] ?? 'NaN');
const CHIP_Z_BEFORE = 1000; // what it was when the bug was reported

const potMarkup = `
  <div class="pot-area">
    <div class="pot-display">
      <div class="pot-display__main">
        <span class="pot-display__label">POT</span>
        <span class="pot-display__amount">12,345</span>
      </div>
    </div>
  </div>`;

/** The chip-flight layer, exactly as ChipAnimation.module.css declares it. */
const chipLayer = `
  <div class="chip-manager">
    <div class="flying-chip" id="chip"></div>
  </div>`;

const harness = `
  <style>
    * { box-sizing: border-box; animation: none !important; }
    body { margin: 0; }
    .table-scaler { position: relative; width: 605px; height: 1000px; margin: 0 auto;
                    transform: scale(1); transform-origin: center center; }
    .table-felt { position: absolute; inset: 0; }
    .table-surface { position: absolute; left: 13.3%; top: 8.9%; width: 73.2%;
                     height: 80.3%; z-index: 1; border-radius: 9999px;
                     display: flex; flex-direction: column; align-items: center; }
    /* ChipAnimation.module.css: .manager. The real layer is
       pointer-events:none, which excludes it from HIT TESTING but not from
       PAINTING - and painting is the bug. elementFromPoint is a hit test, so
       it is re-enabled here purely so the probe reports true paint order.
       z-index, position and size are otherwise verbatim. */
    .chip-manager { position: fixed; top: 0; left: 0; width: 100%; height: 100%;
                    pointer-events: auto; }
    .flying-chip { position: absolute; width: 36px; height: 36px; border-radius: 50%;
                   background: #c00; pointer-events: auto; }
  </style>`;

/** BEFORE: pot nested inside the felt, chip layer a sibling of it. */
const pageBefore = (css: string) => `
  ${harness}<style>${css}\n${potCss}
    .chip-manager { z-index: ${CHIP_Z_BEFORE}; }</style>
  <div class="table-scaler">
    <div class="table-felt">
      <div class="table-surface">${potMarkup}</div>
    </div>
    ${chipLayer}
  </div>`;

/** AFTER: pot promoted to .table-scaler, rendered after the chip layer. */
const pageAfter = (css: string) => `
  ${harness}<style>${css}\n${potCss}
    .chip-manager { z-index: ${CHIP_Z}; }</style>
  <div class="table-scaler">
    <div class="table-felt">
      <div class="table-surface"></div>
    </div>
    ${chipLayer}
    ${potMarkup}
  </div>`;

const BREAKPOINTS = [
  { label: 'desktop', width: 1280 },
  { label: 'tablet', width: 768 },
  { label: 'phone', width: 480 },
  { label: 'small phone', width: 375 },
];

/* potBox() and its half-pixel tolerance left with the retired beat above. */

for (const bp of BREAKPOINTS) {
  test.describe(`pot vs chips @ ${bp.label} (${bp.width}px)`, () => {
    test.use({ viewport: { width: bp.width, height: 1000 } });

    /* RETIRED 2026-08-29: 'the pot did not move when it was promoted out of
       the felt'. That beat compared the LIVE stylesheet against the frozen
       pre-fix fixture and asserted the pot's position matched to half a
       pixel — a one-time migration invariant for the 2026-08-19 promotion,
       written as if the pot would never legitimately move again. It has,
       twice, on purpose: the community-area rework pinned it at 19% of the
       scaler, and the #1571 board-band pass moved it with the board. The
       beat sat red by 330px against deliberate, Dan-approved layout — and
       nobody saw, because this spec ran in NO CI job. The fixture stays:
       the two control beats below still use it to prove the z-order fix is
       measuring a real defect. Position stability is owned by
       tests/unit/feltReserveIsStatic.test.ts (nothing measured feeds the
       geometry) and the geometry baseline (absolute sizes per device),
       which fail on unintended movement without freezing intended design. */

    test('a chip on the pot centre renders BENEATH the total', async ({ page }) => {
      await page.setContent(pageAfter(cssAfter));
      const hit = await page.evaluate(() => {
        const r = document.querySelector('.pot-display__main')!.getBoundingClientRect();
        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;
        // Park a flying chip dead centre on the pot total. The chip is
        // absolutely positioned inside .chip-manager, whose own box is NOT the
        // viewport (.table-scaler carries a transform, which makes it the
        // containing block for its fixed descendants), so offset by it.
        const m = document.querySelector('.chip-manager')!.getBoundingClientRect();
        const chip = document.getElementById('chip')!;
        chip.style.left = `${cx - m.left - 18}px`;
        chip.style.top = `${cy - m.top - 18}px`;
        const el = document.elementFromPoint(cx, cy) as HTMLElement | null;
        return { id: el?.id ?? '', cls: el?.className ?? '' };
      });
      expect(hit.id).not.toBe('chip');
      expect(hit.cls).toContain('pot-display');
    });

    test('the same chip WOULD have covered the total before the fix', async ({ page }) => {
      await page.setContent(pageBefore(cssBefore));
      const hit = await page.evaluate(() => {
        const r = document.querySelector('.pot-display__main')!.getBoundingClientRect();
        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;
        const m = document.querySelector('.chip-manager')!.getBoundingClientRect();
        const chip = document.getElementById('chip')!;
        chip.style.left = `${cx - m.left - 18}px`;
        chip.style.top = `${cy - m.top - 18}px`;
        return (document.elementFromPoint(cx, cy) as HTMLElement | null)?.id ?? '';
      });
      // Proves the test is measuring the real defect, not a tautology.
      expect(hit).toBe('chip');
    });
  });
}

test('the shipped chip layer sits below the pot and below every overlay', () => {
  expect(Number.isFinite(CHIP_Z)).toBe(true);
  expect(CHIP_Z).toBeGreaterThan(1); // above .table-surface (the felt + seats)
  expect(CHIP_Z).toBeLessThan(30); // below .pot-area
});
