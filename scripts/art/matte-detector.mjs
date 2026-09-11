/**
 * matte-detector.mjs — the white-matte detector, in Node.
 *
 * A faithful port of scripts/art/clean-shell-matte.py. That script is the
 * authority and stays: it is what an artist runs on a Mac to CLEAN a plate.
 * This file exists because the gate that keeps a matte OUT has to run on a
 * CI runner, and a GitHub runner has node and sharp (a devDependency here)
 * but no numpy and no Pillow. Installing them per run to answer one yes/no
 * question is a minute a build for something node can do in a second.
 *
 * It reports; it never writes. Cleaning stays in the Python script.
 *
 * ── WHY IT IS NOT A THRESHOLD ON "HOW WHITE IS THE EDGE" ───────────────────
 * The matte is a smooth neutral ramp at full alpha sitting OUTSIDE the frame,
 * with a torn edge where the export clipped it. The frame always begins, from
 * any outside direction, with a STRUCTURED pixel — a dark outline, a blue
 * bevel or LED, or brushed chrome. The matte never is. So the test is
 * reachability: flood inward from the transparent exterior through matte-like
 * pixels only, then trim whatever still sits past the locally smooth
 * silhouette, and repeat, because trimming a tooth exposes matte behind it.
 *
 * ── WHERE IT DIFFERS FROM THE PYTHON, AND WHY THE ANSWER IS THE SAME ───────
 * Two implementation swaps, both exact:
 *
 *   1. The 3x3 local range is computed separably (max over 3 columns, then
 *      over 3 rows). max over a 3x3 box IS max-of-row-maxes, so this is the
 *      same number, in O(n) instead of nine full-array passes.
 *   2. The flood is a breadth-first queue instead of dilate-until-fixpoint.
 *      Same reachable set by definition; O(n) instead of O(n x diameter).
 *      On a 2000px plate that is the difference between a second and minutes,
 *      which is the whole reason this port is worth having.
 *
 * tests/unit/matteDetectorPort.test.ts pins both against hand-computed cases.
 */

const STRUCT = 22.0; // local range below this is smooth matte, not brushed metal
const NEUTRAL = 5.0; // the matte is grey: |B-R| and green deviation within this
const FLOOR = 70.0; // a dark pixel is frame outline or well, never matte
const TRIM = 3; // how far past the locally smooth silhouette a pixel may sit
const PASSES = 3;
const MEDIAN_K = 41;

/** Below this fraction the art is treated as already clean. */
export const MIN_FRACTION = 0.005;

/** max (or min) of each pixel and its two horizontal neighbours, edge-replicated. */
function span1d(src, w, h, pick) {
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) {
      const a = src[r + (x > 0 ? x - 1 : 0)];
      const b = src[r + x];
      const c = src[r + (x < w - 1 ? x + 1 : w - 1)];
      out[r + x] = pick(pick(a, b), c);
    }
  }
  return out;
}

function spanVertical(src, w, h, pick) {
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    const up = (y > 0 ? y - 1 : 0) * w;
    const mid = y * w;
    const dn = (y < h - 1 ? y + 1 : h - 1) * w;
    for (let x = 0; x < w; x++) {
      out[mid + x] = pick(pick(src[up + x], src[mid + x]), src[dn + x]);
    }
  }
  return out;
}

const MAX = (a, b) => (a > b ? a : b);
const MIN = (a, b) => (a < b ? a : b);

/**
 * max-min over OPAQUE neighbours only.
 *
 * Letting transparent pixels count as black invents a hard edge along the
 * whole alpha boundary — exactly where the matte starts — and the fill would
 * stop dead on its first step. That bug cut 126 pixels off a 12% matte.
 */
function localRange(lum, opaque, w, h) {
  const n = w * h;
  const hiSrc = new Float64Array(n);
  const loSrc = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    hiSrc[i] = opaque[i] ? lum[i] : -1e6;
    loSrc[i] = opaque[i] ? lum[i] : 1e6;
  }
  const hi = spanVertical(span1d(hiSrc, w, h, MAX), w, h, MAX);
  const lo = spanVertical(span1d(loSrc, w, h, MIN), w, h, MIN);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = hi[i] - lo[i];
  return out;
}

function matteMask(rgba, w, h) {
  const n = w * h;
  const lum = new Float64Array(n);
  const opaque = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const R = rgba[i * 4], G = rgba[i * 4 + 1], B = rgba[i * 4 + 2];
    lum[i] = 0.299 * R + 0.587 * G + 0.114 * B;
    opaque[i] = rgba[i * 4 + 3] > 20 ? 1 : 0;
  }
  const range = localRange(lum, opaque, w, h);
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!opaque[i]) continue;
    const R = rgba[i * 4], G = rgba[i * 4 + 1], B = rgba[i * 4 + 2];
    const neutral = Math.abs(B - R) <= NEUTRAL && Math.abs(G - (R + B) / 2) <= NEUTRAL;
    if (neutral && range[i] < STRUCT && lum[i] > FLOOR) mask[i] = 1;
  }
  return mask;
}

