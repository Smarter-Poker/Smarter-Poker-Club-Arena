#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  repair-table-skins — put the painted table back where the CSS says it is,
 *                       and put back the piece of racetrack line that is missing
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-08, with a screenshot of MADNESS NLH 2/5: the gold line on the
 * right-hand side of the felt is chopped into dashes with a hole in the middle.
 * It is not a rendering artefact and it is not the screenshot. It is painted that
 * way in `skin_classic_green.png`, and it has been shipping like that.
 *
 * Two separate faults, both in the artwork, both fixed here.
 *
 * ── 1. GEOMETRY ────────────────────────────────────────────────────────────────
 *
 * `TablePage.css` gives every skin ONE geometry:
 *
 *     .table-surface { left: 13.3%; top: 8.9%; width: 73.2%; height: 80.3% }
 *
 * so the painted table has to sit in the same place on all fourteen canvases.
 * Seven of them agree to the pixel. Five do not:
 *
 *     skin                 measured (opaque box)      drift from canonical
 *     arctic_white         60,14  582,983             40px right, 42px narrow
 *     ice_cavern           29,56  562,957             46px low,   79px short
 *     ocean_blue           49,24  574,981             29px right, 39px narrow
 *     neon_city            41,20  581,985             21px right, 24px narrow
 *     crimson              35,11  579,979             15px right, 20px narrow
 *
 * On the 460 CSS px the table renders at on a phone, arctic_white's 40px is a
 * visible 30px shove: the seat ring sits over the rail down one side and off it
 * down the other, and the pot lands nearer one edge than the other. Nobody had
 * measured it because the felt is a photograph and a photograph always looks
 * deliberate.
 *
 * The fix resamples each offender by the affine that maps its own opaque box onto
 * the canonical one. Lanczos, at most an 8% scale, on artwork that is already
 * displayed below 1:1 — the softening is not resolvable. What it buys is that a
 * skin change no longer moves the felt.
 *
 * `final_table` is deliberately NOT normalised: it paints gold wings outside the
 * rail, so its alpha silhouette is not its table body. See tableSkinGeometry.mjs.
 *
 * ── 2. THE LINE ────────────────────────────────────────────────────────────────
 *
 * `skin_classic_green.png`, right-hand straight, rows 255-730:
 *
 *     left  side   median line brightness 235, 3 weak rows   (a clean line)
 *     right side   median line brightness 249, 66 weak rows  — including
 *                  y=371..406 where the line is ABSENT, felt only
 *
 * 36 rows of nothing, in the middle of the straight, on one side only. Repaired
 * by interpolating each dead row from the nearest sound row above and below,
 * which is exact here because the line is a dead-vertical constant x=503 through
 * that whole stretch and the felt gradient over 36 rows is linear.
 *
 * Not mirrored from the left, which was the obvious idea and the wrong one: the
 * felt carries a left-to-right light gradient, and mirroring lands a mean error
 * of 20 luminance levels (p90 63) on rows that are currently correct.
 *
 * ── WHAT IS DELIBERATELY LEFT ALONE ────────────────────────────────────────────
 *
 * `carbon_ion` has a ragged white specular core inside its cyan tube, and a
 * symmetric break at the tube's midpoint on BOTH sides. Symmetric means designed.
 * The raggedness reads as an uneven highlight at display size, not a hole. Fixing
 * a stylistic choice because a detector flagged it is how a skin gets repainted
 * into something its author did not draw.
 *
 * ── RUNNING IT ─────────────────────────────────────────────────────────────────
 *
 *     node scripts/repair-table-skins.mjs           # report only
 *     node scripts/repair-table-skins.mjs --write   # rewrite the offenders
 *
 * Idempotent: a second --write finds nothing to do. `tests/table-skin-art-is-
 * sound.law.test.ts` fails if anything drifts back.
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getSharp,
  CANVAS_W,
  CANVAS_H,
  CANONICAL,
  CANONICAL_W,
  CANONICAL_H,
  EDGE_TOLERANCE,
  GEOMETRY_EXEMPT,
  readRGBA,
  opaqueBounds,
  edgeDrift,
  worstDrift,
  ringProfile,
  median,
  luminance,
} from './lib/tableSkinGeometry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TABLES = path.resolve(HERE, '../src/assets/tables');
const WRITE = process.argv.includes('--write');

