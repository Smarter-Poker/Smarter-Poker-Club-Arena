/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DEALER BUTTON BELONGS TO A PLAYER, AND MUST LOOK LIKE IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-07, item 10: "THE BUTTON IS NOT DIRECTLY OR EVEN CLOSE TO THE
 * PLAYER WHO 'HAS THE BUTTON'. (SEE 3RD ATTACHED IMAGE, MAKE SURE THIS IS
 * FIXED AND ADJUSTED FOR ALL PLAYER POSITIONS WITHOUT COVERING OR OVERLAPPING
 * ANY DATA, OR CHIPS IN POT POSITIONS)."
 *
 * "ALL PLAYER POSITIONS" is the part a single fix tends to miss, so this
 * sweeps every seat of every ring the app draws (2-9) at the four table sizes
 * it renders, and asserts BOTH halves of his sentence at once — the puck is
 * unambiguously its own seat's, AND it is still off every plate, the masthead
 * and the board.
 *
 * ── WHAT THIS DOES AND DOES NOT PROVE, MEASURED ────────────────────────────
 * Be clear about this, because the file it guards was changed on the strength
 * of a screenshot and the measurement did not agree with the diagnosis.
 *
 * Sweeping all 176 seat/size pairs BEFORE the 2026-09-07 change: zero
 * ownership violations, worst distance-from-own-seat 24.7% of table width.
 * AFTER: zero violations, worst distance 24.7%. Identical. The avoidance
 * search was not walking pucks to the wrong player, so making ownership a
 * hard constraint (rather than a tiebreak among already-accepted candidates)
 * did not close any gap — it removed the POSSIBILITY of one, which is worth
 * having on a felt whose masthead keep-out just grew, and is what these
 * assertions now hold by construction instead of by luck.
 *
 * The distance Dan is looking at is structural, not a search failure. The
 * 6-max top seat's puck is 13.4 left and 9.0 down from its chair before any
 * avoidance runs at all: BUTTON_RAIL_RATIO 0.85 of a 12.5% chip rail is
 * 10.6% of the table's width, the 36-degree offset that buys the puck its
 * separation from the chips turns most of that sideways, and a seat sitting
 * on the felt's own edge then gets projected further in. Closing it means
 * changing those constants, which moves every chip on the table — see the
 * note on BUTTON_ANGLE_DEG for why 36 is load-bearing (at 20 degrees the two
 * markers are 4.4% apart against a 6% minimum).
 */
import { describe, it, expect } from 'vitest';
import {
  dealerButtonPositionClearOfSeat,
  overlapsSeatPlate,
} from '../../src/components/table/DealerButton';
import {
  buttonRadiusWidthPct,
  chipRestPosition,
  isOnFeltText,
  markerGapWidthPct,
  overlapsBoard,
  MARKER_MIN_GAP_WIDTH_PCT,
} from '../../src/components/table/tableGeometry';
import { SEAT_LAYOUTS } from '../../src/lib/tableSeatGeometry';
import { seatPodPx } from '../../src/components/table/tableGeometry';

/** The four widths TablePage.css has breakpoints for, at the locked aspect. */
const SIZES = [375, 404, 768, 1280].map((w) => ({ w, h: Math.round((w * 1000) / 605) }));

type Pos = { x: number; y: number };

const sq = (p: Pos, size: { w: number; h: number }): Pos => ({
  x: p.x,
  y: (p.y * size.h) / size.w,
});

const dist = (a: Pos, b: Pos, size: { w: number; h: number }) => {
  const A = sq(a, size);
  const B = sq(b, size);
  return Math.hypot(A.x - B.x, A.y - B.y);
};

/** Every (ring, size, seat) the app can actually draw. */
function everySeat(): Array<{
  ring: number;
  size: { w: number; h: number };
  seatIdx: number;
  seat: Pos;
  seats: Pos[];
}> {
  const out: Array<{
    ring: number;
    size: { w: number; h: number };
    seatIdx: number;
    seat: Pos;
    seats: Pos[];
  }> = [];
  for (let ring = 2; ring <= 9; ring++) {
    const seats = SEAT_LAYOUTS[ring] as unknown as Pos[] | undefined;
    if (!seats) continue;
    for (const size of SIZES) {
      seats.forEach((seat, seatIdx) => out.push({ ring, size, seatIdx, seat, seats }));
    }
  }
  return out;
}

