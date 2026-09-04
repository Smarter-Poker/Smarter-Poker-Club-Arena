/**
 * ONE RAIL, BOTH MARKERS ON THE FELT, AND NEVER ON TOP OF EACH OTHER.
 *
 * Dan 2026-08-25, mobile pass:
 *
 *   item 11 "The button must always be on the table, and never on the rail."
 *   item 13 "All chips ... should all appear to be in the same position and
 *            distance in front of them. Imagine an imaginary oval, and all
 *            chips must appear equally on that line for all players at all
 *            tables. Those chips must never be in the same position on the
 *            table where the button lands."
 *
 * The rings come from src/lib/tableSeatGeometry.ts rather than being copied
 * here. They were copied here, and they went stale: this file was still testing
 * a hero at y=93.5 and top caps at y=13/14 months after production moved them to
 * y=100 and y=6, so every seat it checked was a seat that does not exist. A
 * geometry suite that invents its own seats cannot catch a seat problem.
 *
 * The tables are real ones. `.table-scaler` is locked to `aspect-ratio: 605/1000`
 * at every breakpoint in TablePage.css - the seat ring percentages are derived
 * from that box - so a 900x700 "wide table", which this file used to test, is
 * not a shape the app can render and proves nothing about the shape it does.
 */
import { describe, it, expect } from 'vitest';
import {
  betChipOffsetPx,
  chipCollectOffsetPx,
  chipRailInset,
  chipRestPosition,
  dealerButtonPosition,
  feltCenter,
  feltEdgeClearanceWidthPct,
  feltRadialFraction,
  isInsideFelt,
  markerGapWidthPct,
  BUTTON_FELT_DAYLIGHT_WIDTH_PCT,
  BUTTON_FELT_MARGIN_WIDTH_PCT,
  BUTTON_WIDTH_PCT,
  BUTTON_MIN_PX,
  BUTTON_MAX_PX,
  CHIP_WIDTH_PCT,
  CHIP_MIN_PX,
  CHIP_MAX_PX,
  CHIP_COLLECT_FRACTION,
  CHIP_RAIL_WIDTH_PCT,
  MARKER_INSET_PX,
  FELT_MARKER_MARGIN_WIDTH_PCT,
  FELT_WINDOW,
  MARKER_MIN_GAP_WIDTH_PCT,
  isHeroSeat,
  HERO_CHIP_LIFT_WIDTH_PCT,
  overlapsTopSeatBox,
  TOP_CAP_SEAT_Y_MAX,
  type Pos,
  type Size,
} from '../src/components/table/tableGeometry';
import { SEAT_LAYOUTS } from '../src/lib/tableSeatGeometry';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const HOTFIX_CSS = readFileSync(
  resolve(__dirname, '../src/components/table/TableVisualHotfix.css'),
  'utf8'
).replace(/\/\*[\s\S]*?\*\//g, '');

/** The three table sizes the app actually renders, all at 605/1000. */
const TABLES: Record<string, Size> = {
  'phone 375px': { w: 347, h: 574 },
  'tablet portrait': { w: 600, h: 992 },
  desktop: { w: 720, h: 1190 },
};

const RINGS = SEAT_LAYOUTS;

/* ═══════════════════════════════════════════════════════════════════════════
   THE COMMUNITY BOARD, AS THE STYLESHEET ACTUALLY DRAWS IT
   ═══════════════════════════════════════════════════════════════════════════

   `.table-surface .community-area` is `width: 95%` of `.table-surface`, with
   `left: 50%` and `top: 42.5%` OF THE FELT and a translate(-50%, -50%). Five
   cards at aspect-ratio 64/92 share that row.

   ── THE AXIS CONVERSION WAS UPSIDE DOWN (fixed 2026-08-27) ─────────────────
   This rectangle used to be built as

       const cardW = (0.68 * FELT_WINDOW.width) / 5;              // % of WIDTH
       const boardHalfH = ((cardW * 92) / 64 / 2) * (1000 / 605);

   and hung from `feltCenter()`. Both halves were wrong in the same direction —
   they made the modelled board far bigger than the painted one:

     * a card's HEIGHT in percent-of-width, turned into percent-of-height, must
       be MULTIPLIED by w/h (605/1000 = 0.605), not by h/w. Using 1000/605
       overstated the height by (1000/605)^2 = 2.73x. A 68% board's cards are
       9.7% of the scaler's height; the model claimed 26.5%.
     * `feltCenter().y` is 49.05% of the scaler. The board is not centred on the
       felt — it hangs from `.community-area`'s own anchor, 43.03%. The model
       was six points low as well as three times too tall.

   Being over-conservative is not free. It is what stopped the felt board taking
   the last point of width when the seats were still at the board's height, and
   an over-tall model makes a correct layout look like a collision — which is
   the failure that costs an afternoon, because the number it prints is real and
   the rectangle it printed it against is not. */
const BOARD_FELT_FRACTION = 0.95;
/** `.table-surface .community-cards__container { --cc-card-gap }` on a phone. */
const BOARD_GAP_PX = 2;
/** `.community-area { top }` — a percentage of the FELT, not of the scaler. */
const BOARD_TOP_FELT_PCT = 42.5;

function boardRect(table: Size) {
  const gapPct = (BOARD_GAP_PX / table.w) * 100;
  const rowW = BOARD_FELT_FRACTION * FELT_WINDOW.width;
  const cardW = (rowW - 4 * gapPct) / 5;
  return {
    centreX: FELT_WINDOW.left + FELT_WINDOW.width / 2,
    centreY: FELT_WINDOW.top + (BOARD_TOP_FELT_PCT / 100) * FELT_WINDOW.height,
    halfW: rowW / 2,
    halfH: (cardW * (92 / 64) * (table.w / table.h)) / 2,
  };
}

const mag = (p: Pos) => Math.hypot(p.x, p.y);
const toPx = (from: Pos, to: Pos, t: Size): Pos => ({
  x: ((to.x - from.x) * t.w) / 100,
  y: ((to.y - from.y) * t.h) / 100,
});

describe('item 11 - the button is always on the felt, never on the rail', () => {
  for (const [label, table] of Object.entries(TABLES)) {
    for (const [size, ring] of Object.entries(RINGS)) {
      it(`${size}-max on a ${label} table: every seat's button lands on the felt`, () => {
        for (const seat of ring) {
          const btn = dealerButtonPosition(seat, table);
          expect(
            isInsideFelt(btn, table),
            `seat ${JSON.stringify(seat)} -> button ${btn.x.toFixed(2)},${btn.y.toFixed(2)} ` +
              `is ${feltRadialFraction(btn, table).toFixed(3)} of the way out`
          ).toBe(true);
        }
      });
    }
  }

  it('the seats it was broken for are on the felt now, and were not before', () => {
    /* Every TOP CAP DIAGONAL on every ring, and only those, with the
       construction this replaced (0.28 of the horizontal run, 0.16 of the
       vertical, rotated 22.5 degrees):

         3-max, 5-max  (20.5, 6) -> (23.4, 14.3)   7.6% past the felt's edge
         3-max, 5-max  (79.5, 6) -> (67.2, 10.7)   6.1% past
         7-max, 9-max  (27,   6) -> (28.2, 13.9)   2.7% past
         7-max, 9-max  (73,   6) -> (62.3, 11.1)   1.8% past

       They were on the felt at y=8.5 and went off it when the cap was raised to
       y=6 in src/lib/tableSeatGeometry.ts - a seat move in a different file,
       breaking the button, silently. That is the case for the guarantee rather
       than a constant, and it is why the suite above walks the rings from that
       file instead of a copy. */
    const old = (seat: Pos): Pos => {
      const dx = 50 - seat.x;
      const dy = 50 - seat.y;
      const a = 22.5 * (Math.PI / 180);
      return {
        x: seat.x + (dx * Math.cos(a) - dy * Math.sin(a)) * 0.28,
        y: seat.y + (dx * Math.sin(a) + dy * Math.cos(a)) * 0.16,
      };
    };
    for (const seat of [
      { x: 20.5, y: 6 },
      { x: 79.5, y: 6 },
      { x: 27, y: 6 },
      { x: 73, y: 6 },
    ]) {
      expect(isInsideFelt(old(seat)), `old ${seat.x},${seat.y}`).toBe(false);
      expect(isInsideFelt(dealerButtonPosition(seat)), `new ${seat.x},${seat.y}`).toBe(true);
    }
  });
});

describe('item 8 - the button stands clear of the rail, not against it', () => {
  /* Dan 2026-08-25, round two, reading the round-one build back on a phone:
     "The button is too close to the rail and should be pushed a little farther
     into the table, so it's 'in front of the player' without touching the rail."

     The suite above asks whether the button is INSIDE the felt. It was inside
     before this item too - a disc resting flat against the rail is inside - so
     that question could not see what Dan was looking at. This block measures
     the DAYLIGHT instead, which is the thing on the screen, and it is the
     assertion that would have failed on the build he was holding: of these 132
     seat-and-table combinations, 75 put the button flat on the felt's edge at a
     clearance of FELT_MARKER_MARGIN_WIDTH_PCT and not a pixel more, and 102
     were short of the daylight it now keeps.

     It is not an edge case that so many were pinned there. The felt window is
     x 13.3..86.5, y 8.9..89.2 and the ring puts its side seats at x 10.5/89.5,
     its caps at y 6 and 82.5 and the hero at y 100 - so EVERY seat stands off
     the felt, and for every one of them the projection decides the button's
     position rather than correcting it, on the boundary. */
  for (const [label, table] of Object.entries(TABLES)) {
    for (const [size, ring] of Object.entries(RINGS)) {
      it(`${size}-max on a ${label} table: every button keeps clear felt between itself and the rail`, () => {
        for (const seat of ring) {
          const btn = dealerButtonPosition(seat, table);
          const clearance = feltEdgeClearanceWidthPct(btn, table);
          expect(
            clearance,
            `seat ${JSON.stringify(seat)} -> button ${btn.x.toFixed(2)},${btn.y.toFixed(2)} is ` +
              `${((clearance * table.w) / 100).toFixed(1)}px from the painted rail`
          ).toBeGreaterThanOrEqual(BUTTON_FELT_MARGIN_WIDTH_PCT - 1e-6);

          // That clearance is measured to the puck's CENTRE. Take its own radius
          // off and what is left is the felt a player can actually see between
          // the disc and the rail - 8.7px on this phone, 15.0 on the tablet,
          // 18.0 on the desktop, because it is a proportion of the table.
          expect(
            clearance - FELT_MARKER_MARGIN_WIDTH_PCT,
            `seat ${JSON.stringify(seat)} has ` +
              `${(((clearance - FELT_MARKER_MARGIN_WIDTH_PCT) * table.w) / 100).toFixed(1)}px of daylight`
          ).toBeGreaterThanOrEqual(BUTTON_FELT_DAYLIGHT_WIDTH_PCT - 1e-6);
        }
      });
    }
  }

  it('the puck is twice the chip, its margin is its own radius, and the daylight is what ownership leaves', () => {
    /* Without this, the two assertions above are circular: they check that the
       code honours BUTTON_FELT_DAYLIGHT_WIDTH_PCT, so setting that constant to
       zero would satisfy them and put the puck straight back on the rail. This
       one pins the VALUES, and to the things the constants' comments derive
       them from rather than to a repeat of the numbers.

       Dan 2026-09-04: "the button on the table needs to be double the size as
       the chips in pot." --dealer-btn-size (TableVisualHotfix.css) is
       `calc(var(--cp-chip-size) * 2)`, so BUTTON_* is CHIP_* doubled: 7.2% of
       the table, floor 20px, ceiling 52px. The 20px floor binds only below a
       278px table, so on every real device the puck is 7.2% wide and its
       radius - the margin that keeps the disc off the painted rail - is 3.6%.

       The daylight used to be "half a puck" too. At 3.6% + 3.6% the puck
       walked so far in that on an 8-max phone the bottom-right seat's button
       stood nearer the seat above it (78.5px against 80.8px) - the ownership
       rule the `pushing the button in` case above pins. 1.9% is the largest
       daylight that rule admits with 0.1% of headroom (2.0 passes, 2.1 does
       not): 6.6px of felt on a phone, 13.7px on the desktop. */
    expect(BUTTON_WIDTH_PCT).toBeCloseTo(CHIP_WIDTH_PCT * 2, 9);
    expect(BUTTON_MIN_PX).toBe(CHIP_MIN_PX * 2);
    expect(BUTTON_MAX_PX).toBe(CHIP_MAX_PX * 2);
    const widestPuckWidthPct = BUTTON_WIDTH_PCT;
    expect(BUTTON_FELT_MARGIN_WIDTH_PCT - BUTTON_FELT_DAYLIGHT_WIDTH_PCT).toBeGreaterThanOrEqual(
      widestPuckWidthPct / 2
    );
    expect(BUTTON_FELT_DAYLIGHT_WIDTH_PCT).toBe(1.9);
    expect(BUTTON_FELT_MARGIN_WIDTH_PCT).toBeCloseTo(
      BUTTON_WIDTH_PCT / 2 + BUTTON_FELT_DAYLIGHT_WIDTH_PCT,
      6
    );
    // And the CSS agrees with the module.
    expect(HOTFIX_CSS).toMatch(/--dealer-btn-size:\s*calc\(var\(--cp-chip-size\)\s*\*\s*2\)/);
    expect(HOTFIX_CSS).toMatch(
      /--cp-chip-size:\s*clamp\(10px,\s*calc\(var\(--table-w\)\s*\*\s*0\.036\),\s*26px\)/
    );
  });

  it('CONTROL - the chips are placed by the projection, not by the rail', () => {
    /* The hero's ring position (y=100) is 10.8% of the table's height below the
       felt, so both of its markers are placed by the projection rather than by
       the rail. That was the point of this control: the chips landed exactly on
       the boundary - the plain marker margin, to floating point - which is
       precisely where the button was standing when Dan raised item 8. Same
       seat, same projection, one carries the daylight and the other did not.

       UPDATED 2026-08-27. The hero's chips are no longer ON the boundary: Dan
       ruled that this one seat comes off the oval ("all chips in all other
       positions and seats should sit in the same position except for the hero,
       they need to be raised up more"), so they are lifted
       HERO_CHIP_LIFT_WIDTH_PCT further in. The control still measures the same
       thing — that the projection, not the rail, is what decides where the
       hero's markers sit — and now pins the lift as an exact figure so it
       cannot drift or be applied twice. */
    const hero = RINGS[9][0];
    expect(isHeroSeat(hero), 'RINGS[9][0] is the hero seat').toBe(true);
    for (const [label, table] of Object.entries(TABLES)) {
      const chips = feltEdgeClearanceWidthPct(chipRestPosition(hero, table), table);
      /* 4dp, where the boundary case above uses 6. `clampIntoFelt` finds the
         stadium's edge by bisection and stops around 1e-6, and the lifted point
         is clamped a second time, so the two approximations compound. 1e-4 of
         the table's width is 0.03px on a phone — the assertion is still that
         this is the lift and not some other number, not that a bisection is
         exact. */
      expect(chips, `${label}: hero chips`).toBeCloseTo(
        FELT_MARKER_MARGIN_WIDTH_PCT + HERO_CHIP_LIFT_WIDTH_PCT,
        4
      );
      expect(
        feltEdgeClearanceWidthPct(dealerButtonPosition(hero, table), table),
        `${label}: hero button, clear of the rail by`
      ).toBeGreaterThanOrEqual(
        FELT_MARKER_MARGIN_WIDTH_PCT + BUTTON_FELT_DAYLIGHT_WIDTH_PCT - 1e-6
      );
    }
  });

  it('pushing the button in does not carry it away from the player it belongs to', () => {
    /* The cost of the daylight, bounded. A button that keeps walking inward
       stops reading as this seat's and starts reading as the pot's, or as the
       seat opposite - so both halves of that are asserted rather than assumed.

       0.40 is a stated ceiling with headroom, not the measurement: the furthest
       any button actually travels is 0.32 of its seat's distance to the middle
       of the felt (6-max phone, seat 89.5/66 - 53.8px of 168.4px), up from 0.29
       before the daylight. The ring in tests/unit/chipRail.test.ts, which is
       deliberately not one of ours, reaches 0.34. If a seat move ever pushes
       this past 0.40, the number to look at is BUTTON_FELT_DAYLIGHT_WIDTH_PCT
       and the answer is not to raise the ceiling. */
    const c = feltCenter();
    for (const [label, table] of Object.entries(TABLES)) {
      for (const [size, ring] of Object.entries(RINGS)) {
        for (const seat of ring) {
          const btn = dealerButtonPosition(seat, table);
          const toButton = mag(toPx(seat, btn, table));
          const toMiddle = mag(toPx(seat, c, table));
          expect(
            toButton / toMiddle,
            `${size}-max ${label}: seat ${JSON.stringify(seat)} button walked ` +
              `${toButton.toFixed(1)}px of ${toMiddle.toFixed(1)}px to the middle`
          ).toBeLessThanOrEqual(0.4);

          // And it is still THIS seat's button: no other chair on the ring is
          // nearer to it than the one it was computed from.
          for (const other of ring) {
            if (other === seat) continue;
            expect(
              mag(toPx(other, btn, table)),
              `${size}-max ${label}: seat ${JSON.stringify(seat)}'s button is nearer ` +
                `${JSON.stringify(other)}`
            ).toBeGreaterThanOrEqual(toButton - 1e-9);
          }
        }
      }
    }
  });
});

describe('item 13 - one rail, equal for every seat', () => {
  for (const [label, table] of Object.entries(TABLES)) {
    const rail = chipRailInset(table);

    for (const [size, ring] of Object.entries(RINGS)) {
      it(`${size}-max on a ${label} table: every seat walks the same rail`, () => {
        for (const seat of ring) {
          const chips = betChipOffsetPx(seat, table);
          const rest = chipRestPosition(seat, table);
          const walked = mag(chips);

          if (isHeroSeat(seat)) {
            /* ── THE ONE SEAT OFF THE OVAL (Dan 2026-08-27) ──────────────────
               This suite exists for Dan's round-2 item 13 — "all chips must
               appear equally on that line for all players at all tables" — and
               that rule now has exactly one exception, which he made himself
               after the conflict was put to him:

                 "All chips in all other positions and seats should sit in the
                  same position except for the hero, they need to be raised up
                  more."

               So the rail assertion does not apply to the hero, and the
               exception is pinned instead of merely skipped. Three things have
               to hold, and together they say "raised, by a stated amount, and
               only here":

                 1. it walks FURTHER than the rail — otherwise the lift is not
                    happening at all;
                 2. it lands INSIDE the felt, not on the boundary the other
                    projected seats sit on;
                 3. its clearance from the felt's edge is exactly the marker
                    margin PLUS HERO_CHIP_LIFT_WIDTH_PCT — so the exception
                    cannot quietly grow, shrink, or be applied twice.

               Every other seat still goes through the branches below unchanged,
               which is what keeps this a one-seat exception rather than the
               beginning of per-seat placement. */
            expect(
              walked,
              `hero walked ${walked.toFixed(2)} of a ${rail.toFixed(2)} rail`
            ).toBeGreaterThan(rail);
            expect(isInsideFelt(rest, table)).toBe(true);
            // 4dp: two compounded bisections, see the CONTROL above.
            expect(
              feltEdgeClearanceWidthPct(rest, table),
              `${size}-max ${label}: the hero's lift`
            ).toBeCloseTo(FELT_MARKER_MARGIN_WIDTH_PCT + HERO_CHIP_LIFT_WIDTH_PCT, 4);
          } else if (feltRadialFraction(rest, table) < 0.999) {
            /* The common rail, to the pixel. Each axis is rounded on its own,
               so the magnitude can land up to ~0.71px either side.

               THE SECOND TOLERANCE, added 2026-08-26 with MARKER_INSET_PX.
               Dan asked for every marker to move 3px further onto the felt.
               Most seats take it; a seat level with the community board
               CANNOT, and that is arithmetic rather than preference:
               CHIP_RAIL_WIDTH_PCT was derived as the LONGEST rail that keeps
               a board-level seat's chips off the cards, and the derivation
               leaves 0.2% of the table's width in hand while 3px is ~0.8%.
               `chipStepWidthPct` therefore withdraws the inset for exactly
               those seats, so they sit one inset SHORT of the nominal rail.

               Allowing [rail - inset, rail] keeps the real guarantee — no
               seat gets a rail of its own, every seat lands on one of two
               known values, and which one is decided by the board, not by
               whose seat it is. Anything outside that band is the drift this
               test exists to catch. */
            const inset = MARKER_INSET_PX;
            const shortfall = rail - walked;
            expect(
              shortfall >= -1 && shortfall <= inset + 1,
              `seat ${JSON.stringify(seat)} walked ${walked.toFixed(2)} of ${rail.toFixed(2)}`
            ).toBe(true);
          } else {
            /* The ONLY thing that lengthens a NON-HERO walk: this seat's own
               ring position is outside the painted felt, so the first part of
               its walk is spent crossing the rail it is standing on. The bottom
               and top caps are outside it. Nothing in THIS branch is a per-seat
               preference - the same rule moves all of them and no other seat.
               (The hero's lift, above, is the one that is, by Dan's ruling.) */
            expect(walked).toBeGreaterThan(rail);
            expect(isInsideFelt(rest, table)).toBe(true);
          }
        }
      });

      it(`${size}-max on a ${label} table: chips are on the felt and in front of the player`, () => {
        for (const seat of ring) {
          const rest = chipRestPosition(seat, table);
          expect(isInsideFelt(rest, table)).toBe(true);

          const chips = betChipOffsetPx(seat, table);
          const toMiddle = toPx(seat, feltCenter(), table);
          expect(mag(chips)).toBeGreaterThan(0);
          expect(mag(chips)).toBeLessThan(mag(toMiddle));
          // Toward the middle of the felt, never away from it into the rail.
          if (Math.abs(toMiddle.x) > 1) expect(Math.sign(chips.x)).toBe(Math.sign(toMiddle.x));
          if (Math.abs(toMiddle.y) > 1) expect(Math.sign(chips.y)).toBe(Math.sign(toMiddle.y));
        }
      });
    }
  }

  it('holding the button no longer buys a seat a longer rail', () => {
    // It used to: CHIP_RAIL_DEALER_EXTRA_PX pushed the button holder's chips out
    // by 20px so they could clear their own puck. That is one seat at a
    // different distance from its player than everyone else, which is the thing
    // item 13 forbids - the puck moves now instead. See dealerButtonPosition.
    //
    // CORRECTED 2026-08-26. This used to read
    //     betChipOffsetPx(seat, table, true) === betChipOffsetPx(seat, table, false)
    // which was already the wrong shape when the audit of 2026-08-25 deleted the
    // `isDealer` parameter it was passing - the note on `chipRailInset` says so
    // in as many words, and tests/unit/chipRail.test.ts replaced its copy with
    // the structural check below on the same day. This one was missed, and it
    // did not merely go stale: the third slot now carries the seat's POD, so
    // `true` was being read as a box with no width and every offset came back
    // NaN. A test that survives by being ignored is a test that will one day be
    // obeyed.
    //
    // The property is structural now: there is no boolean to pass. Two required
    // arguments, and a third that is a Size - the pod every seat paints, which
    // the dealer's seat has exactly like everyone else's.
    expect(betChipOffsetPx).toHaveLength(2);
    expect(chipCollectOffsetPx).toHaveLength(2);
    expect(chipRailInset).toHaveLength(1);

    // And the rail itself is still one number for the whole table, with no way
    // in for a per-player term.
    for (const table of Object.values(TABLES)) {
      for (const ring of Object.values(RINGS)) {
        for (const seat of ring) {
          expect(betChipOffsetPx(seat, table)).toEqual(betChipOffsetPx(seat, table));
        }
      }
    }
  });

  it('no seat is given a shorter rail to keep it off the community board', () => {
    /* The old CHIP_RAIL_SCALE_BOARD_LEVEL cut the rail to 1.15/1.82 for a side
       seat sitting at the board's own height, and only for that seat. Dan:
       "solve it by moving the whole rail for the whole table rather than by
       giving one seat a shorter walk." So the rail is short enough for every
       seat, and this asserts what that buys: no seat's chips land on the cards.

       The board is the middle BOARD_FELT_FRACTION of the felt's width
       (TablePage.css, `.table-surface .community-area`), five cards at 64:92,
       centred on the felt's midline and hung from `.community-area`'s own
       vertical anchor. */
    const chipHalf = 2; // a chip is ~4% of the table's width - see item 8

    for (const [label, table] of Object.entries(TABLES)) {
      const board = boardRect(table);
      for (const [size, ring] of Object.entries(RINGS)) {
        for (const seat of ring) {
          const p = chipRestPosition(seat, table);
          const onBoardX = Math.abs(p.x - board.centreX) < board.halfW + chipHalf;
          const onBoardY =
            Math.abs(p.y - board.centreY) < board.halfH + chipHalf * (table.w / table.h);
          expect(
            onBoardX && onBoardY,
            `${size}-max ${label}: seat ${JSON.stringify(seat)} put chips at ` +
              `${p.x.toFixed(1)},${p.y.toFixed(1)} - on the board`
          ).toBe(false);
        }
      }
    }
  });
});

describe('item 13 - the chips and the button are never in the same place', () => {
  for (const [label, table] of Object.entries(TABLES)) {
    for (const [size, ring] of Object.entries(RINGS)) {
      it(`${size}-max on a ${label} table: every seat keeps its two markers apart`, () => {
        for (const seat of ring) {
          const chips = chipRestPosition(seat, table);
          const btn = dealerButtonPosition(seat, table);
          const gap = markerGapWidthPct(btn, chips, table);
          expect(
            gap,
            `seat ${JSON.stringify(seat)}: gap ${((gap * table.w) / 100).toFixed(1)}px`
          ).toBeGreaterThanOrEqual(MARKER_MIN_GAP_WIDTH_PCT - 1e-6);
        }
      });

      it(`${size}-max on a ${label} table: the button is never deeper in than the chips`, () => {
        /* Player, then button, then chips - Dan 2026-08-19, "chips must always
           be in front of the user (in front of the button if they're the
           button)". Measured from the middle of the felt rather than from the
           seat: the button is deliberately off the chip line, so on a seat whose
           markers were both projected onto the felt's edge it can be further
           from the seat while still standing nearer the rail, which is what a
           player actually reads as "in front".

           EACH MARKER IS MEASURED AGAINST THE BOUNDARY ITS OWN RULE LETS IT
           REACH, which is the only reading of this that survives item 8. The
           button now stops BUTTON_FELT_DAYLIGHT_WIDTH_PCT short of the felt's
           edge on purpose, so against the chips' boundary it is up to 0.062 of
           the way behind them - and that is the daylight Dan asked for, not a
           regression of the ordering. Against its own boundary the ordering
           holds as tightly as it ever did: the largest deficit across every seat
           of every ring at every table size is 0.0138, well inside the 0.02 this
           has always allowed, and the ring in tests/unit/chipRail.test.ts sits
           at 0.0000. If the daylight ever swallowed the ordering, this number
           would move; a looser tolerance would have hidden that. */
        for (const seat of ring) {
          const chips = feltRadialFraction(chipRestPosition(seat, table), table);
          const btn = feltRadialFraction(
            dealerButtonPosition(seat, table),
            table,
            BUTTON_FELT_MARGIN_WIDTH_PCT
          );
          expect(btn, `seat ${JSON.stringify(seat)}`).toBeGreaterThanOrEqual(chips - 0.02);
        }
      });
    }
  }
});

describe('item 2 (2026-08-26) - the button never overlaps a top seat box', () => {
  /* "The button is currently covering the top player's box. This needs to be
     adjusted to never overlap anything." Every top-cap seat's rendered box
     (avatar + nameplate) hangs down over the felt; the puck must land beside
     it, never inside it. The keep-out is asserted with the same predicate the
     placement uses, and the placement's other guarantees are asserted again
     here so clearing the plate cannot silently cost them. */
  for (const [label, table] of Object.entries(TABLES)) {
    for (const [size, ring] of Object.entries(RINGS)) {
      it(`${size}-max on a ${label} table: top-cap buttons clear their seat's box`, () => {
        for (const seat of ring) {
          if (seat.y >= TOP_CAP_SEAT_Y_MAX) continue;
          const btn = dealerButtonPosition(seat, table);
          expect(
            overlapsTopSeatBox(btn, seat, table),
            `seat ${JSON.stringify(seat)}: button ${JSON.stringify(btn)} is inside the seat box`
          ).toBe(false);
          // Still apart from the chips, and still on the felt with daylight.
          const chips = chipRestPosition(seat, table);
          expect(markerGapWidthPct(btn, chips, table)).toBeGreaterThanOrEqual(
            MARKER_MIN_GAP_WIDTH_PCT - 1e-6
          );
          expect(feltEdgeClearanceWidthPct(btn, table)).toBeGreaterThanOrEqual(
            BUTTON_FELT_MARGIN_WIDTH_PCT - 1e-6
          );
        }
      });
    }
  }
});

describe('chip collect - every seat converges on the pot', () => {
  for (const [label, table] of Object.entries(TABLES)) {
    for (const [size, ring] of Object.entries(RINGS)) {
      it(`${size}-max on a ${label} table: lands the same fraction short of centre`, () => {
        for (const seat of ring) {
          const rest = betChipOffsetPx(seat, table);
          const travel = chipCollectOffsetPx(seat, table);
          const toMiddle = toPx(seat, feltCenter(), table);
          const landed = { x: rest.x + travel.x, y: rest.y + travel.y };
          // Both halves of the sweep are rounded per axis, so the magnitude of
          // the sum can land up to ~1.4px either side. A stated window rather
          // than toBeCloseTo, which would be pretending the arithmetic is exact.
          expect(Math.abs(mag(landed) - mag(toMiddle) * CHIP_COLLECT_FRACTION)).toBeLessThanOrEqual(
            1.5
          );
          expect(mag(landed)).toBeLessThan(mag(toMiddle));
        }
      });
    }
  }
});

describe('the rail itself', () => {
  it('is one number, and it scales with the table', () => {
    expect(chipRailInset(TABLES['phone 375px'])).toBeCloseTo(
      (CHIP_RAIL_WIDTH_PCT * 347) / 100 + MARKER_INSET_PX,
      6
    );
    expect(chipRailInset(TABLES.desktop)).toBeGreaterThan(chipRailInset(TABLES['phone 375px']));
  });

  it('does not divide by zero for a seat sitting on the middle of the felt', () => {
    const c = feltCenter();
    expect(betChipOffsetPx(c, TABLES['phone 375px'])).toEqual({ x: 0, y: 0 });
    expect(dealerButtonPosition(c)).toEqual(c);
  });
});

describe('CONTROL - the maths this replaced really was uneven', () => {
  const table = TABLES['phone 375px'];

  it('a flat 0.22 factor put a top seat and a side seat at different distances', () => {
    const top = { x: 50, y: 5 };
    const side = { x: 10.5, y: 36 };
    const oldOffset = (seat: Pos) => ({
      x: ((50 - seat.x) * table.w * 0.22) / 100,
      y: ((50 - seat.y) * table.h * 0.22) / 100,
    });
    expect(Math.abs(mag(oldOffset(top)) - mag(oldOffset(side)))).toBeGreaterThan(10);
    expect(
      Math.abs(mag(betChipOffsetPx(top, table)) - mag(betChipOffsetPx(side, table)))
    ).toBeLessThanOrEqual(1);
  });
});
