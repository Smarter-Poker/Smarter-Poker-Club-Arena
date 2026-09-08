/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  tableSkinGeometry — what a table skin has to be, measured rather than assumed
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Every table skin is a 605x1000 transparent PNG of the SAME physical table in a
 * different material. `TablePage.css` positions everything that lands on the felt
 * from ONE set of constants:
 *
 *     .table-surface { left: 13.3%; top: 8.9%; width: 73.2%; height: 80.3% }
 *     .table-art     { object-fit: fill }
 *
 * There is no per-skin offset and there must not be one. So the painted table has
 * to occupy the same box on the canvas in every skin, or the board cards, the pot,
 * the dealer button and the seat ring drift off the felt when you change skins.
 *
 * CANONICAL is not a number somebody chose. Seven skins — amethyst_cavern,
 * carbon_ion, electric_purple, golden_sand, jade_city and their neighbours — agree
 * on it to the pixel, which is what a master render looks like when only the
 * material changed. It is measured on ALPHA >= 250 (the hard table edge) and not
 * on any softer threshold, because several skins carry an outer glow whose extent
 * is a styling choice and not the table.
 *
 * TOLERANCE is 8px on any edge, ~1.3% of the canvas. Wide enough that the four
 * skins sitting a pixel or two out are left alone rather than resampled for
 * nothing; tight enough that arctic_white (40px) and ice_cavern (46px) cannot hide
 * in it.
 *
 * Shared by `scripts/repair-table-skins.mjs` (which corrects the art) and
 * `tests/table-skin-art-is-sound.law.test.ts` (which stops it drifting again).
 */

import { loadSharp } from './sharp-loader.mjs';

/**
 * sharp is optional here for the same reason it is optional everywhere else in
 * this repo — a production `npm install` prunes it. `sharp-loader` says so and
 * hands back null rather than throwing; every caller has to cope, including the
 * test, which skips rather than failing a build over a missing image codec.
 */
let sharpPromise = null;
export function getSharp() {
  if (!sharpPromise) sharpPromise = loadSharp();
  return sharpPromise;
}

export const CANVAS_W = 605;
export const CANVAS_H = 1000;

/** Hard table edge, measured across the seven skins that agree. */
export const CANONICAL = { minX: 20, minY: 10, maxX: 584, maxY: 989 };
export const CANONICAL_W = CANONICAL.maxX - CANONICAL.minX + 1; // 565
export const CANONICAL_H = CANONICAL.maxY - CANONICAL.minY + 1; // 980

/** Per-edge slack before a skin counts as misplaced. */
export const EDGE_TOLERANCE = 8;

/** Opaque means opaque. A soft glow is not the table. */
export const OPAQUE = 250;

/**
 * `final_table` is excluded from the geometry assertion on purpose. It paints
 * decorative gold wings above and below the rail, so its alpha silhouette is not
 * the table body and normalising against it would squash the table to make room
 * for an ornament. Its body measures 551x983 centred within 2px — visually sound.
 * It is still checked for line continuity like every other skin.
 */
export const GEOMETRY_EXEMPT = new Set(['skin_final_table']);

/** Reads a PNG once and hands back raw RGBA plus its dimensions. */
export async function readRGBA(file) {
  const sharp = await getSharp();
  if (!sharp) return null;
  const { data, info } = await sharp(file)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

/** Bounding box of everything at or above `OPAQUE` alpha. */
export function opaqueBounds({ data, width, height, channels }) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * channels + 3] < OPAQUE) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY };
}

/** Signed per-edge drift from canonical. Positive means "inside" canonical. */
export function edgeDrift(bounds) {
  return {
    left: bounds.minX - CANONICAL.minX,
    top: bounds.minY - CANONICAL.minY,
    right: CANONICAL.maxX - bounds.maxX,
    bottom: CANONICAL.maxY - bounds.maxY,
  };
}

export function worstDrift(bounds) {
  const d = edgeDrift(bounds);
  return Math.max(Math.abs(d.left), Math.abs(d.top), Math.abs(d.right), Math.abs(d.bottom));
}

export const luminance = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

/**
 * Sides where a row scan is not measuring a racetrack stripe, and why. Every
 * other skin and side is asserted continuous.
 *
 * These are art facts, established by looking at the pixels, not by shrugging at
 * a red test. Both were found the first time this law ran.
 */
export const LINE_EXEMPT = {
  // A cyan neon tube that stops, caps off, and starts again at the table's
  // midpoint — SYMMETRICALLY, on both sides, at the same rows. Symmetric is
  // what design looks like; damage lands on one side, as classic_green's did.
  skin_carbon_ion: ['left', 'right'],
  // No stripe on that side at all: a broad, deliberately uneven ice glow. A
  // brightness scan across it measures the texture and calls the dark veins
  // holes.
  skin_ice_cavern: ['left'],
};

/**
 * Walks the accent line — the racetrack stripe just inside the rail — down one
 * side of the straight section and reports how bright it is on every row.
 *
 * 300..700 and not the full 255..730 the table is straight over: at the ends of
 * that wider range the stripe has begun to bend, a row scan follows the bend out
 * of its window, and electric_purple was reported as having a 7-row hole in a
 * stripe that is intact. Narrower window, no false positive, and still 400 rows
 * of straight — classic_green's real 36-row hole sits in the middle of it.
 */
export const STRAIGHT_TOP = 300;
export const STRAIGHT_BOTTOM = 700;
const RING_NEAR = 40; // px inside the table edge where the ring starts
const RING_FAR = 130; //           …and where it has certainly ended

export function ringProfile(img, side) {
  const { data, width, channels } = img;
  const xs = [];
  const strength = [];
  for (let y = STRAIGHT_TOP; y <= STRAIGHT_BOTTOM; y += 1) {
    let edge = -1;
    if (side === 'left') {
      for (let x = 0; x < width; x += 1) {
        if (data[(y * width + x) * channels + 3] >= OPAQUE) {
          edge = x;
          break;
        }
      }
    } else {
      for (let x = width - 1; x >= 0; x -= 1) {
        if (data[(y * width + x) * channels + 3] >= OPAQUE) {
          edge = x;
          break;
        }
      }
    }
    if (edge < 0) {
      xs.push(-1);
      strength.push(0);
      continue;
    }
    let bestX = -1;
    let best = -1;
    for (let k = RING_NEAR; k < RING_FAR; k += 1) {
      const x = side === 'left' ? edge + k : edge - k;
      if (x < 0 || x >= width) continue;
      const i = (y * width + x) * channels;
      const v = luminance(data[i], data[i + 1], data[i + 2]);
      if (v > best) {
        best = v;
        bestX = x;
      }
    }
    xs.push(bestX);
    strength.push(best);
  }
  return { xs, strength, firstRow: STRAIGHT_TOP };
}

export function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

/**
 * Rows where the line all but disappears, grouped into runs.
 *
 * `floor` is a fraction of the line's own median brightness, so it works the same
 * on a 250-luminance gold stripe and on a 40-luminance carbon one. A skin whose
 * ring is genuinely dim has a dim median and is judged against that.
 */
export function deadRuns(profile, floor = 0.55) {
  const cut = median(profile.strength) * floor;
  const runs = [];
  let start = null;
  profile.strength.forEach((v, i) => {
    const y = profile.firstRow + i;
    if (v < cut) {
      if (start === null) start = y;
    } else if (start !== null) {
      runs.push({ from: start, to: y - 1, length: y - start });
      start = null;
    }
  });
  if (start !== null) {
    const last = profile.firstRow + profile.strength.length - 1;
    runs.push({ from: start, to: last, length: last - start + 1 });
  }
  return runs;
}