const pod = (size: { w: number }, seat: Pos) => seatPodPx(size.w, seat.y >= 100 && seat.x === 50);

describe('the puck is unmistakably ITS OWN seat’s', () => {
  it('is nearer to its own chair than to any other, on every ring and size', () => {
    const offenders: string[] = [];
    for (const { ring, size, seatIdx, seat, seats } of everySeat()) {
      const p = dealerButtonPositionClearOfSeat(seat, size, pod(size, seat), seats);
      const own = dist(p, seat, size);
      seats.forEach((other, j) => {
        if (j === seatIdx) return;
        if (dist(p, other, size) <= own) {
          offenders.push(
            `${ring}-max @${size.w}px seat ${seatIdx}: own ${own.toFixed(1)} vs seat ${j} ${dist(p, other, size).toFixed(1)}`
          );
        }
      });
    }
    expect(offenders, offenders.slice(0, 8).join('\n')).toEqual([]);
  });

  it('never walks further from its chair than the gap to the next chair', () => {
    /* The measurable version of "not even close to the player who has the
       button": however far the avoidance search moves the puck, it may not
       travel further from its own seat than that seat's nearest neighbour is.
       Past that distance the puck is in the no-man's-land between two chairs
       even if it is technically still nearest its own. */
    const offenders: string[] = [];
    for (const { ring, size, seatIdx, seat, seats } of everySeat()) {
      if (seats.length < 2) continue;
      const p = dealerButtonPositionClearOfSeat(seat, size, pod(size, seat), seats);
      const own = dist(p, seat, size);
      const nearestNeighbour = Math.min(
        ...seats.filter((_, j) => j !== seatIdx).map((o) => dist(seat, o, size))
      );
      if (own > nearestNeighbour) {
        offenders.push(
          `${ring}-max @${size.w}px seat ${seatIdx}: moved ${own.toFixed(1)}, neighbour at ${nearestNeighbour.toFixed(1)}`
        );
      }
    }
    expect(offenders, offenders.slice(0, 8).join('\n')).toEqual([]);
  });
});

describe('...and it still covers nothing (the other half of item 10)', () => {
  it('stands on no seat plate, no masthead printing and no board', () => {
    const offenders: string[] = [];
    for (const { ring, size, seatIdx, seat, seats } of everySeat()) {
      const podPx = pod(size, seat);
      const p = dealerButtonPositionClearOfSeat(seat, size, podPx, seats);
      const puck = buttonRadiusWidthPct(size);
      const why: string[] = [];
      if (overlapsSeatPlate(p, seat, size, podPx)) why.push('plate');
      if (isOnFeltText(p, size, puck)) why.push('masthead');
      if (overlapsBoard(p, size)) why.push('board');
      if (why.length) offenders.push(`${ring}-max @${size.w}px seat ${seatIdx}: ${why.join('+')}`);
    }
    expect(offenders, offenders.slice(0, 8).join('\n')).toEqual([]);
  });

  it('keeps its daylight from its own chips-in-pot marker', () => {
    const offenders: string[] = [];
    for (const { ring, size, seatIdx, seat, seats } of everySeat()) {
      const podPx = pod(size, seat);
      const p = dealerButtonPositionClearOfSeat(seat, size, podPx, seats);
      const gap = markerGapWidthPct(p, chipRestPosition(seat, size, podPx), size);
      if (gap < MARKER_MIN_GAP_WIDTH_PCT) {
        offenders.push(`${ring}-max @${size.w}px seat ${seatIdx}: gap ${gap.toFixed(2)}`);
      }
    }
    expect(offenders, offenders.slice(0, 8).join('\n')).toEqual([]);
  });
});

describe('the ownership constraint degrades safely', () => {
  it('called without the ring (older callers, other tests) behaves as before', () => {
    // Vacuously true rather than throwing or refusing: a constraint can only
    // be enforced with the information to enforce it.
    const seats = SEAT_LAYOUTS[6] as unknown as Pos[];
    const size = SIZES[0];
    for (const seat of seats) {
      const p = dealerButtonPositionClearOfSeat(seat, size, pod(size, seat));
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    }
  });
});
