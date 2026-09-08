/**
 * LAW: every table skin paints the table where the CSS says it is, and paints
 *      the whole racetrack line.
 * ═══════════════════════════════════════════════════════════════════════════
 * Added 2026-09-08, after Dan sent a screenshot of MADNESS NLH 2/5 with the gold
 * line down the right-hand side of the felt chopped into dashes. Nothing was
 * wrong with the renderer. `skin_classic_green.png` had 36 rows — y=371 to y=406
 * — with no line painted at all, plus a scatter of nicks either side of them,
 * and it had been shipping like that. A photograph of a table always looks
 * deliberate, so nobody had measured one.
 *
 * Measuring them turned up the larger fault underneath. `TablePage.css` gives all
 * fourteen skins ONE geometry —
 *
 *     .table-surface { left: 13.3%; top: 8.9%; width: 73.2%; height: 80.3% }
 *     .table-art     { object-fit: fill }
 *
 * — so the painted table has to occupy the same box on every 605x1000 canvas.
 * Seven skins agreed to the pixel. Five did not: arctic_white sat 40px right and
 * 42px narrow, ice_cavern 46px low and 79px short, ocean_blue 29px right,
 * neon_city 22px right, crimson 15px right. At the ~460 CSS px a phone renders
 * the table at, arctic_white's 40px is a visible shove — the seat ring over the
 * rail on one side and off it on the other, the pot nearer one edge than the
 * other — and it changed depending on which skin the player had chosen, which is
 * the kind of bug that gets reported as "the table looks weird sometimes".
 *
 * Both were corrected by `scripts/repair-table-skins.mjs`. This is what stops
 * them coming back, and what a NEW skin has to satisfy before it can ship.
 *
 * THE TWO THRESHOLDS ARE DIFFERENT ON PURPOSE.
 *   - geometry: 8px on any edge (~1.3%). Loose enough to leave the four skins
 *     that sit a pixel or two out alone rather than resample them for nothing.
 *   - line: 55% of the line's OWN median brightness, and only a run of 6+ rows
 *     counts. That is a hole, not a highlight. carbon_ion's cyan tube is
 *     deliberately segmented and its specular core is deliberately ragged; a
 *     tighter bar would fail it and the next agent would "fix" a design.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  CANVAS_W,
  CANVAS_H,
  CANONICAL,
  EDGE_TOLERANCE,
  GEOMETRY_EXEMPT,
  LINE_EXEMPT,
  getSharp,
  readRGBA,
  opaqueBounds,
  edgeDrift,
  worstDrift,
  ringProfile,
  deadRuns,
} from '../scripts/lib/tableSkinGeometry.mjs';

const TABLES = join(__dirname, '..', 'src', 'assets', 'tables');
const skins = readdirSync(TABLES)
  .filter((f) => f.endsWith('.png'))
  .sort();

/** A run shorter than this is texture. Longer is a hole you can see from a seat. */
const MAX_DEAD_RUN = 6;

const sharpAvailable = await getSharp();

describe.skipIf(!sharpAvailable)('table skin art is sound', () => {
  it('ships fourteen skins, so a deletion is not silent', () => {
    expect(skins.length).toBe(14);
  });

  it.each(skins)('%s is a 605x1000 canvas', async (file) => {
    const img = await readRGBA(join(TABLES, file));
    expect(img).not.toBeNull();
    expect([img!.width, img!.height]).toEqual([CANVAS_W, CANVAS_H]);
  });

  it.each(skins)('%s paints its table where .table-surface expects it', async (file) => {
    const stem = file.replace(/\.png$/, '');
    if (GEOMETRY_EXEMPT.has(stem)) return; // see tableSkinGeometry.mjs

    const img = await readRGBA(join(TABLES, file));
    const bounds = opaqueBounds(img!);
    const drift = edgeDrift(bounds);

    expect(
      worstDrift(bounds),
      `${stem} opaque box ${bounds.minX},${bounds.minY} ${bounds.maxX},${bounds.maxY} ` +
        `drifts l${drift.left} t${drift.top} r${drift.right} b${drift.bottom} from canonical ` +
        `${CANONICAL.minX},${CANONICAL.minY} ${CANONICAL.maxX},${CANONICAL.maxY}. ` +
        `Run: node scripts/repair-table-skins.mjs --write`
    ).toBeLessThanOrEqual(EDGE_TOLERANCE);
  });

  it.each(skins)('%s has no hole in its racetrack line', async (file) => {
    const stem = file.replace(/\.png$/, '');
    const exempt: string[] = (LINE_EXEMPT as Record<string, string[]>)[stem] ?? [];
    const img = await readRGBA(join(TABLES, file));
    for (const side of ['left', 'right'] as const) {
      if (exempt.includes(side)) continue; // see LINE_EXEMPT for why
      const holes = deadRuns(ringProfile(img!, side)).filter((r) => r.length > MAX_DEAD_RUN);
      expect(
        holes,
        `${file} ${side} side: the accent line vanishes for ` +
          holes.map((h) => `${h.length} rows at y=${h.from}..${h.to}`).join(', ')
      ).toEqual([]);
    }
  });

  it('classic_green keeps the right-hand line Dan reported', async () => {
    // Pinned by name and side rather than by phrasing, so the regression this
    // was written for cannot come back wearing a different threshold.
    const img = await readRGBA(join(TABLES, 'skin_classic_green.png'));
    const right = ringProfile(img!, 'right');
    const left = ringProfile(img!, 'left');
    expect(deadRuns(right, 0.7)).toEqual([]);
    // and it is no patchier than the side that was always correct
    const weak = (p: typeof right) => {
      const sorted = [...p.strength].sort((a, b) => a - b);
      const med = sorted[Math.floor(sorted.length / 2)];
      return p.strength.filter((v) => v < med * 0.88).length;
    };
    expect(weak(right)).toBeLessThanOrEqual(weak(left) + 3);
  });
});
