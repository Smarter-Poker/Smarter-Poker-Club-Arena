/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A TABLE SKIN MAY NOT PAINT SEAT POSITIONS (2026-08-29)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-28: the final table is "broken and distorted around the table
 * where the seat buttons are".
 *
 * `skin_final_table.png` is the only one of the fourteen skins that paints seat
 * furniture into the rail — gold plates with amber jewels. Its geometry is
 * fine: 605x1000 RGBA, identical to the other thirteen, and `.table-art` uses
 * `object-fit: fill`, so a wrong aspect ratio would stretch rather than
 * misalign. The problem is that the painted plates are not where
 * `SEAT_POSITIONS_9MAX` puts the seats, so every seat button lands on a plate
 * edge or on a jewel.
 *
 * Nothing caught it, because nothing has ever compared an ASSET against the
 * seat ring. It was authored that way in #1431 and shipped.
 *
 * WHAT THIS FILE MEASURES, and why it is not a guess about pixels.
 *
 * The two seats on each side rail sit at the same x (8 on the left, 92 on the
 * right) and differ only in y (25 and 58). Whatever the skin's palette, those
 * two seats land on the SAME piece of rail, so:
 *
 *   1. they must look alike     — `sideRailStep`, the luminance difference
 *                                 between them;
 *   2. the rail between them must be a smooth run, not a feature —
 *                                 `midpointDeviation`, how far the midpoint
 *                                 sits from the average of its two endpoints.
 *
 * A dark-to-bright gradient (ice cavern, neon city) satisfies (2) even when it
 * fails (1) loudly, because a gradient's midpoint IS the average. A painted
 * plate fails both: one seat is on gold, its neighbour is on bare rail, and the
 * rail between them is neither.
 *
 * MEASURED, all fourteen skins, 44x44px patches:
 *
 *   metric              healthy 13        skin_final_table
 *   sideRailStep        1 .. 52           113
 *   midpointDeviation   0.4 .. 22.9       54.7
 *
 * The thresholds below sit above every healthy skin with room to spare and
 * still fail the final table by more than half again. They are deliberately
 * loose: this is a guard against a NEW skin authored the same way, not a
 * pixel-perfect assertion about art.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

/** x,y as percentages of the skin frame — SEAT_POSITIONS_9MAX, side rails. */
const LEFT_RAIL_X = 8;
const RIGHT_RAIL_X = 92;
const SEAT_HIGH_Y = 25;
const SEAT_LOW_Y = 58;

/** Half-width of the sampled patch, in pixels of the 605x1000 frame. */
const PATCH_RADIUS = 22;

/**
 * Above the worst healthy skin (ice cavern, 52) with headroom, and well under
 * the final table (113). A skin that trips this has one side-rail seat sitting
 * on something the other one is not.
 */
const MAX_SIDE_RAIL_STEP = 70;

/**
 * Above the worst healthy skin (neon city, 22.9) with headroom, and well under
 * the final table (54.7). This is the one a gradient cannot fail, so it is the
 * one that says "painted feature" rather than "dark at one end".
 */
const MAX_MIDPOINT_DEVIATION = 35;

const SKIN_DIR = path.join(process.cwd(), 'src/assets/tables');

/** The known-bad asset. See the it.skip at the foot of this file. */
const FINAL_TABLE = 'skin_final_table.png';

// ── A PNG reader, because a test may not add a dependency for this ──────────
//
// All fourteen skins are 8-bit RGBA, non-interlaced, which is the only shape
// this handles. Anything else throws rather than guessing — a skin that is not
// in that format is itself worth knowing about.
interface Decoded {
  width: number;
  height: number;
  pixels: Buffer; // RGBA, width*height*4
}

function decodePng(buf: Buffer): Decoded {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');

  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len; // length + type + data + crc
  }

  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error(
      `unsupported PNG: depth ${bitDepth}, colorType ${colorType}, interlace ${interlace}`
    );
  }

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);

  // Un-filter, per PNG spec 9.2. `prev` is the already-reconstructed line above.
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;

    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= bpp ? prev[i - bpp] : 0;
      const x = line[i];
      let v: number;
      switch (filter) {
        case 0:
          v = x;
          break;
        case 1:
          v = x + a;
          break;
        case 2:
          v = x + b;
          break;
        case 3:
          v = x + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`unknown PNG filter ${filter} on row ${y}`);
      }
      cur[i] = v & 0xff;
    }
  }

  return { width, height, pixels: out };
}

