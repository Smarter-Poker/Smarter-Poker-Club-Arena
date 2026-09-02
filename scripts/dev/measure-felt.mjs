/**
 * WHAT THE FELT AND EVERYTHING ON IT ACTUALLY MEASURES, PER DEVICE.
 *
 * Dan 2026-08-28: "why doesn't the live table scale differently per device? My
 * buttons and cards look the same no matter if I'm on a phone, or a tablet."
 *
 * Answering that needs real numbers, not arithmetic done in a comment. The
 * felt's width is not a property anyone declares — `.table-scaler` derives it
 * from the vertical space left over, through six custom properties and four
 * breakpoints — so the only honest way to know what a 768px tablet gets is to
 * lay it out in a browser at 768px and read it back.
 *
 *   node scripts/dev/measure-felt.mjs
 *   node scripts/dev/measure-felt.mjs --json
 *   node scripts/dev/measure-felt.mjs --calibrate
 *
 * THIS IS THE DEV TOOL, NOT THE GUARD. It prints the numbers so you can look at
 * them; `tests/e2e/table-proportions.spec.ts` asserts that they stay flat and
 * runs on every pull request. Both drive the SAME harness
 * (tests/e2e/support/feltHarness.mjs) so the thing you inspect and the thing CI
 * enforces can never be two different measurements.
 */

import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCss,
  buildHtml,
  PROBE,
  CALIBRATION,
  measureAll,
} from '../../tests/e2e/support/feltHarness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../');
const css = buildCss(ROOT);

const browser = await chromium.launch();
const page = await browser.newPage();

if (process.argv.includes('--calibrate')) {
  await page.setViewportSize(CALIBRATION.viewport);
  await page.setContent(buildHtml(css).replace(' table-page--embedded', ''));
  await page.addStyleTag({ content: CALIBRATION.forceBottom });
  const { feltW, feltH } = await page.evaluate(PROBE);
  const ok =
    Math.abs(feltW - CALIBRATION.expect.w) < 2 && Math.abs(feltH - CALIBRATION.expect.h) < 3;
  console.log(
    `calibration: expected ${CALIBRATION.expect.w} x ${CALIBRATION.expect.h}, got ${feltW} x ${feltH}`
  );
  console.log(ok ? 'PASS — the harness models the real cascade.' : 'FAIL');
  await browser.close();
  process.exit(ok ? 0 : 1);
}

const rows = await measureAll(page, css);
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
