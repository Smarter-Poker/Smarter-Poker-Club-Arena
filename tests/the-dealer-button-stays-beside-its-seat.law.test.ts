/**
 * LAW - THE DEALER BUTTON STAYS BESIDE ITS OWN SEAT
 *
 * Dan 2026-10-12, with a screenshot of a 9-max Diamond Arena table on a
 * phone: "BUTTON JUST RANDOMLY IN THE MIDDLE OF THE TABLE". The plate-clearing
 * retreat in DealerButton walked up to 30% of the table toward the middle, and
 * on a phone the two middle side seats of a 9-max ring could only clear the
 * felt printing by climbing past it, so the puck landed at the dead centre of
 * the felt. When the short retreat cannot clear the plate, the puck now looks
 * in its own seat's neighbourhood (above or below the plate) before any swing
 * round the middle. The same table geometry serves the Club Arena and the
 * Diamond Arena, so this holds every ring at every phone and desktop width,
 * with the seat pods exactly as DealerButton measures them.
 */
import { describe, expect, it } from 'vitest';
import { seatLayoutFor } from '../src/lib/tableSeatGeometry';
import { dealerButtonPosition, seatPodPx } from '../src/components/table/tableGeometry';
import {
  NEIGHBOURHOOD_WIDTH_PCT,
  RETREAT_MAX_WIDTH_PCT,
  dealerButtonPositionClearOfSeat,
} from '../src/components/table/DealerButton';

const SIZES = [
  { vw: 375, size: { w: 375, h: 620 } },
  { vw: 430, size: { w: 420, h: 694 } },
  { vw: 1200, size: { w: 605, h: 1000 } },
] as const;

/** Distance in table-width percent, y scaled to the same unit. */
function dist(a: { x: number; y: number }, b: { x: number; y: number }, h: number, w: number) {
  return Math.hypot(a.x - b.x, ((a.y - b.y) * h) / w);
}

describe('LAW - the dealer button stays beside its own seat', () => {
  for (const seats of [2, 3, 4, 5, 6, 7, 8, 9]) {
    for (const { vw, size } of SIZES) {
      it(`${seats}-max at ${vw}px: never in the middle, always nearest its own player`, () => {
        const ring = seatLayoutFor(seats).map((s) => ({ x: s.x, y: s.y }));
        for (const seat of ring) {
          const pod = seatPodPx(vw, seat.y >= 100 && seat.x === 50, size.w);
          const placed = dealerButtonPosition(seat, size, pod);
          const puck = dealerButtonPositionClearOfSeat(seat, size, pod, ring);
          // Never further from its own player than the rail spot plus the
          // short retreat, or than the seat's own neighbourhood, whichever is
          // larger. The two defects this law was written for stood 38 and 27
          // table-percent from a seat whose rail spot was 11 away.
          const bound = Math.max(
            dist(placed, seat, size.h, size.w) + RETREAT_MAX_WIDTH_PCT,
            NEIGHBOURHOOD_WIDTH_PCT
          );
          expect(
            dist(puck, seat, size.h, size.w),
            `seat ${JSON.stringify(seat)} button moved to ${JSON.stringify(puck)}`
          ).toBeLessThanOrEqual(bound + 1e-9);
          // And never nearer to another player than to its own.
          const own = dist(puck, seat, size.h, size.w);
          for (const other of ring) {
            if (other === seat) continue;
            expect(own).toBeLessThan(dist(puck, other, size.h, size.w));
          }
        }
      });
    }
  }
});
