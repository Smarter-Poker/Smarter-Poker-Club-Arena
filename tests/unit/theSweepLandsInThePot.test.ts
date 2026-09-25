/**
 * THE SWEEP LANDS IN THE POT (Dan 2026-09-23)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "THE CHIPS ARE NOT BEING MOVED OR 'SHIPPED' TO THE CORRECT POSITION OR
 * PLAYER AFTER A HAND IS COMPLETED."
 *
 * At the end of every street the seats' bet chips sweep "into the pot". The
 * sweep converged on `feltCenter()` - the middle of the felt, y 49% of the
 * scaler - while the pot pill has stood at y 23% since 2026-08-28 (Dan: the
 * pot moved so the top seat's bets never touch it). Every hand, every bet
 * flew to a point a quarter of the table BELOW the pill, vanished there, and
 * the pill shipped to the winner from somewhere else. The pot-to-winner
 * flights already aimed at the pill through a constant in TablePage.tsx; the
 * collect never heard, because its anchor was a different function in a
 * different file with a comment that still said "the pot is in the middle".
 *
 * One anchor now, POT_ANCHOR_PCT in tableGeometry.ts, for chips going in and
 * chips coming out. This pins three things: the anchor mirrors the two CSS
 * declarations that actually place the pill; the sweep converges on it and
 * not on the felt's centre; and the page reads the same constant.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  betChipOffsetPx,
  chipCollectOffsetPx,
  feltCenter,
  POT_ANCHOR_PCT,
  CHIP_COLLECT_FRACTION,
} from '../../src/components/table/tableGeometry';
import { SEAT_LAYOUTS } from '../../src/lib/tableSeatGeometry';

const ROOT = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

describe('the anchor is the pill', () => {
  it('mirrors .pot-area left in TablePage.css and top in TableVisualHotfix.css', () => {
    const base = strip(read('src/pages/TablePage.css'));
    const potArea = base.slice(
      base.indexOf('.pot-area {'),
      base.indexOf('}', base.indexOf('.pot-area {'))
    );
    expect(potArea).toMatch(new RegExp(`left:\\s*${POT_ANCHOR_PCT.x}%`));
    const hotfix = strip(read('src/components/table/TableVisualHotfix.css'));
    const at = hotfix.indexOf('.table-page .pot-area {');
    expect(at).toBeGreaterThanOrEqual(0);
    const rule = hotfix.slice(at, hotfix.indexOf('}', at));
    expect(rule).toMatch(new RegExp(`top:\\s*${POT_ANCHOR_PCT.y}% !important`));
  });

  it('is not the middle of the felt - that was the bug', () => {
    const c = feltCenter();
    expect(Math.abs(c.y - POT_ANCHOR_PCT.y)).toBeGreaterThan(20);
  });

  it('the page aims its flights at the same constant, not a copy', () => {
    const page = read('src/pages/TablePage.tsx');
    expect(page).not.toMatch(/const POT_ANCHOR_PCT\s*=/);
    expect(page).toMatch(
      /import \{[^}]*\bPOT_ANCHOR_PCT\b[^}]*\} from '\.\.\/components\/table\/tableGeometry'/
    );
  });
});

describe('the sweep converges on the pot from every seat on every ring', () => {
  const TABLES = [
    { w: 347, h: 574 },
    { w: 390, h: 645 },
    { w: 720, h: 1190 },
  ];
  const px = (
    from: { x: number; y: number },
    to: { x: number; y: number },
    t: { w: number; h: number }
  ) => ({
    x: ((to.x - from.x) * t.w) / 100,
    y: ((to.y - from.y) * t.h) / 100,
  });
  const mag = (p: { x: number; y: number }) => Math.hypot(p.x, p.y);

  for (const table of TABLES) {
    for (const [n, ring] of Object.entries(SEAT_LAYOUTS)) {
      it(`${n}-max at ${table.w}px: every bet lands ${CHIP_COLLECT_FRACTION} of the way to the pill`, () => {
        for (const seat of ring) {
          const rest = betChipOffsetPx(seat, table);
          const travel = chipCollectOffsetPx(seat, table);
          const landed = { x: rest.x + travel.x, y: rest.y + travel.y };
          const toPot = px(seat, POT_ANCHOR_PCT, table);
          expect(Math.abs(mag(landed) - mag(toPot) * CHIP_COLLECT_FRACTION)).toBeLessThanOrEqual(
            1.5
          );
          // and the landing point is nowhere near the old one for a bottom seat:
          // the felt centre is a quarter of the table further down the scaler.
          const toMiddle = px(seat, feltCenter(), table);
          if (seat.y > 60) {
            const landedAbsY = seat.y + (landed.y / table.h) * 100;
            expect(landedAbsY).toBeLessThan(feltCenter().y - 10);
            expect(Math.abs(landedAbsY - POT_ANCHOR_PCT.y)).toBeLessThan(
              Math.abs(landedAbsY - feltCenter().y)
            );
            void toMiddle;
          }
        }
      });
    }
  }
});
