/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A TABLE SKIN MAY NOT PAINT SEAT POSITIONS (2026-08-29)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-28: the final table is "broken and distorted around the table
 * where the seat buttons are".
 *
 * `skin_final_table.png` WAS the only one of the fourteen skins that painted
 * seat furniture into the rail — gold plates with amber jewels. Its geometry
 * was fine: 605x1000 RGBA, identical to the other thirteen, and `.table-art`
 * uses `object-fit: fill`, so a wrong aspect ratio would stretch rather than
 * misalign. The problem was that the painted plates were not where
 * `SEAT_POSITIONS_9MAX` puts the seats, so every seat button landed on a
 * plate edge or on a jewel. The plates were removed on 2026-08-29 with Dan's
 * approval; this file is what stops the next skin arriving the same way.
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
import { decodePng, type DecodedPng } from './helpers/png';

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

/** The asset this file was written for. See the note at the foot. */
const FINAL_TABLE = 'skin_final_table.png';

/** Mean luminance of a PATCH_RADIUS square centred on a percentage position. */
function patchLuminance(img: DecodedPng, xPct: number, yPct: number): number {
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

function readRails(img: DecodedPng): RailReading {
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
    it(`${file} leaves the side rails to the app`, () => {
      const r = reading.get(file)!;
      expect(r.sideRailStep).toBeLessThan(MAX_SIDE_RAIL_STEP);
      expect(r.midpointDeviation).toBeLessThan(MAX_MIDPOINT_DEVIATION);
    });
  }

  /**
   * THE FINAL TABLE WAS THE ONE THIS FILE WAS WRITTEN FOR, and it is fixed.
   *
   * Bug 7b, reported by Dan on 2026-08-28: gold seat plates and amber jewels
   * painted into the rail at positions SEAT_POSITIONS_9MAX does not use, so
   * seats 3/4 and 7/8 straddled plate edges. The spec above ran skipped for
   * one commit while the art was decided, and Dan approved the cleaned asset
   * on 2026-08-29 -- so the `.skip` is gone in the same commit that ships it,
   * and the final table is asserted by the loop above like every other skin.
   *
   *   sideRailStep        113  ->  32.2   (limit 70)
   *   midpointDeviation  54.7  ->  15.1   (limit 35)
   *
   * The plates were removed by scripts/dev/remove-final-table-plates.py, which
   * rebuilds the rail from its own material at the same distance from the
   * table's spine. The blue neon is explicitly protected and untouched, and
   * alpha is bit-identical, so the silhouette is the original.
   */
});
