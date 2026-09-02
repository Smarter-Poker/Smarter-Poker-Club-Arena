/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  NO TABLE SKIN MAY CARRY A WHITE MATTE (2026-08-29)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-29: "ALL THAT WHITE EDGING AROUND THE TABLES MUST NEVER BE
 * THERE EITHER."
 *
 * WHAT IT WAS. Seven of the fourteen skins were exported from a tool that
 * composited them against WHITE and then wrote an alpha channel. The opaque
 * interior is fine, but every partially transparent pixel on the silhouette
 * kept its white RGB — and so did the first fully-opaque ring behind it. Over
 * the app's dark background those pixels composite as a white halo tracing the
 * entire table.
 *
 * WHAT IS MEASURED, and why it is not "how white is the edge". A pale gold
 * rail is legitimately near-white, so counting white pixels condemns golden
 * sand forever and teaches everyone to ignore the test. What a matte actually
 * looks like is an edge that does not belong to the picture behind it: compare
 * each partially-transparent pixel's luminance with the SOLID artwork within
 * two pixels of it. Correct anti-aliasing reads about zero. A white matte
 * reads +50 to +150.
 *
 * MEASURED, all fourteen skins, before and after the repair:
 *
 *     jade city         148.0  ->  -1.0        crimson            -2.5
 *     electric purple   116.5  ->  -1.2        mahogany red       -2.0
 *     classic green     103.2  ->   0.0        ocean blue         -1.4
 *     carbon red        101.7  ->   0.6        final table         8.3
 *     carbon ion         83.0  ->   0.0        neon city           8.4
 *     amethyst cavern    74.3  ->  -0.0        arctic white       10.6
 *     golden sand        51.7  ->   1.9        ice cavern        -72.0
 *
 * THE LIMIT IS ONE-SIDED, and that is deliberate. Ice cavern reads -72: its
 * outer edge is much DARKER than the artwork behind it. That is a painted
 * shadow, it is art, and "no white edging" is not "every edge must be
 * neutral". Only a BRIGHT edge is the defect.
 *
 * The repair is scripts/dev/table-skin-defringe.py: it bleeds the artwork's
 * own colour outward into the edge pixels and never touches alpha, so the
 * silhouette and the soft edge are bit-identical.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

import { decodePng, luminanceAt, alphaAt, type DecodedPng } from './helpers/png';

const SKIN_DIR = path.join(process.cwd(), 'src/assets/tables');

/** Partially transparent: neither clearly inside the table nor clearly outside. */
const EDGE_LO = 12;
const EDGE_HI = 243;
/** Opaque enough to be trusted as "this is what the artwork looks like here". */
const SOLID = 250;

/**
 * Above every repaired skin (worst is golden sand at 1.9) with a wide margin,
 * and far below every skin that had the defect (lowest was golden sand at
 * 51.7). Loose on purpose: this catches an export with a matte, it is not a
 * pixel assertion about art.
 */
const MAX_HALO = 20;

/** How much brighter the edge pixels are than the solid artwork beside them. */
function halo(img: DecodedPng): number {
  let total = 0;
  let n = 0;
  for (let y = 2; y < img.height - 2; y++) {
    for (let x = 2; x < img.width - 2; x++) {
      const a = alphaAt(img, x, y);
      if (a <= EDGE_LO || a >= EDGE_HI) continue;

      let near = 0;
      let cnt = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (alphaAt(img, x + dx, y + dy) >= SOLID) {
            near += luminanceAt(img, x + dx, y + dy);
            cnt++;
          }
        }
      }
      if (cnt === 0) continue;
      total += luminanceAt(img, x, y) - near / cnt;
      n++;
    }
  }
  return n === 0 ? 0 : total / n;
}

const skins = fs
  .readdirSync(SKIN_DIR)
  .filter((f) => f.endsWith('.png'))
  .sort();

describe('table skins carry no white matte', () => {
  it('finds the skins at all', () => {
    // A rename or a move turns every assertion below into a vacuous pass.
    expect(skins.length).toBeGreaterThanOrEqual(14);
  });

  for (const file of skins) {
    it(`${file} has no bright edge`, () => {
      const img = decodePng(fs.readFileSync(path.join(SKIN_DIR, file)));
      const h = halo(img);
      expect(
        h,
        `${file} edge reads ${h.toFixed(1)} brighter than the artwork behind it — ` +
          `that is a white matte. Fix it with ` +
          `python3 scripts/dev/table-skin-defringe.py --apply`
      ).toBeLessThan(MAX_HALO);
    });
  }
});
