#!/usr/bin/env node
/**
 * check-asset-matte.mjs — no asset ships a baked white matte again.
 *
 * ── WHAT WENT WRONG, AND WHY A GATE ───────────────────────────────────────
 * Several painted shells were exported with their glow rendered as WHITE
 * rather than cut out: a smooth neutral ramp at full alpha sitting outside
 * the frame, with a torn dashed edge where the export clipped it. The top of
 * a plate looked right because the art was cropped flush there; the bottom
 * and sides carried the matte, and it reached production. Four plates were
 * cleaned by hand on 2026-09-10 (club-nav-shell 12.7%, wallet-row-shell 3.0%,
 * club-utility-shell 2.8%, wallet-agent-wallet-square 0.6%). Nothing stopped
 * the next export from putting it straight back.
 *
 * ── WHY THIS IS A RECORDED BASELINE AND NOT A THRESHOLD ───────────────────
 * The obvious gate — "fail any asset the detector wants to cut" — was
 * measured against the whole corpus on 2026-09-11 before it was written, and
 * it does not work. 148 assets under public/assets: 115 read exactly 0.0%,
 * 142 read under 0.5%, and every one of the six that read above it is the
 * detector eating ARTWORK, confirmed one at a time:
 *
 *   club-identity-icon-club-v1.png     7.8% — cleaning slices the pediment,
 *                                             a column and the plinth off the
 *                                             temple. Re-checking the cleaned
 *                                             file reads 12.0%: it diverges,
 *                                             which is the signature of the
 *                                             detector eating art.
 *   console/spade-console-v1/mid.png   4.2% — deletes 5 whole columns of a
 *                                             1000x8 tiling rail. Tiled, that
 *                                             is five transparent slits.
 *   club-identity-icon-player-v1.png   2.8% — converges numerically, and the
 *                                             picture shows the head outline
 *                                             and shoulder bevel chewed away.
 *                                             Convergence is necessary, not
 *                                             sufficient. Look at the art.
 *   shark-four-bay-v1/live-dot.png     0.7% — 23 pixels of mean luminance 20.
 *                                             Dark glow, not white matte.
 *   mobile/wallet-union-bank-v1.webp   0.6% — 3780 bright silver pixels, NONE
 *                                             within 4px of the border, spread
 *                                             across the interior. Frame
 *                                             highlights. A matte hugs the
 *                                             edge; this is the opposite.
 *   square/wallet-promo-...-v1.png     0.5% — under the cleaner's own floor,
 *                                             so the cleaner writes nothing.
 *
 * So the reading is not a verdict. What IS a verdict is a reading that goes
 * UP. A plate that reads 0.0% today and 12.7% after an export has had the
 * matte put back, and no judgement call is needed to say so. This file
 * records each asset's measured reading and fails when one rises above it.
 *
 * Consequences, deliberately:
 *   - zero false failures on the corpus as it stands, by construction;
 *   - the exact regression that shipped cannot return silently;
 *   - a legitimately re-exported asset needs --update, and the change then
 *     shows up as a diff in the pull request, where a human reads it.
 *
 * ── SCOPE ─────────────────────────────────────────────────────────────────
 * public/assets/** only: the #ClubArenaConsole master art, where the problem
 * happened. public/cards, public/images/throwables and the rest are a
 * different pipeline and 681 more files; scanning them costs about ninety
 * seconds and buys nothing this gate is for.
 *
 *   node scripts/art/check-asset-matte.mjs            # gate: exit 1 on a rise
 *   node scripts/art/check-asset-matte.mjs --update   # re-record the baseline
 *   node scripts/art/check-asset-matte.mjs --list     # print every reading
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSharp } from '../lib/sharp-loader.mjs';
import { matteFraction, judgeReadings, MIN_FRACTION } from './matte-detector.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const SCAN = path.join(ROOT, 'public/assets');
const BASELINE = path.join(ROOT, 'docs/art/matte-baseline.json');

/** Readings below this need no baseline entry — 115 of 148 assets read 0.0%. */
const FLOOR = MIN_FRACTION; // 0.5%, the same number the cleaner writes at

const args = process.argv.slice(2);
const UPDATE = args.includes('--update');
const LIST = args.includes('--list');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (/\.(png|webp)$/i.test(name)) out.push(p);
  }
  return out;
}

/** One decimal place, so a baseline is stable against encoder noise. */
const pct = (frac) => Math.round(frac * 1000) / 10;

const sharp = await loadSharp();
if (!sharp) {
  // A guard that passes when its detector is missing is not a guard.
  console.error('check-asset-matte: sharp could not be loaded - cannot judge the art.');
  process.exit(1);
}

const files = walk(SCAN);
const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
const recorded = baseline.assets ?? {};

const readings = [];
for (const abs of files) {
  const rel = path.relative(ROOT, abs);
  const { data, info } = await sharp(abs)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  readings.push({ rel, pct: pct(matteFraction(data, info.width, info.height)) });
}

if (LIST) {
  for (const r of [...readings].sort((a, b) => b.pct - a.pct)) {
    console.log(`${r.pct.toFixed(1).padStart(6)}%  ${r.rel}`);
  }
  process.exit(0);
}

const floorPct = pct(FLOOR);

if (UPDATE) {
  const next = {};
  for (const r of readings) {
    if (r.pct < floorPct) continue;
    next[r.rel] = {
      pct: r.pct,
      reason:
        recorded[r.rel]?.reason ??
        'TODO: say what you looked at, and why the art is right as it is.',
    };
  }
  const merged = { ...baseline, generated: new Date().toISOString().slice(0, 10), assets: next };
  writeFileSync(BASELINE, `${JSON.stringify(merged, null, 2)}\n`);
  const rel = path.relative(ROOT, BASELINE);
  console.log(`check-asset-matte: recorded ${Object.keys(next).length} reading(s) into ${rel}`);
  const todo = Object.entries(next).filter(([, v]) => v.reason.startsWith('TODO'));
  if (todo.length) {
    console.error(`\n${todo.length} entry(ies) still need a reason before this can be reviewed:`);
    for (const [k] of todo) console.error(`  ${k}`);
    process.exit(1);
  }
  process.exit(0);
}

const { failures, stale } = judgeReadings(readings, recorded, floorPct);

if (!failures.length && !stale.length) {
  console.log(
    `check-asset-matte: ${readings.length} asset(s) scanned, none carries a matte it did not already carry.`,
  );
  process.exit(0);
}

for (const f of failures) {
  console.error(
    `::error file=${f.rel}::${f.rel} reads ${f.pct.toFixed(1)}% matte, above its recorded ${f.allowed.toFixed(1)}%.`,
  );
}
for (const k of stale) {
  console.error(`::error::${k} is recorded in the baseline but no longer exists - run --update.`);
}

if (failures.length) {
  console.error(`
${failures.length} asset(s) read higher than recorded. That means one of two things:

  1. AN EXPORT PUT THE WHITE MATTE BACK. This is the common case and the
     reason this check exists. Clean it:
         python3 scripts/art/clean-shell-matte.py <file.png>
     re-encode the .webp beside it if one ships, and re-run this check. The
     reading should return to what the baseline records.

  2. THE DETECTOR IS EATING ARTWORK. It does - six confirmed cases are named
     in the header of this file. Prove it before you record it: clean a COPY,
     look at the before and after side by side, and check whether re-running
     the detector on the cleaned copy CONVERGES to ~0 (a real matte) or does
     not (artwork). Then run --update and write the reason in the baseline. A
     reason that does not say what was looked at is not a reason.
`);
}
process.exit(1);
