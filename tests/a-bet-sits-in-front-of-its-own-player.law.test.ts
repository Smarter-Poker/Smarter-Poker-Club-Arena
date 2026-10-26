/**
 * LAW: a bet sits in front of the player who made it, on every screen.
 *
 * Dan, 2026-10-25, with two phone screenshots of a nine-handed tournament:
 * "FOR MOBILE, CHIPS ARE STILL DISPLAYING IN THE WRONG LOCATIONS INSTEAD OF
 * ALWAYS 100% OF THE TIME BEING IN FRONT OF THE USER WHO BET THE CHIPS. IT
 * WORKS PERFECT ON DESK TOP AND ON IPAD ... MAKE THE MOBILE LAYOUT AND CHIP
 * POSITIONS THE SAME AS DESKTOP AND IPAD."
 *
 * What went wrong: on portrait viewports up to 768px the placement pass in
 * useProtectedCardLayout MOVED every wager to the best clear spot it could
 * find anywhere on the felt, through ever-wider fallback tiers, so a raise
 * printed beside the player two chairs away, in an empty chair's lane, or in
 * a neighbour's front. The pins below keep it in front of its own player:
 *
 *   1. the placement pass searches from the wager's own rest point, counts
 *      empty chairs, keeps the ownership rule in every tier, and leaves a
 *      wager with no clear spot of its own at its rest point;
 *   2. a top pod that drops below the jackpot takes its bet with it;
 *   3. at the desktop layout a phone now renders, every bet rests on the felt
 *      and nearer its own chair than any other chair, clear of its own tag.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { seatLayoutFor } from '../src/lib/tableSeatGeometry';
import {
  chipRadiusWidthPct,
  chipRestPosition,
  fitSeatToViewport,
  isInsideFelt,
  seatPodPx,
  type Pos,
} from '../src/components/table/tableGeometry';

const ROOT = join(__dirname, '..');
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

describe('a bet sits in front of its own player', () => {
  it('the portrait placement pass keeps every wager its own player\'s', () => {
    const hook = read('src/hooks/useProtectedCardLayout.ts');
    // Searched from the wager's own rest point in front of its player...
    expect(hook).toMatch(/const anchor = \{/);
    expect(hook).toMatch(/a\.top \+ a\.height \/ 2 - anchor\.y/);
    // ...an empty chair is somebody's lane too...
    expect(hook).toMatch(/wrapper\.querySelector\('\.seat'\) \?\?/);
    // ...no tier drops the ownership rule...
    expect(hook).toMatch(/any: distinct\(nearest\.filter\(ownedBy\), 160\)/);
    expect(hook).not.toMatch(/\? nearest\.filter\(ownedBy\) : nearest/);
    // ...and a wager with no clear spot of its own stays at its rest point.
    expect(hook).toMatch(/if \(!next\) \{[\s\S]{0,400}removeProperty\(name\)/);
  });

  it('a dropped top pod carries its bet with it', () => {
    const css = read('src/components/table/SeatSlot.css');
    expect(css).not.toMatch(
      /\.seat-wrapper--top\s+\.seat__bet-chips\s*\{[^}]*--sp-top-seat-shift/
    );
  });

  it('at the desktop layout a phone renders, every bet is on the felt and nearest its own chair', () => {
    const isHero = (p: Pos) => p.y >= 100 && p.x === 50;
    for (const count of [2, 3, 4, 5, 6, 7, 8, 9])
      for (const taper of [0, undefined]) {
        const width = 600;
        const size = { w: 600 * 0.86, h: 1060, portraitTags: true, portraitTaper: taper };
        const seats = seatLayoutFor(count).map((raw) => {
          const pod = seatPodPx(width, isHero(raw), size.w, { seats: count, canvasHeightPx: size.h });
          return { seat: fitSeatToViewport(raw, size, width, pod, undefined, count), pod };
        });
        const px = (p: Pos) => ({ x: (p.x * size.w) / 100, y: (p.y * size.h) / 100 });
        for (const { seat, pod } of seats) {
          const rest = px(chipRestPosition(seat, size, pod));
          expect(isInsideFelt(chipRestPosition(seat, size, pod), size, chipRadiusWidthPct(size))).toBe(
            true
          );
          const own = Math.hypot(rest.x - px(seat).x, rest.y - px(seat).y);
          for (const other of seats) {
            if (other.seat === seat) continue;
            const o = px(other.seat);
            expect(own, `${count}-max ${seat.x},${seat.y}`).toBeLessThan(
              Math.hypot(rest.x - o.x, rest.y - o.y)
            );
          }
        }
      }
  });
});
