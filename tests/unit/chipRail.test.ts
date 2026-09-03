/**
 * THE CHIP RAIL, ON A RING THAT IS NOT ONE OF OURS.
 * ============================================================================
 * tests/table-geometry-chips.test.ts walks the eight production rings out of
 * src/lib/tableSeatGeometry.ts, which is the right suite for "does the table we
 * ship work". This one exists for the other question: does the geometry hold up
 * on a ring nobody has tuned it against.
 *
 * The seats below are deliberately NOT a production ring. They are a nine-
 * handed ellipse with seats at x=6 and x=94 - further out than any real seat -
 * and an off-centre hero, which is exactly the sort of layout a new skin or a
 * new table size would introduce. Every rule the module claims is a rule rather
 * than a tuning has to survive that:
 *
 *   - one rail, the same distance from every seat that has the room for it;
 *   - both markers on the felt, whatever the seat is doing;
 *   - the two markers never on top of each other.
 *
 * Dan 2026-08-25, item 13: "all chips must appear equally on that line for all
 * players at all tables" - at all tables is the part this file is for.
 */

import { describe, it, expect } from 'vitest';
import {
  betChipOffsetPx,
  buttonRadiusWidthPct,
  chipCollectOffsetPx,
  chipRadiusWidthPct,
  chipRailInset,
  MARKER_INSET_PX,
  chipRestPosition,
  chipStepWidthPct,
  clampIntoFelt,
  dealerButtonPosition,
  feltCenter,
  feltEdgeClearanceWidthPct,
  feltRadialFraction,
  isInsideFelt,
  isOnFeltText,
  markerGapWidthPct,
  seatPodPx,
  BOARD_WINDOW,
  BUTTON_ANGLE_DEG,
  BUTTON_FELT_DAYLIGHT_WIDTH_PCT,
  BUTTON_FELT_MARGIN_WIDTH_PCT,
  BUTTON_RAIL_RATIO,
  CHIP_COLLECT_FRACTION,
  CHIP_POD_GAP_WIDTH_PCT,
  CHIP_RAIL_WIDTH_PCT,
  FELT_MARKER_MARGIN_WIDTH_PCT,
  FELT_WINDOW,
  MARKER_MIN_GAP_WIDTH_PCT,
  SEAT_POD_LADDER,
  type Pos,
  type Size,
} from '../../src/components/table/tableGeometry';

/** A nine-handed ring that is not ours: wider than the painted rail, hero off centre. */
const SEATS: Pos[] = [
  { x: 47, y: 96 },
  { x: 18, y: 80 },
  { x: 6, y: 55 },
  { x: 12, y: 30 },
  { x: 32, y: 10 },
  { x: 68, y: 10 },
  { x: 88, y: 30 },
  { x: 94, y: 55 },
  { x: 82, y: 80 },
];

/** Phone, tablet and desktop, all at the scaler's locked 605/1000. */
const TABLES: Size[] = [
  { w: 347, h: 574 },
  { w: 600, h: 992 },
  { w: 720, h: 1190 },
];

const dist = (p: Pos) => Math.hypot(p.x, p.y);
/** Distance between two scaler percentages, in pixels on a given table. */
const px = (a: Pos, b: Pos, t: Size) =>
  Math.hypot(((a.x - b.x) * t.w) / 100, ((a.y - b.y) * t.h) / 100);

/* ═══════════════════════════════════════════════════════════════════════════
   ROUND THREE (Dan 2026-08-26) - THE FURNITURE
   ═══════════════════════════════════════════════════════════════════════════
   "The chips put in the pot by the hero and the villains need to be moved
    farther in front of them. They are either on the rail, or overlapping the
    avatar, or the action box. Chips should be on the table only and never
    overlapping any aspect or feature on the table."

   "The avatar on the left middle who has the button - the button should be
    moved up some in that position so it doesn't overlap the date."

   The rail is a percentage of the TABLE and the pod it has to clear is a pixel
   count off `--seat-avatar-base`, so the defect lives in the pairing of the
   two: it is invisible on a 720px desktop felt and unavoidable on a phone. The
   suites below therefore walk VIEWPORT-AND-TABLE PAIRS rather than table sizes
   on their own, which is the only way a test can see it at all. */

