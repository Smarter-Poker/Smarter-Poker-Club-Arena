/**
 * REGENERATE THE FELT GEOMETRY BASELINE — tests/e2e/support/geometry-baseline.json
 *
 * Dan 2026-08-29, after the felt spent three days 26px narrower than he had
 * approved and nothing went red: "YOU NEED TO ADD PREVENTIVE REGRESSION TO
 * ALL ASPECTS ... WE DON'T EVER WANT THINGS RANDOMLY REGRESSING."
 *
 * The proportion beats in table-proportions.spec.ts pin RATIOS — they cannot
 * see the whole table shrinking, because everything on it shrinks in step and
 * every ratio stays flat. That is exactly how #950 shipped a narrower felt
 * with green checks. The baseline pins the ABSOLUTE numbers, per device, so
 * an unintended size change anywhere in the felt's five stylesheets goes red
 * with the device named and the pixels counted.
 *
 * THE RITUAL, and it is deliberately manual:
 *
 *   1. Make your CSS change.
 *   2. node scripts/dev/update-geometry-baseline.mjs
 *   3. Read the diff of geometry-baseline.json. Every changed number is a
 *      size change you are shipping. If a number changed that you did not
 *      intend, that is the regression the guard just caught — fix the CSS,
 *      do not commit the diff.
 *   4. Commit the JSON in the SAME commit as the CSS, and state the size
 *      change in the PR description.
 *
 * A baseline diff with no stated reason IS the regression. Reviewers and
 * agents: treat an unexplained geometry-baseline.json hunk exactly like a
 * weakened law-test pin.
 */
import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildCss, measureAll } from '../../tests/e2e/support/feltHarness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../');
const OUT = resolve(ROOT, 'tests/e2e/support/geometry-baseline.json');

/** The fields the guard asserts. Pure CSS-derived box sizes only — nothing
 *  that depends on font rasterisation, so macOS and CI Linux agree. */
export const BASELINE_FIELDS = [
  'feltW',
  'feltH',
  'btnH',
  'card2W',
  'card2H',
  'avatar',
  'heroAvatar',
  'seatW',
  'plo4Row',
];

const browser = await chromium.launch();
const page = await browser.newPage();
const rows = await measureAll(page, buildCss(ROOT));
await browser.close();

const baseline = {};
for (const r of rows) {
  baseline[r.device] = { vp: r.vp };
  for (const f of BASELINE_FIELDS) baseline[r.device][f] = r[f];
}

writeFileSync(OUT, JSON.stringify(baseline, null, 2) + '\n');
console.log(`[geometry-baseline] wrote ${Object.keys(baseline).length} devices to ${OUT}`);
console.log('[geometry-baseline] now READ THE DIFF — every changed number is a size change you are shipping.');