/**
 * Line repairs are declared, never discovered. A detector that is allowed to
 * decide on its own what counts as broken art will eventually decide something
 * intentional is broken, and repaint it.
 */
const LINE_REPAIRS = [
  {
    file: 'skin_classic_green.png',
    side: 'right',
    // 0.88 of the line's own median: catches the nicks either side of the hole,
    // which are the same fault and equally visible on a phone.
    floor: 0.88,
  },
];

/**
 * A row has to be a lot better than "not broken" before it may be copied FROM.
 *
 * The first cut of this used one threshold for both, and the rebuilt stretch came
 * out visibly duller than the rest of the line: the rows either side of the hole
 * are its shoulder — dimmed to ~240 where the sound line blows out to 255 — and
 * they cleared a 0.88 bar comfortably. Interpolating between two shoulders
 * reproduces the shoulder for 36 rows and the repair reads as a grey smear.
 */
const DONOR_FLOOR = 0.97;

/** Half-width of the strip rebuilt around the line, in px. */
const REPAIR_HALF_WIDTH = 8;
/** Columns at each end of that strip that fade back into the untouched felt. */
const FEATHER = 3;

function fmtBounds(b) {
  return `${b.minX},${b.minY} ${b.maxX},${b.maxY} (${b.maxX - b.minX + 1}x${b.maxY - b.minY + 1})`;
}