/**
 * What each rung of SEAT_POD_LADDER actually renders.
 *
 * The first three tables are measured, not modelled: they are the numbers in
 * `.table-scaler`'s own comment in TablePage.css ("MEASURED in Chromium at
 * three phone widths"). The rest are the ladder's own caps - 600px in tablet
 * portrait, 720px from 1024px up - and one mid-size laptop window, which is
 * where the felt is smallest relative to the pod standing on it.
 */
const BREAKPOINTS: Array<{ viewportW: number; table: Size }> = [
  { viewportW: 375, table: { w: 367, h: 606.6 } },
  { viewportW: 393, table: { w: 385, h: 636.4 } },
  { viewportW: 430, table: { w: 422, h: 697.7 } },
  { viewportW: 640, table: { w: 436, h: 720.7 } },
  { viewportW: 800, table: { w: 600, h: 992 } },
  { viewportW: 1440, table: { w: 720, h: 1190 } },
];

/**
 * The one pairing where the pod and the board cannot both be had: a 1440x900
 * laptop. The oval is HEIGHT-bound there (see --sp-table-h in TablePage.css),
 * so the felt is 404px wide while every seat still paints a 96 x 122px desktop
 * pod on it. Kept as its own case because it is the stated cost of the trade,
 * not a table anyone forgot about.
 */
const CROWDED = { viewportW: 1440, table: { w: 404, h: 667.8 } as Size };

/** Hero is the seat on the scaler's bottom edge, exactly as TablePage tags it. */
const isHeroSeat = (s: Pos) => s.y >= 100 && s.x === 50;

/**
 * Felt between a seat's resting chip and its own pod, in pixels. Negative when
 * the chip is painted over the avatar or the name plate.
 *
 * The pod is centred on the ring position because `.seat-wrapper` is
 * `translate(-50%, -50%)`; the chip is a disc, so its radius comes off the
 * separation. Euclidean rather than per-axis, so a chip cutting a corner of the
 * plate is counted as the overlap it is.
 */
function podClearancePx(seat: Pos, table: Size, pod: Size): number {
  const rest = chipRestPosition(seat, table, pod);
  const dx = Math.abs(((rest.x - seat.x) * table.w) / 100);
  const dy = Math.abs(((rest.y - seat.y) * table.h) / 100);
  const gap = Math.hypot(Math.max(0, dx - pod.w / 2), Math.max(0, dy - pod.h / 2));
  return gap - (chipRadiusWidthPct(table) / 100) * table.w;
}

/**
 * The community board in scaler percentages, derived here from TablePage.css
 * rather than read off BOARD_WINDOW's own arithmetic - a test that reuses the
 * module's rectangle only proves the module agrees with itself.
 *
 * `.table-surface .community-area { width: 68% }` of the felt, `.community-area
 * { top: 43.5% }` of the felt with `translate(-50%, -50%)`, five cards at
 * `flex: 1 1 0` and `aspect-ratio: 64 / 92`. Gaps between the cards are ignored,
 * which makes the rectangle slightly TALLER than the real board - the safe
 * direction for an assertion that nothing may touch it.
 */
function boardRectPct(table: Size) {
  const c = feltCenter();
  const rowPx = (BOARD_WINDOW.widthOfFeltPct / 100) * (FELT_WINDOW.width / 100) * table.w;
  const cardHPx = (rowPx / 5) * (92 / 64);
  const centreY = FELT_WINDOW.top + (BOARD_WINDOW.centerOfFeltYPct / 100) * FELT_WINDOW.height;
  return {
    x0: c.x - (rowPx / 2 / table.w) * 100,
    x1: c.x + (rowPx / 2 / table.w) * 100,
    y0: centreY - (cardHPx / 2 / table.h) * 100,
    y1: centreY + (cardHPx / 2 / table.h) * 100,
  };
}