/** Everything reachable from the image border through `passable`, 8-connected. */
function floodFromBorder(passable, w, h) {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let top = 0;
  const push = (i) => {
    if (!seen[i] && passable[i]) {
      seen[i] = 1;
      stack[top++] = i;
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (top > 0) {
    const i = stack[--top];
    const y = (i / w) | 0;
    const x = i - y * w;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        if (nx < 0 || nx >= w) continue;
        push(ny * w + nx);
      }
    }
  }
  return seen;
}

/** Median of each k-wide window, edge-replicated — k is odd. */
function median1d(v, k) {
  const half = (k / 2) | 0;
  const n = v.length;
  const out = new Float64Array(n);
  const win = new Float64Array(k);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < k; j++) {
      let s = i + j - half;
      if (s < 0) s = 0;
      else if (s > n - 1) s = n - 1;
      win[j] = v[s];
    }
    const sorted = Array.prototype.slice.call(win).sort((a, b) => a - b);
    out[i] = sorted[half];
  }
  return out;
}

function medianOf(values) {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Opaque pixels sitting past the median-smoothed silhouette on any side.
 *
 * A median filter reproduces a straight ramp exactly, so the 45-degree
 * chamfers survive untouched while an outlier tooth is clipped.
 */
function ragged(op, w, h, tol) {
  const bad = new Uint8Array(w * h);

  const sweep = (n, len, lineAt, last, apply) => {
    const prof = new Float64Array(n);
    const known = [];
    for (let i = 0; i < n; i++) {
      let found = -1;
      if (last) {
        for (let j = len - 1; j >= 0; j--) if (op[lineAt(i, j)]) { found = j; break; }
      } else {
        for (let j = 0; j < len; j++) if (op[lineAt(i, j)]) { found = j; break; }
      }
      prof[i] = found;
      if (found >= 0) known.push(found);
    }
    if (!known.length) return;
    const fill = medianOf(known);
    for (let i = 0; i < n; i++) if (prof[i] < 0) prof[i] = fill;
    const sm = median1d(prof, MEDIAN_K);
    apply(sm);
  };

  // Bottom and top edges: one profile per COLUMN, indexed by row.
  for (const last of [true, false]) {
    sweep(w, h, (x, y) => y * w + x, last, (sm) => {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const beyond = last ? y > sm[x] + tol : y < sm[x] - tol;
          if (beyond) bad[y * w + x] = 1;
        }
      }
    });
  }
  // Right and left edges: one profile per ROW, indexed by column.
  for (const last of [true, false]) {
    sweep(h, w, (y, x) => y * w + x, last, (sm) => {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const beyond = last ? x > sm[y] + tol : x < sm[y] - tol;
          if (beyond) bad[y * w + x] = 1;
        }
      }
    });
  }
  for (let i = 0; i < w * h; i++) if (!op[i]) bad[i] = 0;
  return bad;
}

/**
 * How much of this image the cleaner would remove, as a fraction of the
 * opaque pixels it started with. Pure: `rgba` is not modified.
 */
export function matteFraction(rgba, w, h) {
  const n = w * h;
  const out = new Uint8ClampedArray(rgba); // alpha is edited on this copy only
  let was = 0;
  for (let i = 0; i < n; i++) if (out[i * 4 + 3] > 20) was++;
  if (!was) return 0;

  const removed = new Uint8Array(n);
  for (let pass = 0; pass < PASSES; pass++) {
    const mask = matteMask(out, w, h);
    const passable = new Uint8Array(n);
    for (let i = 0; i < n; i++) passable[i] = out[i * 4 + 3] <= 20 || mask[i] ? 1 : 0;

    const reach = floodFromBorder(passable, w, h);
    for (let i = 0; i < n; i++) {
      if (reach[i] && out[i * 4 + 3] > 20) {
        out[i * 4 + 3] = 0;
        removed[i] = 1;
      }
    }

    const op = new Uint8Array(n);
    for (let i = 0; i < n; i++) op[i] = out[i * 4 + 3] > 20 ? 1 : 0;
    const rag = ragged(op, w, h, TRIM);
    for (let i = 0; i < n; i++) {
      if (rag[i]) {
        out[i * 4 + 3] = 0;
        removed[i] = 1;
      }
    }
  }

  let gone = 0;
  for (let i = 0; i < n; i++) if (removed[i]) gone++;
  return gone / was;
}

/**
 * The gate's whole decision, as a pure function so a test can pin it without
 * decoding 148 images.
 *
 * `readings`  [{ rel, pct }]           what the detector measured just now
 * `recorded`  { rel: { pct, reason } } what docs/art/matte-baseline.json holds
 * `floorPct`  number                   below this an asset needs no entry
 *
 * An asset with no entry has never read at or above the floor, so its budget
 * is one tick below the floor. An asset WITH an entry is allowed exactly what
 * was recorded and not a tick more: that is the rule that catches a re-export
 * putting the matte back, and it is the only comparison in this file.
 */
export function judgeReadings(readings, recorded, floorPct) {
  const failures = [];
  for (const r of readings) {
    const entry = recorded[r.rel];
    const allowed = entry ? entry.pct : Math.round((floorPct - 0.1) * 10) / 10;
    if (r.pct > allowed) failures.push({ rel: r.rel, pct: r.pct, allowed });
  }
  const stale = Object.keys(recorded).filter((k) => !readings.some((r) => r.rel === k));
  return { failures, stale };
}