/** Mean luminance of a PATCH_RADIUS square centred on a percentage position. */
function patchLuminance(img: Decoded, xPct: number, yPct: number): number {
  const cx = Math.round((xPct / 100) * img.width);
  const cy = Math.round((yPct / 100) * img.height);
  const x0 = Math.max(0, cx - PATCH_RADIUS);
  const x1 = Math.min(img.width, cx + PATCH_RADIUS);
  const y0 = Math.max(0, cy - PATCH_RADIUS);
  const y1 = Math.min(img.height, cy + PATCH_RADIUS);

  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * 4;
      sum += 0.299 * img.pixels[i] + 0.587 * img.pixels[i + 1] + 0.114 * img.pixels[i + 2];
      n++;
    }
  }
  return n === 0 ? 0 : sum / n;
}

interface RailReading {
  sideRailStep: number;
  midpointDeviation: number;
}

function readRails(img: Decoded): RailReading {
  let step = 0;
  let mid = 0;
  for (const x of [LEFT_RAIL_X, RIGHT_RAIL_X]) {
    const high = patchLuminance(img, x, SEAT_HIGH_Y);
    const low = patchLuminance(img, x, SEAT_LOW_Y);
    const middle = patchLuminance(img, x, (SEAT_HIGH_Y + SEAT_LOW_Y) / 2);
    step = Math.max(step, Math.abs(high - low));
    mid = Math.max(mid, Math.abs(middle - (high + low) / 2));
  }
  return { sideRailStep: step, midpointDeviation: mid };
}

const skins = fs
  .readdirSync(SKIN_DIR)
  .filter((f) => f.endsWith('.png'))
  .sort();

const reading = new Map<string, RailReading>();
const dimensions = new Map<string, string>();
for (const file of skins) {
  const img = decodePng(fs.readFileSync(path.join(SKIN_DIR, file)));
  reading.set(file, readRails(img));
  dimensions.set(file, `${img.width}x${img.height}`);
}

describe('table skins', () => {
  it('finds the skins at all', () => {
    // A rename or a move turns every assertion below into a vacuous pass.
    expect(skins.length).toBeGreaterThanOrEqual(14);
    expect(skins).toContain(FINAL_TABLE);
  });

  it('all share one frame, because object-fit: fill stretches anything else', () => {
    const frames = new Set(dimensions.values());
    expect([...frames]).toEqual(['605x1000']);
  });

  for (const file of skins) {
    // The final table is the known offender and is asserted separately below,
    // as a skipped spec, so this file is green on main while the art is
    // redrawn. Everything else must hold now.
    if (file === FINAL_TABLE) continue;

    it(`${file} leaves the side rails to the app`, () => {
      const r = reading.get(file)!;
      expect(r.sideRailStep).toBeLessThan(MAX_SIDE_RAIL_STEP);
      expect(r.midpointDeviation).toBeLessThan(MAX_MIDPOINT_DEVIATION);
    });
  }

  /**
   * UNSKIP THIS IN THE COMMIT THAT REDRAWS THE ART.
   *
   * Bug 7b, reported by Dan on 2026-08-28 and still open: skin_final_table.png
   * paints gold seat plates and amber jewels into the rail at positions that do
   * not match SEAT_POSITIONS_9MAX, so seats 3/4 and 7/8 straddle plate edges.
   * The fix is a redrawn asset — a plain premium rail that keeps the blue neon
   * and gold trim identity and drops the per-seat furniture — and that needs
   * Dan's sign-off on the look, so it is not something to improvise into
   * production.
   *
   * The spec is written now so the work is documented rather than remembered.
   * Measured today: sideRailStep 113 (limit 70), midpointDeviation 54.7
   * (limit 35).
   */
  it.skip('skin_final_table.png leaves the side rails to the app — BLOCKED on redrawn art (bug 7b)', () => {
    const r = reading.get(FINAL_TABLE)!;
    expect(r.sideRailStep).toBeLessThan(MAX_SIDE_RAIL_STEP);
    expect(r.midpointDeviation).toBeLessThan(MAX_MIDPOINT_DEVIATION);
  });

  it('still measures the final table as broken, so the skip is not forgotten', () => {
    // If someone redraws the asset without unskipping the spec above, THIS is
    // what tells them: the guard has become vacuous and the .skip should go.
    const r = reading.get(FINAL_TABLE)!;
    const stillBroken =
      r.sideRailStep >= MAX_SIDE_RAIL_STEP || r.midpointDeviation >= MAX_MIDPOINT_DEVIATION;
    expect(
      stillBroken,
      `${FINAL_TABLE} now passes the rail check (step ${r.sideRailStep.toFixed(1)}, ` +
        `midpoint ${r.midpointDeviation.toFixed(1)}). The art has been fixed — ` +
        `remove the .skip above and delete this test.`
    ).toBe(true);
  });
});