/** True when a resting chip's disc overlaps the board rectangle at all. */
function chipTouchesBoard(seat: Pos, table: Size, pod?: Size): boolean {
  const p = chipRestPosition(seat, table, pod);
  const b = boardRectPct(table);
  const rx = chipRadiusWidthPct(table);
  const ry = (((chipRadiusWidthPct(table) / 100) * table.w) / table.h) * 100;
  return p.x + rx > b.x0 && p.x - rx < b.x1 && p.y + ry > b.y0 && p.y - ry < b.y1;
}

/**
 * Steps 1 and 2 of `dealerButtonPosition` and NOTHING ELSE - the puck walked
 * BUTTON_RAIL_RATIO of the rail at BUTTON_ANGLE_DEG and projected onto the
 * felt, with neither of step 3's keep-outs applied.
 *
 * Restated here on purpose, and it is the only place in this file that repeats
 * the module's arithmetic. Without it "the puck is not on the printing" is a
 * sentence that passes whether or not the keep-out exists, and a guard nobody
 * can show is doing work is a guard somebody will delete.
 */
function naiveButtonPosition(seat: Pos, table: Size): Pos {
  const c = feltCenter();
  const aspect = table.h / table.w;
  const s = { x: seat.x, y: seat.y * aspect };
  const t = { x: c.x, y: c.y * aspect };
  const len = Math.hypot(t.x - s.x, t.y - s.y);
  const ux = (t.x - s.x) / len;
  const uy = (t.y - s.y) / len;
  const a = (BUTTON_ANGLE_DEG * Math.PI) / 180;
  const rx = ux * Math.cos(a) - uy * Math.sin(a);
  const ry = ux * Math.sin(a) + uy * Math.cos(a);
  const step = Math.min(CHIP_RAIL_WIDTH_PCT * BUTTON_RAIL_RATIO, len * 0.8);
  const walked = { x: s.x + rx * step, y: (s.y + ry * step) / aspect };
  return clampIntoFelt(walked, table, BUTTON_FELT_MARGIN_WIDTH_PCT);
}