async function normaliseGeometry(sharp, file, img, bounds) {
  const w = bounds.maxX - bounds.minX + 1;
  const h = bounds.maxY - bounds.minY + 1;
  const sx = CANONICAL_W / w;
  const sy = CANONICAL_H / h;

  const scaledW = Math.round(CANVAS_W * sx);
  const scaledH = Math.round(CANVAS_H * sy);
  const PAD = 240; // always larger than any shift these skins need

  const scaled = await sharp(await sharp(path.join(TABLES, file)).ensureAlpha().toBuffer())
    .resize({ width: scaledW, height: scaledH, fit: 'fill', kernel: 'lanczos3' })
    .extend({
      top: PAD,
      bottom: PAD,
      left: PAD,
      right: PAD,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .toBuffer();

  const left = Math.round(bounds.minX * sx) + PAD - CANONICAL.minX;
  const top = Math.round(bounds.minY * sy) + PAD - CANONICAL.minY;

  return sharp(scaled)
    .extract({ left, top, width: CANVAS_W, height: CANVAS_H })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * Rebuilds every row where the accent line has faded or gone, from the nearest
 * sound row above and below it.
 */
function repairLine(img, side, floor) {
  const { data, width, channels } = img;
  const profile = ringProfile(img, side);
  const strong = profile.strength.filter((v) => v > 0);
  if (!strong.length) return { repaired: [], cut: 0 };
  const m = median(strong);
  const cut = m * floor;
  const donorCut = m * DONOR_FLOOR;

  const donors = [];
  const broken = [];
  profile.strength.forEach((v, i) => {
    const y = profile.firstRow + i;
    if (v < cut) broken.push({ y, x: profile.xs[i] });
    if (v >= donorCut) donors.push({ y, x: profile.xs[i] });
  });
  if (!broken.length || donors.length < 2) return { repaired: [], cut };

  const soundY = donors.map((s) => s.y);
  const xAt = new Map(donors.map((s) => [s.y, s.x]));

  const px = (x, y, c) => data[(y * width + x) * channels + c];
  const setPx = (x, y, c, v) => {
    data[(y * width + x) * channels + c] = Math.max(0, Math.min(255, Math.round(v)));
  };

  for (const { y } of broken) {
    // nearest sound rows either side
    let above = null;
    let below = null;
    for (let i = soundY.length - 1; i >= 0; i -= 1) {
      if (soundY[i] < y) {
        above = soundY[i];
        break;
      }
    }
    for (let i = 0; i < soundY.length; i += 1) {
      if (soundY[i] > y) {
        below = soundY[i];
        break;
      }
    }
    if (above === null && below === null) continue;
    const yA = above ?? below;
    const yB = below ?? above;
    const t = yB === yA ? 0 : (y - yA) / (yB - yA);
    const xA = xAt.get(yA);
    const xB = xAt.get(yB);
    const xHere = Math.round(xA + (xB - xA) * t);

    for (let dx = -REPAIR_HALF_WIDTH; dx <= REPAIR_HALF_WIDTH; dx += 1) {
      const x = xHere + dx;
      if (x < 0 || x >= width) continue;
      const xa = xA + dx;
      const xb = xB + dx;
      if (xa < 0 || xa >= width || xb < 0 || xb >= width) continue;

      const outside = Math.abs(dx) - (REPAIR_HALF_WIDTH - FEATHER);
      const weight = outside <= 0 ? 1 : Math.max(0, 1 - outside / (FEATHER + 1));
      if (weight <= 0) continue;

      for (let c = 0; c < 3; c += 1) {
        const rebuilt = px(xa, yA, c) * (1 - t) + px(xb, yB, c) * t;
        setPx(x, y, c, px(x, y, c) * (1 - weight) + rebuilt * weight);
      }
    }
  }

  return { repaired: broken.map((b) => b.y), cut };
}

/**
 * Repairing raises the line's median brightness, which can pull a row that was
 * a whisker above the cut to a whisker below it. Two passes settle it; the cap
 * is there so a pathological input cannot spin. Running to a fixed point is what
 * makes `--write` idempotent, and idempotent is what lets the test assert the
 * committed bytes are the finished ones.
 */
const MAX_LINE_PASSES = 4;

function repairLineToFixedPoint(img, side, floor) {
  let total = 0;
  for (let pass = 0; pass < MAX_LINE_PASSES; pass += 1) {
    const { repaired } = repairLine(img, side, floor);
    if (!repaired.length) break;
    total += repaired.length;
  }
  return total;
}

async function main() {
  const sharp = await getSharp();
  if (!sharp) {
    console.error('[repair-table-skins] sharp unavailable — nothing measured, nothing written.');
    process.exit(1);
  }
  const files = (await readdir(TABLES)).filter((f) => f.endsWith('.png')).sort();
  let changed = 0;

  for (const file of files) {
    const stem = file.replace(/\.png$/, '');
    const img = await readRGBA(path.join(TABLES, file));
    const bounds = opaqueBounds(img);
    const drift = worstDrift(bounds);
    const exempt = GEOMETRY_EXEMPT.has(stem);
    const needsGeometry = !exempt && drift > EDGE_TOLERANCE;
    const repair = LINE_REPAIRS.find((r) => r.file === file);

    const notes = [`${fmtBounds(bounds)} drift ${drift}px`];
    if (exempt) notes.push('geometry-exempt');

    let buffer = null;

    if (needsGeometry) {
      const d = edgeDrift(bounds);
      notes.push(`NORMALISE (l${d.left} t${d.top} r${d.right} b${d.bottom})`);
      buffer = await normaliseGeometry(sharp, file, img, bounds);
    }

    if (repair) {
      // Repair runs on whatever geometry pass produced, so the two compose.
      const src = buffer
        ? await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
        : null;
      const target = src
        ? {
            data: src.data,
            width: src.info.width,
            height: src.info.height,
            channels: src.info.channels,
          }
        : img;
      const repaired = repairLineToFixedPoint(target, repair.side, repair.floor);
      if (repaired) {
        notes.push(`LINE +${repaired} rows (${repair.side})`);
        buffer = await sharp(target.data, {
          raw: { width: target.width, height: target.height, channels: target.channels },
        })
          .png({ compressionLevel: 9 })
          .toBuffer();
      } else {
        notes.push('line sound');
      }
    }

    console.log(`${stem.padEnd(24)} ${notes.join('  ')}`);

    if (buffer && WRITE) {
      await sharp(buffer).toFile(path.join(TABLES, file));
      changed += 1;
    } else if (buffer) {
      changed += 1;
    }
  }

  console.log(
    WRITE
      ? `\nrewrote ${changed} skin${changed === 1 ? '' : 's'}`
      : `\n${changed} skin${changed === 1 ? '' : 's'} would change — re-run with --write`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