describe('the chip rail', () => {
  it('walks every seat that has the room the same distance, at every table size', () => {
    for (const table of TABLES) {
      const rail = chipRailInset(table);
      for (const seat of SEATS) {
        const rest = chipRestPosition(seat, table);
        const walked = dist(betChipOffsetPx(seat, table));
        if (feltRadialFraction(rest, table) < 0.999) {
          // Not touched by the on-felt guarantee, so it is on the common rail.
          // Each axis is rounded on its own, hence a stated 1px window rather
          // than pretending the arithmetic is exact.
          expect(
            Math.abs(walked - rail),
            `${table.w}x${table.h} seat ${seat.x},${seat.y}`
          ).toBeLessThanOrEqual(1);
        } else {
          // The only thing that ever lengthens a walk: a seat standing off the
          // felt has to cross the rail before its rail starts.
          expect(walked).toBeGreaterThan(rail);
        }
      }
    }
  });

  it('never leaves a marker on the painted rail', () => {
    for (const table of TABLES) {
      for (const seat of SEATS) {
        expect(
          isInsideFelt(chipRestPosition(seat, table), table),
          `chips ${seat.x},${seat.y}`
        ).toBe(true);
        expect(
          isInsideFelt(dealerButtonPosition(seat, table), table),
          `button ${seat.x},${seat.y}`
        ).toBe(true);
      }
    }
  });

  it('leaves the button clear felt on all sides, on a ring nobody tuned it against', () => {
    /* Dan 2026-08-25, round two item 8: "The button is too close to the rail and
       should be pushed a little farther into the table, so it's 'in front of the
       player' without touching the rail."

       The test above only asks whether the marker is inside the felt, and a puck
       resting flat against the rail passes that - which is exactly what Dan was
       looking at. This asks for the daylight, on seats at x=6 and x=94 that sit
       further outside the painted felt than any production chair, so the answer
       comes from the projection rather than from where the seat happened to be.

       Half the daylight is the puck's own radius (it may not overhang) and half
       is clear felt (it may not touch), which is why the second assertion takes
       FELT_MARKER_MARGIN_WIDTH_PCT off before comparing. */
    for (const table of TABLES) {
      for (const seat of SEATS) {
        const clearance = feltEdgeClearanceWidthPct(dealerButtonPosition(seat, table), table);
        expect(
          clearance,
          `${table.w}x${table.h} seat ${seat.x},${seat.y}: ` +
            `${((clearance * table.w) / 100).toFixed(1)}px from the rail`
        ).toBeGreaterThanOrEqual(BUTTON_FELT_MARGIN_WIDTH_PCT - 1e-6);
        expect(clearance - FELT_MARKER_MARGIN_WIDTH_PCT).toBeGreaterThanOrEqual(
          BUTTON_FELT_DAYLIGHT_WIDTH_PCT - 1e-6
        );
      }
    }
  });

  it('does not push the button so far in that it stops belonging to its seat', () => {
    /* The daylight is bought by walking the button further from its player, so
       the walk is bounded. 0.40 of the seat's own distance to the middle of the
       felt is a stated ceiling with headroom: this ring, which is deliberately
       wider than ours, peaks at 0.34 (seat 94,55 on the phone - 53.3px of
       156.8px) and the eight production rings peak at 0.32. The second half is
       the invariant that matters more than the number - whatever the geometry
       does, no other chair on the ring ends up nearer to this button than the
       chair it was computed for. */
    const c = feltCenter();
    for (const table of TABLES) {
      for (const seat of SEATS) {
        const btn = dealerButtonPosition(seat, table);
        const walked = px(seat, btn, table);
        const run = px(seat, c, table);
        expect(walked / run, `${table.w}x${table.h} seat ${seat.x},${seat.y}`).toBeLessThanOrEqual(
          0.4
        );
        for (const other of SEATS) {
          if (other === seat) continue;
          expect(
            px(other, btn, table),
            `${table.w}x${table.h} seat ${seat.x},${seat.y}'s button is nearer ${other.x},${other.y}`
          ).toBeGreaterThanOrEqual(walked - 1e-9);
        }
      }
    }
  });

  it('keeps the chips and the button visibly apart', () => {
    for (const table of TABLES) {
      for (const seat of SEATS) {
        const gap = markerGapWidthPct(
          dealerButtonPosition(seat, table),
          chipRestPosition(seat, table),
          table
        );
        expect(gap, `seat ${seat.x},${seat.y}`).toBeGreaterThanOrEqual(
          MARKER_MIN_GAP_WIDTH_PCT - 1e-6
        );
      }
    }
  });

  it('holding the button cannot even be expressed to the chip functions', () => {
    // CHIP_RAIL_DEALER_EXTRA_PX used to push the button holder's chips 20px
    // further out so they could clear their own puck. One seat at a different
    // distance from its player than everyone else is the thing item 13 forbids;
    // the puck moves instead.
    //
    // This used to be `betChipOffsetPx(seat, table, true)` vs `(..., false)`,
    // which proved the argument was ignored - and kept the argument alive to be
    // ignored. Audit 2026-08-25 deleted the parameter, so the property is now
    // structural: there is no third argument for a caller to get wrong.
    expect(betChipOffsetPx).toHaveLength(2);
    expect(chipCollectOffsetPx).toHaveLength(2);
    expect(chipRailInset).toHaveLength(1);
  });

  it('always moves chips toward the middle of the felt, never away from it', () => {
    const c = feltCenter();
    for (const table of TABLES) {
      for (const seat of SEATS) {
        const off = betChipOffsetPx(seat, table);
        if (Math.abs(c.x - seat.x) > 0.5) expect(Math.sign(off.x)).toBe(Math.sign(c.x - seat.x));
        if (Math.abs(c.y - seat.y) > 0.5) expect(Math.sign(off.y)).toBe(Math.sign(c.y - seat.y));
      }
    }
  });

  it('never throws chips past the middle of the felt', () => {
    const c = feltCenter();
    for (const table of TABLES) {
      for (const seat of SEATS) {
        const off = betChipOffsetPx(seat, table);
        const run = Math.hypot(((c.x - seat.x) * table.w) / 100, ((c.y - seat.y) * table.h) / 100);
        expect(dist(off)).toBeLessThan(run);
      }
    }
  });

  it('collects every seat to the same point, wherever its chips started', () => {
    const c = feltCenter();
    for (const table of TABLES) {
      for (const seat of SEATS) {
        const rest = betChipOffsetPx(seat, table);
        const travel = chipCollectOffsetPx(seat, table);
        const landed = { x: rest.x + travel.x, y: rest.y + travel.y };
        const run = Math.hypot(((c.x - seat.x) * table.w) / 100, ((c.y - seat.y) * table.h) / 100);
        // Both halves are rounded per axis, so the sum can land ~1.4px either
        // side of the mark it is aimed at.
        expect(Math.abs(dist(landed) - run * CHIP_COLLECT_FRACTION)).toBeLessThanOrEqual(1.5);
      }
    }
  });

  it('does not divide by zero for a seat sitting on the middle of the felt', () => {
    const c = feltCenter();
    expect(betChipOffsetPx(c, TABLES[0])).toEqual({ x: 0, y: 0 });
    expect(dealerButtonPosition(c, TABLES[0])).toEqual(c);
  });

  it('is one number and it follows the table', () => {
    expect(chipRailInset(TABLES[0])).toBeLessThan(chipRailInset(TABLES[2]));
    // A table so small it has no felt left still returns something finite
    // rather than a NaN that would put a chip at translate(NaN, NaN).
    const tiny = betChipOffsetPx({ x: 10, y: 90 }, { w: 20, h: 33 });
    expect(Number.isFinite(tiny.x) && Number.isFinite(tiny.y)).toBe(true);
  });
});

describe('the chips and the furniture', () => {
  it('clears the seat pod at every breakpoint, on the table that breakpoint renders', () => {
    /* THE DEFECT, STATED AS A NUMBER. On a 385px table the rail is 48.1px, the
       villain pod is 80 x 88px, and half a chip is 6.9px - so a side seat's
       chips came to rest with 1.2px of felt between them and the name plate,
       and none at all once the walk was diagonal, because the diagonal exit
       from a rectangle is longer than either half of it. Measured over the
       eight production rings before this was written, every table size had at
       least one seat whose chips were painted on its own pod, worst case 21px
       in.

       Both pods are walked, villain and hero, at every rung of the ladder,
       because the hero's is 4/3 of the avatar and 8/7 of the seat again and is
       the biggest box on the felt. */
    for (const { viewportW, table } of BREAKPOINTS) {
      for (const seat of SEATS) {
        const pod = seatPodPx(viewportW, isHeroSeat(seat));
        const clear = podClearancePx(seat, table, pod);
        expect(
          clear,
          `vw ${viewportW} table ${table.w}x${table.h} seat ${seat.x},${seat.y} ` +
            `pod ${pod.w}x${pod.h}: ${clear.toFixed(1)}px of felt`
        ).toBeGreaterThan(0);
      }
    }
  });

  it('keeps the same clearance for the hero as for anybody else', () => {
    /* Item 13 in the other direction. The hero's pod is bigger, so the hero's
       chips walk further - but the FELT LEFT OVER, which is what a player
       actually sees, is the same rule applied to a bigger box, never a rule of
       its own. Every seat gets at least the gap constant, nobody gets a private
       one. */
    for (const { viewportW, table } of BREAKPOINTS) {
      const floor = (CHIP_POD_GAP_WIDTH_PCT / 100) * table.w - 0.05;
      for (const seat of [...SEATS, { x: 50, y: 100 }]) {
        const pod = seatPodPx(viewportW, isHeroSeat(seat));
        expect(
          podClearancePx(seat, table, pod),
          `vw ${viewportW} ${table.w}x${table.h} seat ${seat.x},${seat.y}`
        ).toBeGreaterThanOrEqual(floor);
      }
    }
  });

  it('never lets a pod push a seat onto the community cards', () => {
    /* The rail's own derivation exists to keep chips off the board (a chip over
       the 9d is a bug that has actually shipped). Lengthening the walk for the
       pod must not undo that at ANY pod size, so this walks every rung against
       every table rather than only the pairings a browser produces - including
       the crowded one below, where the board is what stops the walk. */
    for (const { viewportW, table } of [...BREAKPOINTS, CROWDED]) {
      for (const pods of [SEAT_POD_LADDER[0], SEAT_POD_LADDER[3]]) {
        for (const pod of [pods.villain, pods.hero]) {
          for (const seat of SEATS) {
            expect(
              chipTouchesBoard(seat, table, pod),
              `vw ${viewportW} ${table.w}x${table.h} seat ${seat.x},${seat.y} pod ${pod.w}x${pod.h}`
            ).toBe(false);
          }
        }
      }
    }
  });

  it('gives the board to the board when a seat cannot have both', () => {
    /* THE STATED COST, asserted rather than left in a comment. A 1440x900
       laptop renders a 404px felt (the oval is height-bound there) with 96 x
       122px desktop pods standing on it, and a side seat at the board's own
       height walks straight at the cards - so the two keep-outs want the same
       pixels. The board wins: the chips stay off the flop and come up short of
       the plate instead.

       Bounded, because "the board wins" must not become "the pod is ignored":
       the shortfall is a few pixels of plate, not a chip parked on the avatar.
       And it must remain the exceptional case - if a majority of seats start
       failing to clear their pod, the felt has got smaller than this geometry
       can serve and the answer is a smaller pod, not a bigger tolerance. */
    const { table } = CROWDED;
    const pod = seatPodPx(CROWDED.viewportW, false);
    const boardLevel = [
      { x: 10.5, y: 45 },
      { x: 89.5, y: 45 },
    ];
    let short = 0;
    for (const seat of boardLevel) {
      expect(chipTouchesBoard(seat, table, pod), `seat ${seat.x},${seat.y}`).toBe(false);
      const clear = podClearancePx(seat, table, pod);
      if (clear < 0) short += 1;
      expect(clear, `seat ${seat.x},${seat.y} shortfall`).toBeGreaterThan(-6);
    }
    expect(short, 'the board-level seats are the ones that pay for it').toBe(2);

    // And nowhere near a majority of the felt: on the same crowded table the
    // seats that are not walking at the cards still clear their plate.
    for (const seat of [
      { x: 10.5, y: 82.5 },
      { x: 10.5, y: 23 },
      { x: 50, y: 5 },
      { x: 89.5, y: 82.5 },
    ]) {
      expect(podClearancePx(seat, table, pod), `seat ${seat.x},${seat.y}`).toBeGreaterThan(0);
    }
  });

  it('never shortens a walk to fit any of this', () => {
    /* The one thing CHIP_RAIL_SCALE_BOARD_LEVEL did that got it deleted. The
       common rail is a FLOOR: a pod can only ever lengthen a walk, and the
       board ceiling can only ever claw back the length the pod asked for. No
       seat, no pod, no table size may come out below CHIP_RAIL_WIDTH_PCT. */
    for (const { viewportW, table } of [...BREAKPOINTS, CROWDED]) {
      for (const rung of SEAT_POD_LADDER) {
        for (const pod of [rung.villain, rung.hero]) {
          for (const seat of SEATS) {
            const withPod = chipStepWidthPct(seat, table, pod);
            expect(
              withPod,
              `vw ${viewportW} ${table.w}x${table.h} seat ${seat.x},${seat.y} pod ${pod.w}x${pod.h}`
            ).toBeGreaterThanOrEqual(CHIP_RAIL_WIDTH_PCT - 1e-9);
            expect(withPod).toBeGreaterThanOrEqual(chipStepWidthPct(seat, table) - 1e-9);
          }
        }
      }
    }
  });

  it('still keeps both markers on the felt and apart once the chips walk further', () => {
    for (const { viewportW, table } of [...BREAKPOINTS, CROWDED]) {
      for (const seat of SEATS) {
        const pod = seatPodPx(viewportW, isHeroSeat(seat));
        const rest = chipRestPosition(seat, table, pod);
        const btn = dealerButtonPosition(seat, table, pod);
        expect(isInsideFelt(rest, table), `chips ${seat.x},${seat.y}`).toBe(true);
        expect(isInsideFelt(btn, table), `button ${seat.x},${seat.y}`).toBe(true);
        expect(
          feltEdgeClearanceWidthPct(btn, table),
          `button daylight ${seat.x},${seat.y}`
        ).toBeGreaterThanOrEqual(BUTTON_FELT_MARGIN_WIDTH_PCT - 1e-6);
        expect(
          markerGapWidthPct(btn, rest, table),
          `vw ${viewportW} ${table.w}x${table.h} seat ${seat.x},${seat.y}`
        ).toBeGreaterThanOrEqual(MARKER_MIN_GAP_WIDTH_PCT - 1e-6);
      }
    }
  });
});

describe('the dealer button and the printing on the felt', () => {
  /* Dan 2026-08-26: "The avatar on the left middle who has the button - the
     button should be moved up some in that position so it doesn't overlap the
     date."

     The date is `.table-brand__line` inside `.table-brand`, the felt masthead:
     the wordmark with date / club / union on one row and the stakes and hand
     number on the next, centred on 58% of the felt. See FELT_TEXT_BAND. */

  /** Production rings, from src/lib/tableSeatGeometry.ts. */
  const RINGS: Pos[][] = [
    [
      { x: 50, y: 100 },
      { x: 10.5, y: 45 },
      { x: 50, y: 5 },
      { x: 89.5, y: 45 },
    ],
    [
      { x: 50, y: 100 },
      { x: 10.5, y: 55 },
      { x: 20.5, y: 6 },
      { x: 79.5, y: 6 },
      { x: 89.5, y: 55 },
    ],
    [
      { x: 50, y: 100 },
      { x: 10.5, y: 66 },
      { x: 10.5, y: 33 },
      { x: 50, y: 5 },
      { x: 89.5, y: 33 },
      { x: 89.5, y: 66 },
    ],
    [
      { x: 50, y: 100 },
      { x: 10.5, y: 82.5 },
      { x: 10.5, y: 52 },
      { x: 10.5, y: 23 },
      { x: 50, y: 5 },
      { x: 89.5, y: 23 },
      { x: 89.5, y: 52 },
      { x: 89.5, y: 82.5 },
    ],
    [
      { x: 50, y: 100 },
      { x: 10.5, y: 82.5 },
      { x: 10.5, y: 58 },
      { x: 10.5, y: 30 },
      { x: 27, y: 6 },
      { x: 73, y: 6 },
      { x: 89.5, y: 30 },
      { x: 89.5, y: 58 },
      { x: 89.5, y: 82.5 },
    ],
  ];

  it('knows where the printing is', () => {
    // A keep-out nobody can see is a keep-out that passes by being empty. The
    // masthead is centred on 58% of the felt, so its middle is on it and the
    // clear felt above the board is not.
    for (const table of TABLES) {
      const centre = {
        x: feltCenter().x,
        y: FELT_WINDOW.top + 0.58 * FELT_WINDOW.height,
      };
      expect(isOnFeltText(centre, table), `${table.w}`).toBe(true);
      expect(isOnFeltText({ x: feltCenter().x, y: 20 }, table)).toBe(false);
      expect(isOnFeltText({ x: 16, y: centre.y }, table)).toBe(false);
    }
  });

  it('is doing work: seats whose puck would land on the printing are moved off it', () => {
    /* Non-vacuity. `naiveButtonPosition` is steps 1 and 2 of the real thing -
       walk the rail at the angle, project onto the felt - with step 3's
       keep-outs left off. Every seat below has a naive puck ON the masthead,
       and a real one that is not. */
    const cases: Array<[Size, Pos]> = [
      [
        { w: 347, h: 574 },
        { x: 15, y: 55 },
      ],
      [
        { w: 385, h: 636.4 },
        { x: 15, y: 55 },
      ],
      [
        { w: 600, h: 992 },
        { x: 17, y: 55 },
      ],
      [
        { w: 720, h: 1190 },
        { x: 21, y: 55 },
      ],
      // Right of the middle as well as left, so the keep-out is not quietly a
      // rule about one side of the felt.
      [
        { w: 347, h: 574 },
        { x: 65, y: 62 },
      ],
      [
        { w: 385, h: 636.4 },
        { x: 65, y: 62 },
      ],
      [
        { w: 720, h: 1190 },
        { x: 65, y: 62 },
      ],
    ];
    for (const [table, seat] of cases) {
      const puck = buttonRadiusWidthPct(table);
      expect(
        isOnFeltText(naiveButtonPosition(seat, table), table, puck),
        `${table.w} seat ${seat.x},${seat.y} was expected to need the keep-out`
      ).toBe(true);
      expect(
        isOnFeltText(dealerButtonPosition(seat, table), table, puck),
        `${table.w} seat ${seat.x},${seat.y} still on the printing`
      ).toBe(false);
    }
  });

  it('never lands the puck on the date, on any production ring at any table size', () => {
    for (const { viewportW, table } of [...BREAKPOINTS, CROWDED]) {
      const puck = buttonRadiusWidthPct(table);
      for (const ring of RINGS) {
        for (const seat of ring) {
          const pod = seatPodPx(viewportW, isHeroSeat(seat));
          expect(
            isOnFeltText(dealerButtonPosition(seat, table, pod), table, puck),
            `vw ${viewportW} ${table.w}x${table.h} seat ${seat.x},${seat.y}`
          ).toBe(false);
        }
      }
    }
  });

  it('never lands the puck on the date on the ring nobody tuned it against', () => {
    for (const table of TABLES) {
      const puck = buttonRadiusWidthPct(table);
      for (const seat of SEATS) {
        expect(
          isOnFeltText(dealerButtonPosition(seat, table), table, puck),
          `${table.w}x${table.h} seat ${seat.x},${seat.y}`
        ).toBe(false);
      }
    }
  });

  it('buys the daylight by moving the button, never by moving the chips', () => {
    /* The module's stated principle, and the instruction Dan gave with the
       report: the puck is the marker with somewhere else to be. A seat whose
       button has to dodge the masthead must have its BET in exactly the place a
       seat that does not would. */
    for (const table of TABLES) {
      for (const seat of [
        { x: 15, y: 55 },
        { x: 85, y: 55 },
        { x: 10.5, y: 55 },
      ]) {
        const before = chipRestPosition(seat, table);
        dealerButtonPosition(seat, table);
        expect(chipRestPosition(seat, table), `${table.w} seat ${seat.x},${seat.y}`).toEqual(
          before
        );
        /* …and the walk is still the common rail for a seat with the room.
           Since MARKER_INSET_PX (2026-08-26) "the common rail" is one of two
           values: the full rail, or the rail minus the inset for a seat level
           with the community board, which cannot take the extra 3px without
           putting chips on the cards. `{x:10.5,y:55}` in this list is exactly
           such a seat. Which of the two a seat gets is decided by the board,
           never by whose seat it is — that is the property being pinned. */
        if (feltRadialFraction(before, table) < 0.999) {
          const shortfall = chipRailInset(table) - dist(betChipOffsetPx(seat, table));
          expect(
            shortfall >= -1 && shortfall <= MARKER_INSET_PX + 1,
            `${table.w} seat ${seat.x},${seat.y} is on neither rail`
          ).toBe(true);
        }
      }
    }
  });
});
